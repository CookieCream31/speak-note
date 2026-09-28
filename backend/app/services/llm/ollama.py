import json
import re
import uuid
from typing import Any

import httpx
from pydantic import ValidationError

from app.services.llm.base import LLMProviderError, StructuredOutput


class OllamaProvider:
    def __init__(
        self,
        base_url: str,
        model: str | None = None,
        temperature: float = 0.2,
        *,
        timeout_seconds: float = 30.0,
        num_ctx: int = 65536,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.temperature = temperature
        self.num_ctx = num_ctx
        self._client = client
        self._timeout_seconds = timeout_seconds

    async def list_models(self) -> list[str]:
        async with self._client_context() as client:
            try:
                response = await client.get(f"{self.base_url}/api/tags")
                response.raise_for_status()
                payload = response.json()
                return sorted(
                    item["name"]
                    for item in payload.get("models", [])
                    if isinstance(item, dict) and isinstance(item.get("name"), str)
                )
            except (httpx.HTTPError, ValueError, TypeError) as exc:
                raise LLMProviderError("Ollamaへ接続できませんでした") from exc

    async def test_connection(self) -> None:
        await self.list_models()

    async def generate_structured(
        self,
        system_prompt: str,
        prompt: str,
        schema: type[StructuredOutput],
    ) -> StructuredOutput:
        if not self.model:
            raise LLMProviderError("AI ProfileにOllamaモデルが設定されていません")
        format_schema = _ollama_compatible_schema(schema.model_json_schema())
        format_schema = _restrict_evidence_segment_ids(format_schema, prompt)
        payload = {
            "model": self.model,
            "stream": False,
            "format": format_schema,
            "options": {
                "temperature": self.temperature,
                "num_ctx": self.num_ctx,
            },
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": prompt},
            ],
        }
        async with self._client_context() as client:
            try:
                response, used_json_fallback = await _post_with_json_fallback(
                    client,
                    f"{self.base_url}/api/chat",
                    payload,
                )
                content = response.json()["message"]["content"]
                try:
                    return _validate_structured_content(content, prompt, schema)
                except (json.JSONDecodeError, ValidationError):
                    if used_json_fallback:
                        raise
                    response = await client.post(
                        f"{self.base_url}/api/chat",
                        json=_json_mode_payload(payload),
                    )
                    response.raise_for_status()
                    content = response.json()["message"]["content"]
                    return _validate_structured_content(content, prompt, schema)
            except httpx.HTTPStatusError as exc:
                if _is_grammar_error(exc.response):
                    raise LLMProviderError(
                        "OllamaがJSON出力を準備できませんでした。"
                        "Ollamaまたは選択モデルのStructured Output対応を確認してください"
                    ) from exc
                raise LLMProviderError(
                    f"Ollama APIがHTTP {exc.response.status_code}を返しました"
                ) from exc
            except httpx.TimeoutException as exc:
                raise LLMProviderError("Ollamaの応答がタイムアウトしました") from exc
            except httpx.HTTPError as exc:
                raise LLMProviderError("Ollamaとの通信に失敗しました") from exc
            except ValidationError as exc:
                error = exc.errors(include_input=False, include_url=False)[0]
                location = ".".join(str(part) for part in error["loc"])
                raise LLMProviderError(
                    f"Ollamaの応答が議事録形式と一致しませんでした: "
                    f"{location or 'response'} ({error['msg']})"
                ) from exc
            except (KeyError, TypeError) as exc:
                raise LLMProviderError("Ollamaの応答形式を読み取れませんでした") from exc
            except ValueError as exc:
                raise LLMProviderError("Ollamaの応答が正しいJSONではありませんでした") from exc

    def _client_context(self) -> "_AsyncClientContext":
        return _AsyncClientContext(self._client, self._timeout_seconds)


class _AsyncClientContext:
    def __init__(self, client: httpx.AsyncClient | None, timeout_seconds: float) -> None:
        self.client = client
        self.owned = client is None
        self.timeout_seconds = timeout_seconds

    async def __aenter__(self) -> httpx.AsyncClient:
        if self.client is None:
            self.client = httpx.AsyncClient(timeout=self.timeout_seconds)
        return self.client

    async def __aexit__(self, *_args: object) -> None:
        if self.owned and self.client is not None:
            await self.client.aclose()


