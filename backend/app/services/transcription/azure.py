import re
import time
from pathlib import Path
from typing import Any

import httpx

from app.services.transcription.schemas import WhisperXResult


class AzureSpeechError(RuntimeError):
    pass


_RETRYABLE_HTTP_STATUSES = frozenset({429, 500, 502, 503, 504})
_SILENCE_STATUSES = frozenset({"NoMatch", "InitialSilenceTimeout", "BabbleTimeout"})
_REGION_PATTERN = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
_TICKS_PER_SECOND = 10_000_000


def validate_azure_region(region: str) -> str:
    normalized = region.strip().lower()
    if not normalized or len(normalized) > 100 or _REGION_PATTERN.fullmatch(normalized) is None:
        raise AzureSpeechError("Azure AI Speechのリージョン形式が不正です")
    return normalized


def _ticks_to_seconds(value: object) -> float:
    if isinstance(value, bool):
        return 0.0
    try:
        ticks = float(value)  # Azure can serialize Offset and Duration as strings.
    except (TypeError, ValueError):
        return 0.0
    return ticks / _TICKS_PER_SECOND if ticks >= 0 else 0.0


def _error_detail(response: httpx.Response) -> str | None:
    try:
        payload = response.json()
    except ValueError:
        detail: object = response.text
    else:
        if isinstance(payload, dict):
            detail = payload.get("error") or payload.get("message")
        else:
            detail = payload
    normalized = " ".join(str(detail or "").split())
    return normalized[:500] or None


def _word_text(word: str, language: str, index: int) -> str:
    if index == 0 or language.lower().startswith(("ja", "zh", "ko")):
        return word
    return f" {word}"


class AzureSpeechClient:
    supports_overlap_context = False

    def __init__(
        self,
        *,
        region: str,
        api_key: str,
        language: str = "ja-JP",
        timeout_seconds: float = 60.0,
        max_attempts: int = 3,
        retry_delay_seconds: float = 1.0,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self.region = validate_azure_region(region)
        self.api_key = api_key
        self.language = language
        self.timeout_seconds = timeout_seconds
        self.max_attempts = max(1, max_attempts)
        self.retry_delay_seconds = max(0.0, retry_delay_seconds)
        self.transport = transport

    @property
    def recognition_url(self) -> str:
        return (
            f"https://{self.region}.stt.speech.microsoft.com/"
            "speech/recognition/conversation/cognitiveservices/v1"
        )

    @property
    def token_url(self) -> str:
        return f"https://{self.region}.api.cognitive.microsoft.com/sts/v1.0/issueToken"

    def issue_token(self) -> str:
        response = self._request(
            self.token_url,
            headers={"Ocp-Apim-Subscription-Key": self.api_key},
            content=b"",
            operation="認証トークン発行",
        )
        token = response.text.strip()
        if not token:
            raise AzureSpeechError("Azure AI Speechの認証トークンが空です")
        return token

    def test_connection(self) -> None:
        self.issue_token()

    def transcribe(
        self,
        audio_path: Path,
        mime_type: str,
        *,
        min_speakers: int | None = None,
        max_speakers: int | None = None,
    ) -> WhisperXResult:
        del min_speakers, max_speakers
        if mime_type.split(";", maxsplit=1)[0].strip().lower() != "audio/wav":
            raise AzureSpeechError("Azure AI Speechへ送信する音声はWAV形式である必要があります")
        response = self._request(
            self.recognition_url,
            headers={
                "Accept": "application/json",
                "Content-Type": "audio/wav; codecs=audio/pcm; samplerate=16000",
                "Ocp-Apim-Subscription-Key": self.api_key,
            },
            params={
                "language": self.language,
                "format": "detailed",
                "profanity": "raw",
            },
            content=audio_path.read_bytes(),
            operation="文字起こし",
        )
        try:
            payload = response.json()
        except ValueError as exc:
            raise AzureSpeechError("Azure AI Speechの応答形式が不正です") from exc
        if not isinstance(payload, dict):
            raise AzureSpeechError("Azure AI Speechの応答形式が不正です")
        status = payload.get("RecognitionStatus")
        if status in _SILENCE_STATUSES:
            return WhisperXResult.model_validate({"segments": [], **payload})
        if status != "Success":
            raise AzureSpeechError(f"Azure AI Speechが認識に失敗しました: {status or 'unknown'}")

        nbest = payload.get("NBest")
        best: dict[str, Any] = (
            nbest[0]
            if isinstance(nbest, list) and nbest and isinstance(nbest[0], dict)
            else {}
        )
        display_text = str(best.get("Display") or payload.get("DisplayText") or "").strip()
        confidence_value = best.get("Confidence")
        confidence = (
            float(confidence_value)
            if isinstance(confidence_value, (int, float))
            else None
        )
        words_payload = best.get("Words")
        words: list[dict[str, Any]] = []
        if isinstance(words_payload, list):
            for index, item in enumerate(words_payload):
                if not isinstance(item, dict):
                    continue
                lexical = str(item.get("Word") or "")
                if not lexical:
                    continue
                start = _ticks_to_seconds(item.get("Offset"))
                duration = _ticks_to_seconds(item.get("Duration"))
                words.append(
                    {
                        "word": _word_text(lexical, self.language, index),
                        "start": start,
                        "end": start + duration,
                        "speaker": "SPEAKER_00",
                        "score": confidence,
                    }
                )
        if not display_text and words:
            display_text = "".join(str(word["word"]) for word in words).strip()
        if not display_text:
            return WhisperXResult.model_validate({"segments": [], **payload})

        start = _ticks_to_seconds(payload.get("Offset"))
        duration = _ticks_to_seconds(payload.get("Duration"))
        if words:
            start = min(float(word["start"]) for word in words)
            end = max(float(word["end"]) for word in words)
        else:
            end = start + duration
        return WhisperXResult.model_validate(
            {
                **payload,
                "segments": [
                    {
                        "start": start,
                        "end": max(start, end),
                        "text": display_text,
                        "speaker": "SPEAKER_00",
                        "confidence": confidence,
                        "words": words,
                    }
                ],
            }
        )

    def _request(
        self,
        url: str,
        *,
        headers: dict[str, str],
        content: bytes,
        operation: str,
        params: dict[str, str] | None = None,
    ) -> httpx.Response:
        last_connection_error: httpx.HTTPError | None = None
        for attempt in range(self.max_attempts):
            try:
                with httpx.Client(
                    timeout=httpx.Timeout(
                        self.timeout_seconds,
                        connect=min(10.0, self.timeout_seconds),
                    ),
                    transport=self.transport,
                ) as client:
                    response = client.post(
                        url,
                        headers=headers,
                        params=params,
                        content=content,
                    )
                response.raise_for_status()
                return response
            except (httpx.ConnectTimeout, httpx.NetworkError) as exc:
                last_connection_error = exc
            except httpx.TimeoutException as exc:
                raise AzureSpeechError("Azure AI Speechへの接続がタイムアウトしました") from exc
            except httpx.HTTPStatusError as exc:
                detail = _error_detail(exc.response)
                if exc.response.status_code not in _RETRYABLE_HTTP_STATUSES:
                    message = f"Azure AI SpeechがHTTP {exc.response.status_code}を返しました"
                    if detail:
                        message = f"{message}: {detail}"
                    raise AzureSpeechError(message) from exc
                last_connection_error = exc
            if attempt + 1 < self.max_attempts and self.retry_delay_seconds > 0:
                time.sleep(self.retry_delay_seconds * (attempt + 1))
        raise AzureSpeechError(f"Azure AI Speechの{operation}に接続できませんでした") from last_connection_error
