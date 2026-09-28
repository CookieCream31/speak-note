import asyncio
import json
from typing import Any, Never

import httpx
from pydantic import ValidationError

from app.services.llm.base import LLMProviderError, StructuredOutput
from app.services.llm.ollama import (
    _repair_evidence_segment_ids,
    _restrict_evidence_segment_ids,
)

GEMINI_API_ROOT = "https://generativelanguage.googleapis.com/v1beta"

_TRANSIENT_STATUS_CODES = frozenset({429, 500, 502, 503, 504})

_GEMINI_STRING_FORMATS = frozenset({"date-time", "date", "time"})

_GEMINI_IGNORED_SCHEMA_KEYS = frozenset(
    {
        "const",
        "default",
        "examples",
        "exclusiveMaximum",
        "exclusiveMinimum",
        "maxLength",
        "minLength",
        "multipleOf",
        "pattern",
        "uniqueItems",
    }
)


def _gemini_compatible_schema(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            key: _gemini_compatible_schema(item)
            for key, item in value.items()
            if key not in _GEMINI_IGNORED_SCHEMA_KEYS
            and (key != "format" or item in _GEMINI_STRING_FORMATS)
        }
    if isinstance(value, list):
        return [_gemini_compatible_schema(item) for item in value]
    return value


def _gemini_http_error(response: httpx.Response, secret: str) -> str:
    detail = ""
    try:
        payload = response.json()
    except ValueError:
        payload = None
    if isinstance(payload, dict):
        error = payload.get("error")
        if isinstance(error, dict):
            message = error.get("message")
            if isinstance(message, str):
                detail = " ".join(message.split())
            violations: list[str] = []
            details = error.get("details")
            if isinstance(details, list):
                for item in details:
                    if not isinstance(item, dict):
                        continue
                    field_violations = item.get("fieldViolations")
                    if not isinstance(field_violations, list):
                        continue
                    for violation in field_violations:
                        if not isinstance(violation, dict):
                            continue
                        field = violation.get("field")
                        description = violation.get("description")
                        if isinstance(field, str) and isinstance(description, str):
                            violations.append(f"{field}: {description}")
            if violations:
                detail = f"{detail} ({'; '.join(violations)})"
            detail = detail[:500]
            if secret:
                detail = detail.replace(secret, "***")
    suffix = f": {detail}" if detail else ""
    return f"Gemini APIがHTTP {response.status_code}を返しました{suffix}"


def _json_mode_payload(payload: dict[str, Any], response_schema: dict[str, Any]) -> dict[str, Any]:
    generation_config = dict(payload["generationConfig"])
    generation_config.pop("responseJsonSchema", None)

    contents = list(payload["contents"])
    original_part = contents[-1]["parts"][0]
    original_prompt = original_part["text"]
    schema_text = json.dumps(response_schema, ensure_ascii=False, separators=(",", ":"))
    fallback_prompt = (
        f"{original_prompt}\n\n"
        "以下のJSON Schemaに一致するJSONオブジェクトだけを返してください。"
        "Markdownや説明文は付けないでください。\n"
        f"JSON Schema:\n{schema_text}"
    )
    contents[-1] = {"role": "user", "parts": [{"text": fallback_prompt}]}

    return {
        **payload,
        "contents": contents,
        "generationConfig": generation_config,
    }


def _schema_retry_payload(
    payload: dict[str, Any],
    response_schema: dict[str, Any],
) -> dict[str, Any]:
    retry_payload = _json_mode_payload(payload, response_schema)
    retry_payload["generationConfig"] = {
        **retry_payload["generationConfig"],
        "temperature": 0,
    }
    contents = list(retry_payload["contents"])
    original_part = contents[-1]["parts"][0]
    contents[-1] = {
        "role": "user",
        "parts": [{
            "text": (
                f"{original_part['text']}\n\n"
                "前回の回答はJSON Schemaと一致しませんでした。"
                "Evidence IDはSchemaのenumにある文字列を一字も変更せずコピーしてください。"
            )
        }],
    }
    retry_payload["contents"] = contents
    return retry_payload


def _gemini_response_content(response: httpx.Response) -> str:
    try:
        response_payload = response.json()
    except ValueError as exc:
        raise LLMProviderError("Gemini APIの応答を読み取れませんでした") from exc

    if not isinstance(response_payload, dict):
        raise LLMProviderError("Gemini APIの応答形式を読み取れませんでした")
    candidates = response_payload.get("candidates", [])
    if not isinstance(candidates, list) or not candidates:
        feedback = response_payload.get("promptFeedback", {})
        reason = feedback.get("blockReason") if isinstance(feedback, dict) else None
        suffix = f": {reason}" if isinstance(reason, str) and reason else ""
        raise LLMProviderError(f"Geminiが回答を生成しませんでした{suffix}")
    candidate = candidates[0]
    if not isinstance(candidate, dict):
        raise LLMProviderError("Gemini APIの応答形式を読み取れませんでした")
    finish_reason = candidate.get("finishReason")
    if finish_reason == "MAX_TOKENS":
        raise LLMProviderError("Geminiの出力が上限に達しました")
    if isinstance(finish_reason, str) and finish_reason not in {
        "STOP",
        "FINISH_REASON_UNSPECIFIED",
    }:
        raise LLMProviderError(f"Geminiの生成が停止しました: {finish_reason}")
    content_value = candidate.get("content")
    if not isinstance(content_value, dict):
        raise LLMProviderError("Gemini APIの応答形式を読み取れませんでした")
    parts = content_value.get("parts")
    if not isinstance(parts, list):
        raise LLMProviderError("Gemini APIの応答形式を読み取れませんでした")
    content = "".join(part.get("text", "") for part in parts if isinstance(part, dict))
    if not content.strip():
        raise LLMProviderError("Geminiが空の回答を返しました")
    return content