_EVIDENCE_ALIAS_PATTERN = re.compile(
    r"\bevidence_id=([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?=\s|\])"
)
_UUID_PATTERN = re.compile(
    r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b"
)


def _restrict_evidence_segment_ids(
    schema: dict[str, Any],
    prompt: str,
) -> dict[str, Any]:
    allowed_ids = list(dict.fromkeys(_EVIDENCE_ALIAS_PATTERN.findall(prompt)))
    if not allowed_ids:
        return schema

    replaced = _replace_evidence_id_items(schema)
    if not replaced:
        return schema
    definitions = schema.setdefault("$defs", {})
    definitions["AllowedEvidenceSegmentId"] = {
        "type": "string",
        "enum": allowed_ids,
    }
    return schema


def _replace_evidence_id_items(value: Any) -> bool:
    replaced = False
    if isinstance(value, dict):
        for key, item in value.items():
            if key.endswith("evidence_segment_ids") and isinstance(item, dict):
                item["items"] = {"$ref": "#/$defs/AllowedEvidenceSegmentId"}
                replaced = True
            elif _replace_evidence_id_items(item):
                replaced = True
    elif isinstance(value, list):
        for item in value:
            if _replace_evidence_id_items(item):
                replaced = True
    return replaced


def _repair_evidence_segment_ids(value: Any, prompt: str) -> Any:
    aliases = _EVIDENCE_ALIAS_PATTERN.findall(prompt)
    known_values = aliases or _UUID_PATTERN.findall(prompt)
    known_ids = {item.lower(): item for item in known_values}
    if not known_ids:
        return value
    return _repair_evidence_value(value, known_ids)


def _repair_evidence_value(value: Any, known_ids: dict[str, str]) -> Any:
    if isinstance(value, dict):
        repaired: dict[str, Any] = {}
        for key, item in value.items():
            if key.endswith("evidence_segment_ids") and isinstance(item, list):
                repaired[key] = [
                    _repair_single_segment_id(segment_id, known_ids) for segment_id in item
                ]
            else:
                repaired[key] = _repair_evidence_value(item, known_ids)
        return repaired
    if isinstance(value, list):
        return [_repair_evidence_value(item, known_ids) for item in value]
    return value


def _repair_single_segment_id(value: Any, known_ids: dict[str, str]) -> Any:
    if isinstance(value, int) and not isinstance(value, bool):
        return _evidence_id_for_integer(value, known_ids) or value
    if not isinstance(value, str):
        return value
    normalized = value.strip().lower()
    if normalized in known_ids:
        return known_ids[normalized]

    short_alias = re.fullmatch(r"e(?:vidence)?[_ -]?0*(\d+)", normalized)
    if short_alias is not None:
        repaired = _evidence_id_for_integer(int(short_alias.group(1)), known_ids)
        if repaired is not None:
            return repaired

    uuidish = re.fullmatch(r"[0-9a-f{}\-\s]+", normalized) is not None
    compact = re.sub(r"[^0-9a-f]", "", normalized) if uuidish else ""
    compact_candidates = [
        original
        for candidate, original in known_ids.items()
        if compact and compact == candidate.replace("-", "")
    ]
    if len(compact_candidates) == 1:
        return compact_candidates[0]
    if compact:
        repaired = _evidence_id_for_integer(int(compact, 16), known_ids)
        if repaired is not None:
            return repaired

    candidates = [
        original
        for candidate, original in known_ids.items()
        if _is_single_edit_apart(normalized, candidate)
        or _is_single_edit_apart(compact, candidate.replace("-", ""))
    ]
    return candidates[0] if len(candidates) == 1 else value


def _evidence_id_for_integer(value: int, known_ids: dict[str, str]) -> str | None:
    if value < 0 or value >= 2**128:
        return None
    candidate = str(uuid.UUID(int=value))
    return known_ids.get(candidate)


def _is_single_edit_apart(left: str, right: str) -> bool:
    if abs(len(left) - len(right)) > 1:
        return False
    if len(left) == len(right):
        return sum(a != b for a, b in zip(left, right, strict=True)) == 1
    shorter, longer = (left, right) if len(left) < len(right) else (right, left)
    short_index = 0
    long_index = 0
    edits = 0
    while short_index < len(shorter) and long_index < len(longer):
        if shorter[short_index] == longer[long_index]:
            short_index += 1
            long_index += 1
            continue
        edits += 1
        long_index += 1
        if edits > 1:
            return False
    return True


