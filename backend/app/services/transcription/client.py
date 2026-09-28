import time
from pathlib import Path

import httpx
from pydantic import ValidationError

from app.services.transcription.schemas import WhisperXResult


class WhisperXError(RuntimeError):
    pass


class WhisperXEmptyAudioError(WhisperXError):
    pass


_RETRYABLE_HTTP_STATUSES = frozenset({429, 500, 502, 503, 504})
_RETRYABLE_INVALID_AUDIO_DETAILS = (
    "could not decode audio",
    "decoded audio is empty",
)


def _http_error_detail(response: httpx.Response) -> str | None:
    try:
        payload = response.json()
    except ValueError:
        detail: object = response.text
    else:
        detail = payload.get("detail") if isinstance(payload, dict) else payload
    if detail in (None, ""):
        return None
    normalized = " ".join(str(detail).split())
    return normalized[:500] or None


def _is_retryable_http_error(status_code: int, detail: str | None) -> bool:
    if status_code in _RETRYABLE_HTTP_STATUSES:
        return True
    if status_code != 422 or detail is None:
        return False
    normalized_detail = detail.casefold()
    return any(fragment in normalized_detail for fragment in _RETRYABLE_INVALID_AUDIO_DETAILS)


class WhisperXClient:
    supports_overlap_context = True

    def __init__(
        self,
        base_url: str,
        api_key: str,
        model: str = "large-v3",
        language: str = "ja",
        timeout_seconds: float = 7200.0,
        max_attempts: int = 3,
        retry_delay_seconds: float = 1.0,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.model = model
        self.language = language
        self.timeout_seconds = timeout_seconds
        self.max_attempts = max(1, max_attempts)
        self.retry_delay_seconds = max(0.0, retry_delay_seconds)
        self.transport = transport

    def transcribe(
        self,
        audio_path: Path,
        mime_type: str,
        *,
        min_speakers: int | None = None,
        max_speakers: int | None = None,
    ) -> WhisperXResult:
        headers = {"Authorization": f"Bearer {self.api_key}"} if self.api_key else {}
        data = {
            "model": self.model,
            "language": self.language,
            "align": "true",
            "diarize": "true",
            "response_format": "verbose_json",
        }
        if min_speakers is not None:
            data["min_speakers"] = str(min_speakers)
        if max_speakers is not None:
            data["max_speakers"] = str(max_speakers)
        last_connection_error: httpx.HTTPError | None = None
        for attempt in range(self.max_attempts):
            try:
                with (
                    audio_path.open("rb") as audio_file,
                    httpx.Client(
                        timeout=httpx.Timeout(
                            self.timeout_seconds,
                            connect=min(10.0, self.timeout_seconds),
                        ),
                        transport=self.transport,
                    ) as http_client,
                ):
                    response = http_client.post(
                        f"{self.base_url}/v1/audio/transcriptions",
                        headers=headers,
                        data=data,
                        files={"file": (audio_path.name, audio_file, mime_type)},
                    )
                response.raise_for_status()
                payload = response.json()
                return WhisperXResult.model_validate(payload)
            except (httpx.ConnectTimeout, httpx.NetworkError) as exc:
                last_connection_error = exc
                if attempt + 1 >= self.max_attempts:
                    break
                if self.retry_delay_seconds > 0:
                    time.sleep(self.retry_delay_seconds * (attempt + 1))
            except httpx.TimeoutException as exc:
                raise WhisperXError("WhisperXに接続できませんでした") from exc
            except httpx.HTTPStatusError as exc:
                detail = _http_error_detail(exc.response)
                if (
                    _is_retryable_http_error(exc.response.status_code, detail)
                    and attempt + 1 < self.max_attempts
                ):
                    if self.retry_delay_seconds > 0:
                        time.sleep(self.retry_delay_seconds * (attempt + 1))
                    continue
                message = f"WhisperXがHTTP {exc.response.status_code}を返しました"
                if detail is not None:
                    message = f"{message}: {detail}"
                if (
                    exc.response.status_code == 422
                    and detail is not None
                    and "decoded audio is empty" in detail.casefold()
                ):
                    raise WhisperXEmptyAudioError(message) from exc
                raise WhisperXError(message) from exc
            except (ValueError, ValidationError) as exc:
                raise WhisperXError("WhisperXの応答形式が不正です") from exc
        raise WhisperXError("WhisperXに接続できませんでした") from last_connection_error
