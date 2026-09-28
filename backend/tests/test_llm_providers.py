import asyncio
import json
import uuid

import httpx
import pytest
from pydantic import BaseModel, Field

from app.services.llm.base import LLMProviderError
from app.services.llm.gemini import (
    GeminiProvider,
    _gemini_compatible_schema,
)
from app.services.llm.gemini import (
    _json_mode_payload as _gemini_json_mode_payload,
)
from app.services.llm.ollama import (
    OllamaProvider,
    _limit_evidence_segment_ids,
    _ollama_compatible_schema,
    _parse_json_content,
    _repair_evidence_segment_ids,
    _restrict_evidence_segment_ids,
    _validate_structured_content,
)
from app.services.llm.ollama import (
    _json_mode_payload as _ollama_json_mode_payload,
)
from app.services.llm.secrets import SecretCipher, secret_mask


class ExampleOutput(BaseModel):
    summary: str


class ExampleEvidenceOutput(BaseModel):
    evidence_segment_ids: list[uuid.UUID] = Field(max_length=20)


class ExampleChaptersOutput(BaseModel):
    chapters: list[ExampleEvidenceOutput]


def test_gemini_schema_removes_unsupported_validation_keywords() -> None:
    source = {
        "type": "object",
        "properties": {
            "summary": {
                "type": "string",
                "minLength": 1,
                "maxLength": 500,
                "default": "",
            },
            "items": {"type": "array", "maxItems": 10, "items": {"type": "string"}},
            "evidence_id": {"type": "string", "format": "uuid"},
            "deadline": {"type": "string", "format": "date"},
        },
        "required": ["summary"],
    }

    assert _gemini_compatible_schema(source) == {
        "type": "object",
        "properties": {
            "summary": {"type": "string"},
            "items": {"type": "array", "maxItems": 10, "items": {"type": "string"}},
            "evidence_id": {"type": "string"},
            "deadline": {"type": "string", "format": "date"},
        },
        "required": ["summary"],
    }


def test_gemini_json_mode_payload_removes_schema_and_adds_it_to_prompt() -> None:
    payload = {
        "contents": [{"role": "user", "parts": [{"text": "meeting transcript"}]}],
        "generationConfig": {
            "temperature": 0.2,
            "responseMimeType": "application/json",
            "responseJsonSchema": {"type": "object"},
        },
    }

    result = _gemini_json_mode_payload(payload, {"type": "object"})

    assert "responseJsonSchema" not in result["generationConfig"]
    assert result["generationConfig"]["responseMimeType"] == "application/json"
    assert "meeting transcript" in result["contents"][0]["parts"][0]["text"]
    assert "JSON Schema" in result["contents"][0]["parts"][0]["text"]
    assert "responseJsonSchema" in payload["generationConfig"]


def test_secret_cipher_round_trip_and_mask() -> None:
    from cryptography.fernet import Fernet

    cipher = SecretCipher(Fernet.generate_key().decode("ascii"))
    encrypted = cipher.encrypt("AIza-secret-value-XYZ")
    assert "AIza-secret-value-XYZ" not in encrypted
    assert cipher.decrypt(encrypted) == "AIza-secret-value-XYZ"
    assert secret_mask("AIza-secret-value-XYZ") == "AIza••••••••XYZ"


def test_ollama_lists_models_and_validates_structured_output() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/tags":
            return httpx.Response(200, json={"models": [{"name": "qwen3:8b"}]})
        assert request.url.path == "/api/chat"
        request_payload = json.loads(request.content)
        assert request_payload["options"]["num_ctx"] == 65536
        assert "title" not in json.dumps(request_payload["format"])
        return httpx.Response(
            200,
            json={"message": {"content": '{"summary":"local result"}'}},
        )

    async def run() -> None:
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        provider = OllamaProvider("http://ollama.test", "qwen3:8b", 0.2, client=client)
        assert await provider.list_models() == ["qwen3:8b"]
        result = await provider.generate_structured("system", "prompt", ExampleOutput)
        assert result.summary == "local result"
        await client.aclose()

    asyncio.run(run())


def test_ollama_extracts_json_from_fence_and_explanation() -> None:
    fenced = '```json\n{"summary":"fenced result"}\n```'
    explained = '議事録を生成しました。\n{"summary":"explained result"}\n以上です。'

    assert _parse_json_content(fenced) == {"summary": "fenced result"}
    assert _parse_json_content(explained) == {"summary": "explained result"}
    with pytest.raises(ValueError):
        _parse_json_content('{"summary":"truncated"')