def _validate_gemini_content(
    content: str,
    prompt: str,
    schema: type[StructuredOutput],
) -> StructuredOutput:
    parsed = json.loads(content)
    repaired = _repair_evidence_segment_ids(parsed, prompt)
    return schema.model_validate(repaired)


def _raise_gemini_validation_error(exc: ValidationError) -> Never:
    error = exc.errors(include_input=False, include_url=False)[0]
    location = ".".join(str(part) for part in error["loc"])
    raise LLMProviderError(
        "Geminiの応答が議事録形式と一致しませんでした: "
        f"{location or 'response'} ({error['msg']})"
    ) from exc


class GeminiProvider:
    def __init__(
        self,
        api_key: str,
        model: str | None = None,
        temperature: float = 0.2,
        *,
        timeout_seconds: float = 30.0,
        max_attempts: int = 5,
        retry_delay_seconds: float = 2.0,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self._api_key = api_key
        self.model = model
        self.temperature = temperature
        self._client = client
        self._timeout_seconds = timeout_seconds
        self._max_attempts = max(1, max_attempts)
        self._retry_delay_seconds = max(0.0, retry_delay_seconds)

    async def _post_with_retry(
        self,
        client: httpx.AsyncClient,
        payload: dict[str, Any],
    ) -> httpx.Response:
        response: httpx.Response | None = None
        last_error: httpx.TransportError | None = None
        for attempt in range(self._max_attempts):
            try:
                response = await client.post(
                    f"{GEMINI_API_ROOT}/models/{self.model}:generateContent",
                    headers=self._headers,
                    json=payload,
                )
                last_error = None
                if response.status_code not in _TRANSIENT_STATUS_CODES:
                    return response
            except httpx.TransportError as exc:
                last_error = exc

            if attempt + 1 < self._max_attempts:
                await asyncio.sleep(self._retry_delay_seconds * (2**attempt))

        if response is not None:
            return response
        assert last_error is not None
        raise last_error

    async def list_models(self) -> list[str]:
        async with self._client_context() as client:
            try:
                response = await client.get(
                    f"{GEMINI_API_ROOT}/models",
                    headers=self._headers,
                )
                response.raise_for_status()
                payload = response.json()
                return sorted(
                    item["name"].removeprefix("models/")
                    for item in payload.get("models", [])
                    if isinstance(item, dict) and isinstance(item.get("name"), str)
                )
            except (httpx.HTTPError, ValueError, TypeError) as exc:
                raise LLMProviderError("Gemini APIへ接続できませんでした") from exc

    async def test_connection(self) -> None:
        await self.list_models()

    async def generate_structured(
        self,
        system_prompt: str,
        prompt: str,
        schema: type[StructuredOutput],
    ) -> StructuredOutput:
        if not self.model:
            raise LLMProviderError("AI ProfileにGeminiモデルが設定されていません")
        response_schema = _gemini_compatible_schema(schema.model_json_schema())
        response_schema = _restrict_evidence_segment_ids(response_schema, prompt)
        payload = {
            "systemInstruction": {"parts": [{"text": system_prompt}]},
            "contents": [{"role": "user", "parts": [{"text": prompt}]}],
            "generationConfig": {
                "temperature": self.temperature,
                "responseMimeType": "application/json",
                "responseJsonSchema": response_schema,
            },
        }
        async with self._client_context() as client:
            try:
                response = await self._post_with_retry(client, payload)
                if response.status_code == 400:
                    response = await self._post_with_retry(
                        client,
                        _json_mode_payload(payload, response_schema),
                    )
                try:
                    response.raise_for_status()
                except httpx.HTTPStatusError as exc:
                    raise LLMProviderError(_gemini_http_error(response, self._api_key)) from exc
                content = _gemini_response_content(response)
                try:
                    return _validate_gemini_content(content, prompt, schema)
                except (json.JSONDecodeError, ValidationError):
                    response = await self._post_with_retry(
                        client,
                        _schema_retry_payload(payload, response_schema),
                    )
                    try:
                        response.raise_for_status()
                    except httpx.HTTPStatusError as exc:
                        raise LLMProviderError(
                            _gemini_http_error(response, self._api_key)
                        ) from exc
                    content = _gemini_response_content(response)
                try:
                    return _validate_gemini_content(content, prompt, schema)
                except ValidationError as exc:
                    _raise_gemini_validation_error(exc)
                except json.JSONDecodeError as exc:
                    raise LLMProviderError("Geminiの応答が正しいJSONではありませんでした") from exc
            except httpx.TimeoutException as exc:
                raise LLMProviderError("Geminiの応答がタイムアウトしました") from exc
            except httpx.HTTPError as exc:
                raise LLMProviderError("Gemini APIとの通信に失敗しました") from exc

    @property
    def _headers(self) -> dict[str, str]:
        return {"x-goog-api-key": self._api_key, "Content-Type": "application/json"}

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