_OLLAMA_IGNORED_SCHEMA_KEYS = frozenset(
    {
        "default",
        "description",
        "examples",
        "exclusiveMaximum",
        "exclusiveMinimum",
        "maxItems",
        "maxLength",
        "maximum",
        "minItems",
        "minLength",
        "minimum",
        "title",
    }
)


def _ollama_compatible_schema(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            key: _ollama_compatible_schema(item)
            for key, item in value.items()
            if key not in _OLLAMA_IGNORED_SCHEMA_KEYS
        }
    if isinstance(value, list):
        return [_ollama_compatible_schema(item) for item in value]
    return value


def _parse_json_content(content: str) -> Any:
    try:
        return json.loads(content)
    except json.JSONDecodeError as original_error:
        fenced = re.fullmatch(
            r"\s*```(?:json)?\s*(.*?)\s*```\s*",
            content,
            re.DOTALL | re.IGNORECASE,
        )
        if fenced is not None:
            try:
                return json.loads(fenced.group(1))
            except json.JSONDecodeError:
                pass

        starts = [index for index in (content.find("{"), content.find("[")) if index >= 0]
        if starts:
            try:
                parsed, _ = json.JSONDecoder().raw_decode(content[min(starts) :])
                return parsed
            except json.JSONDecodeError:
                pass
        raise original_error


def _validate_structured_content(
    content: str,
    prompt: str,
    schema: type[StructuredOutput],
) -> StructuredOutput:
    parsed = _parse_json_content(content)
    repaired = _repair_evidence_segment_ids(parsed, prompt)
    limited = _limit_evidence_segment_ids(repaired, prompt)
    return schema.model_validate(limited)


def _limit_evidence_segment_ids(value: Any, prompt: str) -> Any:
    known_ids = {item.lower() for item in _UUID_PATTERN.findall(prompt)}
    if not known_ids:
        return value
    return _limit_evidence_value(value, known_ids)


def _limit_evidence_value(value: Any, known_ids: set[str]) -> Any:
    if isinstance(value, dict):
        limited: dict[str, Any] = {}
        for key, item in value.items():
            if key.endswith("evidence_segment_ids") and isinstance(item, list):
                limit = 50 if key == "summary_evidence_segment_ids" else 20
                limited[key] = _limit_known_id_list(item, known_ids, limit)
            else:
                limited[key] = _limit_evidence_value(item, known_ids)
        return limited
    if isinstance(value, list):
        return [_limit_evidence_value(item, known_ids) for item in value]
    return value


def _limit_known_id_list(values: list[Any], known_ids: set[str], limit: int) -> list[Any]:
    if not all(isinstance(value, str) and value.lower() in known_ids for value in values):
        return values
    unique_values = list(dict.fromkeys(value.lower() for value in values))
    if len(unique_values) <= limit:
        return unique_values
    return [
        unique_values[index * (len(unique_values) - 1) // (limit - 1)] for index in range(limit)
    ]


def _json_mode_payload(payload: dict[str, Any]) -> dict[str, Any]:
    fallback_payload = dict(payload)
    fallback_payload["format"] = "json"
    fallback_payload["options"] = {**payload["options"], "temperature": 0}
    messages = [dict(message) for message in payload["messages"]]
    messages[-1]["content"] = (
        f"{messages[-1]['content']}\n\n"
        "次のJSON Schemaと同じキー・型のJSONオブジェクトだけを返してください。"
        "requiredに指定されたキーは必ず全て出力し、空の配列は[]で返してください。"
        "説明文やMarkdownは付けないでください。\n"
        f"{json.dumps(payload['format'], ensure_ascii=False, separators=(',', ':'))}"
    )
    fallback_payload["messages"] = messages
    return fallback_payload


async def _post_with_json_fallback(
    client: httpx.AsyncClient,
    url: str,
    payload: dict[str, Any],
) -> tuple[httpx.Response, bool]:
    response = await client.post(url, json=payload)
    used_json_fallback = False
    try:
        response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        if not _is_grammar_error(exc.response):
            raise
        response = await client.post(url, json=_json_mode_payload(payload))
        response.raise_for_status()
        used_json_fallback = True
    return response, used_json_fallback


def _is_grammar_error(response: httpx.Response) -> bool:
    try:
        detail = response.json().get("error", "")
    except (ValueError, AttributeError):
        return False
    return isinstance(detail, str) and "failed to parse grammar" in detail.lower()