def test_ollama_json_mode_payload_is_deterministic() -> None:
    payload = {
        "format": {"type": "object"},
        "options": {"temperature": 0.2, "num_ctx": 65536},
        "messages": [{"role": "user", "content": "transcript"}],
    }

    result = _ollama_json_mode_payload(payload)

    assert result["format"] == "json"
    assert result["options"]["temperature"] == 0
    assert result["options"]["num_ctx"] == 65536
    assert "JSON Schema" in result["messages"][-1]["content"]
    assert "requiredに指定されたキーは必ず全て出力" in result["messages"][-1]["content"]
    assert payload["format"] == {"type": "object"}


def test_ollama_schema_removes_grammar_heavy_validation_keywords() -> None:
    source = {
        "title": "Example",
        "type": "array",
        "minItems": 1,
        "maxItems": 100,
        "items": {"type": "string", "format": "uuid", "minLength": 1},
    }
    assert _ollama_compatible_schema(source) == {
        "type": "array",
        "items": {"type": "string", "format": "uuid"},
    }


def test_ollama_restricts_evidence_ids_to_prompt_aliases() -> None:
    first = "00000000-0000-0000-0000-000000000001"
    second = "00000000-0000-0000-0000-000000000002"
    schema = {
        "type": "object",
        "properties": {
            "summary_evidence_segment_ids": {
                "type": "array",
                "items": {"type": "string", "format": "uuid"},
            }
        },
    }

    result = _restrict_evidence_segment_ids(
        schema,
        f"[evidence_id={first}] first\n[evidence_id={second}] second",
    )

    definition = result["$defs"]["AllowedEvidenceSegmentId"]
    assert definition["enum"] == [first, second]
    items = result["properties"]["summary_evidence_segment_ids"]["items"]
    assert items == {"$ref": "#/$defs/AllowedEvidenceSegmentId"}


def test_ollama_repairs_unique_single_character_evidence_uuid_typo() -> None:
    valid_id = "12345678-1234-1234-1234-123456789abc"
    broken_id = "1234567-1234-1234-1234-123456789abc"
    result = _repair_evidence_segment_ids(
        {
            "summary": "result",
            "decisions": [{"evidence_segment_ids": [broken_id]}],
        },
        f"[segment_id={valid_id}] transcript",
    )
    assert result["decisions"][0]["evidence_segment_ids"] == [valid_id]


def test_repairs_regrouped_sequential_evidence_alias() -> None:
    valid_id = str(uuid.UUID(int=7))
    broken_id = "00000000-0000-0000-00000000-000000000007"
    result = _repair_evidence_segment_ids(
        {"summary_evidence_segment_ids": [broken_id]},
        f"[evidence_id={valid_id}] transcript",
    )
    assert result["summary_evidence_segment_ids"] == [valid_id]


def test_repairs_short_sequential_evidence_alias() -> None:
    valid_id = str(uuid.UUID(int=7))
    result = _repair_evidence_segment_ids(
        {"summary_evidence_segment_ids": ["E0007"]},
        f"[evidence_id={valid_id}] transcript",
    )
    assert result["summary_evidence_segment_ids"] == [valid_id]


def test_ollama_does_not_guess_ambiguous_evidence_uuid_typo() -> None:
    broken_id = "1234567-1234-1234-1234-123456789abc"
    result = _repair_evidence_segment_ids(
        {"summary_evidence_segment_ids": [broken_id]},
        (
            "[segment_id=12345678-1234-1234-1234-123456789abc] first\n"
            "[segment_id=12345679-1234-1234-1234-123456789abc] second"
        ),
    )
    assert result["summary_evidence_segment_ids"] == [broken_id]


def test_ollama_limits_known_evidence_ids_evenly() -> None:
    evidence_ids = [str(uuid.UUID(int=index)) for index in range(1, 106)]
    prompt = "\n".join(f"[evidence_id={value}]" for value in evidence_ids)

    result = _limit_evidence_segment_ids(
        {"chapters": [{"evidence_segment_ids": evidence_ids}]},
        prompt,
    )

    limited = result["chapters"][0]["evidence_segment_ids"]
    assert len(limited) == 20
    assert limited[0] == evidence_ids[0]
    assert limited[-1] == evidence_ids[-1]


def test_ollama_validates_chapter_after_limiting_105_known_evidence_ids() -> None:
    evidence_ids = [str(uuid.UUID(int=index)) for index in range(1, 106)]
    prompt = "\n".join(f"[evidence_id={value}]" for value in evidence_ids)
    content = json.dumps(
        {"chapters": [{"evidence_segment_ids": evidence_ids}]},
        separators=(",", ":"),
    )

    result = _validate_structured_content(content, prompt, ExampleChaptersOutput)

    assert len(result.chapters[0].evidence_segment_ids) == 20
    assert result.chapters[0].evidence_segment_ids[0] == uuid.UUID(evidence_ids[0])
    assert result.chapters[0].evidence_segment_ids[-1] == uuid.UUID(evidence_ids[-1])


def test_ollama_does_not_hide_unknown_evidence_while_limiting() -> None:
    evidence_ids = [str(uuid.UUID(int=index)) for index in range(1, 22)]
    prompt = "\n".join(f"[evidence_id={value}]" for value in evidence_ids[:-1])

    result = _limit_evidence_segment_ids(
        {"chapters": [{"evidence_segment_ids": evidence_ids}]},
        prompt,
    )

    assert result["chapters"][0]["evidence_segment_ids"] == evidence_ids


def test_ollama_retries_grammar_error_with_json_mode() -> None:
    requests: list[dict[str, object]] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(json.loads(request.content))
        if len(requests) == 1:
            return httpx.Response(
                400,
                json={
                    "error": (
                        '{"message":"Failed to initialize samplers: failed to parse grammar"}'
                    )
                },
            )
        return httpx.Response(
            200,
            json={"message": {"content": '{"summary":"fallback result"}'}},
        )

    async def run() -> None:
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        provider = OllamaProvider("http://ollama.test", "gemma4:12b", 0.2, client=client)
        result = await provider.generate_structured("system", "prompt", ExampleOutput)
        assert result.summary == "fallback result"
        assert requests[1]["format"] == "json"
        assert "JSON Schema" in requests[1]["messages"][-1]["content"]
        await client.aclose()

    asyncio.run(run())


def test_ollama_retries_invalid_json_with_json_mode() -> None:
    requests: list[dict[str, object]] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        request_payload = json.loads(request.content)
        requests.append(request_payload)
        if len(requests) == 1:
            return httpx.Response(
                200,
                json={"message": {"content": "JSONを生成できませんでした"}},
            )
        return httpx.Response(
            200,
            json={"message": {"content": '{"summary":"regenerated result"}'}},
        )

    async def run() -> None:
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        provider = OllamaProvider("http://ollama.test", "gemma4:12b", 0.2, client=client)
        result = await provider.generate_structured("system", "prompt", ExampleOutput)
        assert result.summary == "regenerated result"
        assert len(requests) == 2
        assert requests[1]["format"] == "json"
        assert requests[1]["options"]["temperature"] == 0
        assert "JSON Schema" in requests[1]["messages"][-1]["content"]
        await client.aclose()

    asyncio.run(run())


def test_ollama_retries_schema_mismatch_with_json_mode() -> None:
    requests: list[dict[str, object]] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        request_payload = json.loads(request.content)
        requests.append(request_payload)
        if len(requests) == 1:
            return httpx.Response(
                200,
                json={"message": {"content": '{"other":"summary is missing"}'}},
            )
        return httpx.Response(
            200,
            json={"message": {"content": '{"summary":"schema retry result"}'}},
        )

    async def run() -> None:
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        provider = OllamaProvider("http://ollama.test", "gemma4:12b", 0.2, client=client)
        result = await provider.generate_structured("system", "prompt", ExampleOutput)
        assert result.summary == "schema retry result"
        assert len(requests) == 2
        assert requests[1]["format"] == "json"
        assert requests[1]["options"]["temperature"] == 0
        assert "requiredに指定されたキーは必ず全て出力" in requests[1]["messages"][-1]["content"]
        await client.aclose()

    asyncio.run(run())


def test_ollama_stops_after_one_schema_mismatch_retry() -> None:
    request_count = 0

    async def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal request_count
        request_count += 1
        return httpx.Response(
            200,
            json={"message": {"content": '{"other":"summary is missing"}'}},
        )

    async def run() -> None:
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        provider = OllamaProvider("http://ollama.test", "gemma4:12b", 0.2, client=client)
        with pytest.raises(LLMProviderError, match=r"summary.*Field required"):
            await provider.generate_structured("system", "prompt", ExampleOutput)
        assert request_count == 2
        await client.aclose()

    asyncio.run(run())


def test_gemini_uses_header_secret_and_validates_structured_output() -> None:
    seen_api_key = ""

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal seen_api_key
        seen_api_key = request.headers.get("x-goog-api-key", "")
        return httpx.Response(
            200,
            json={"candidates": [{"content": {"parts": [{"text": '{"summary":"cloud result"}'}]}}]},
        )

    async def run() -> None:
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        provider = GeminiProvider("secret-key", "gemini-test", 0.1, client=client)
        result = await provider.generate_structured("system", "prompt", ExampleOutput)
        assert result.summary == "cloud result"
        assert seen_api_key == "secret-key"
        await client.aclose()

    asyncio.run(run())


def test_gemini_retries_http_400_without_response_schema() -> None:
    requests: list[dict[str, object]] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(json.loads(request.content))
        if len(requests) == 1:
            return httpx.Response(
                400,
                json={
                    "error": {
                        "status": "INVALID_ARGUMENT",
                        "message": "Request contains an invalid argument.",
                    }
                },
            )
        return httpx.Response(
            200,
            json={
                "candidates": [{"content": {"parts": [{"text": '{"summary":"fallback result"}'}]}}]
            },
        )

    async def run() -> None:
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        provider = GeminiProvider("secret-key", "gemini-test", 0.1, client=client)
        result = await provider.generate_structured("system", "prompt", ExampleOutput)
        assert result.summary == "fallback result"
        assert len(requests) == 2
        assert "responseJsonSchema" in requests[0]["generationConfig"]
        assert "responseJsonSchema" not in requests[1]["generationConfig"]
        assert "JSON Schema" in requests[1]["contents"][0]["parts"][0]["text"]
        await client.aclose()

    asyncio.run(run())


def test_gemini_retries_transient_http_errors() -> None:
    request_count = 0

    async def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal request_count
        request_count += 1
        if request_count < 3:
            return httpx.Response(
                503,
                json={"error": {"message": "This model is currently experiencing high demand."}},
            )
        return httpx.Response(
            200,
            json={
                "candidates": [{"content": {"parts": [{"text": "{\"summary\":\"retry result\"}"}]}}]
            },
        )

    async def run() -> None:
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        provider = GeminiProvider(
            "secret-key",
            "gemini-test",
            0.1,
            max_attempts=3,
            retry_delay_seconds=0,
            client=client,
        )
        result = await provider.generate_structured("system", "prompt", ExampleOutput)
        assert result.summary == "retry result"
        assert request_count == 3
        await client.aclose()

    asyncio.run(run())


def test_gemini_retries_schema_mismatch_with_json_mode() -> None:
    requests: list[dict[str, object]] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        request_payload = json.loads(request.content)
        requests.append(request_payload)
        content = (
            '{"other":"summary is missing"}'
            if len(requests) == 1
            else '{"summary":"schema retry result"}'
        )
        return httpx.Response(
            200,
            json={"candidates": [{"content": {"parts": [{"text": content}]}}]},
        )

    async def run() -> None:
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        provider = GeminiProvider(
            "secret-key",
            "gemini-test",
            0.1,
            retry_delay_seconds=0,
            client=client,
        )
        result = await provider.generate_structured("system", "prompt", ExampleOutput)
        assert result.summary == "schema retry result"
        assert len(requests) == 2
        assert requests[1]["generationConfig"]["temperature"] == 0
        assert "前回の回答はJSON Schemaと一致" in requests[1]["contents"][-1]["parts"][0]["text"]
        await client.aclose()

    asyncio.run(run())


def test_gemini_connection_does_not_require_profile_model() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1beta/models"
        return httpx.Response(
            200,
            json={"models": [{"name": "models/gemini-2.5-flash"}]},
        )

    async def run() -> None:
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        provider = GeminiProvider("secret-key", client=client)
        await provider.test_connection()
        assert await provider.list_models() == ["gemini-2.5-flash"]
        await client.aclose()

    asyncio.run(run())


def test_gemini_reports_safe_http_error_detail() -> None:
    async def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            400,
            json={"error": {"message": "Unsupported schema keyword: minLength"}},
        )

    async def run() -> None:
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        provider = GeminiProvider("secret-key", "gemini-test", client=client)
        with pytest.raises(LLMProviderError, match="HTTP 400.*Unsupported schema"):
            await provider.generate_structured("system", "prompt", ExampleOutput)
        await client.aclose()

    asyncio.run(run())


def test_gemini_restricts_and_repairs_evidence_ids() -> None:
    valid_id = "12345678-1234-1234-1234-123456789abc"
    broken_id = "1234567-1234-1234-1234-123456789abc"

    async def handler(request: httpx.Request) -> httpx.Response:
        request_payload = json.loads(request.content)
        response_schema = request_payload["generationConfig"]["responseJsonSchema"]
        assert response_schema["$defs"]["AllowedEvidenceSegmentId"]["enum"] == [valid_id]
        return httpx.Response(
            200,
            json={
                "candidates": [
                    {
                        "content": {
                            "parts": [
                                {
                                    "text": json.dumps(
                                        {
                                            "chapters": [
                                                {"evidence_segment_ids": [broken_id]}
                                            ]
                                        }
                                    )
                                }
                            ]
                        }
                    }
                ]
            },
        )

    async def run() -> None:
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        provider = GeminiProvider("secret-key", "gemini-test", 0.1, client=client)
        result = await provider.generate_structured(
            "system",
            f"[evidence_id={valid_id}] transcript",
            ExampleChaptersOutput,
        )
        assert result.chapters[0].evidence_segment_ids == [uuid.UUID(valid_id)]
        await client.aclose()

    asyncio.run(run())
