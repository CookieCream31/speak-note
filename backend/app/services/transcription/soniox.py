"""Soniox REST boundary. Never put credentials or provider error bodies in logs."""

import time
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx
from pydantic import BaseModel, Field, ValidationError

from app.services.transcription.schemas import WhisperXResult, WhisperXSegment, WhisperXWord


class SonioxError(RuntimeError):
    pass


class SonioxToken(BaseModel):
    text: str
    start_ms: int = Field(ge=0)
    end_ms: int = Field(ge=0)
    confidence: float | None = Field(default=None, ge=0, le=1)
    speaker: str | None = None
    translation_status: str | None = None


def normalize_soniox_transcript(payload: dict[str, Any]) -> WhisperXResult:
    """Keep token whitespace/subwords; convert ms only at the existing client boundary."""
    segments: list[WhisperXSegment] = []
    words: list[WhisperXWord] = []

    def flush() -> None:
        if words and "".join(word.word for word in words).strip():
            segments.append(
                WhisperXSegment(
                    start=words[0].start,
                    end=words[-1].end,
                    text="".join(word.word for word in words),
                    words=list(words),
                    speaker=words[0].speaker,
                )
            )
        words.clear()

    try:
        raw_tokens = payload["tokens"]
        if not isinstance(raw_tokens, list):
            raise ValueError
        for raw in raw_tokens:
            if not isinstance(raw, dict):
                raise ValueError
            if (
                raw.get("text") in {"<end>", "<fin>"}
                or raw.get("translation_status") == "translation"
            ):
                flush()
                continue
            token = SonioxToken.model_validate(raw)
            if token.end_ms < token.start_ms:
                raise ValueError
            speaker = f"SONIOX_SPEAKER_{token.speaker}" if token.speaker else None
            # Bound turns even for long uninterrupted monologues.
            if words and (
                words[-1].speaker != speaker or token.start_ms / 1000 - (words[0].start or 0) >= 30
            ):
                flush()
            words.append(
                WhisperXWord(
                    word=token.text,
                    start=token.start_ms / 1000,
                    end=token.end_ms / 1000,
                    speaker=speaker,
                    score=token.confidence,
                )
            )
        flush()
    except (KeyError, TypeError, ValueError, ValidationError) as exc:
        raise SonioxError("Sonioxの文字起こし応答の形式が不正です") from exc
    if not segments:
        raise SonioxError("Sonioxから時刻付き文字起こしが返りませんでした")
    # Segment/Word models are validated above; preserve the original Soniox response
    # without running the WhisperX-specific raw-response normalization again.
    return WhisperXResult.model_construct(segments=segments, raw_response=payload)


class SonioxClient:
    BASE_URL = "https://api.soniox.com/v1"
    supports_overlap_context = False

    def __init__(
        self,
        api_key: str,
        model: str = "stt-async-v5",
        language: str = "ja",
        *,
        transport: httpx.BaseTransport | None = None,
        timeout_seconds: float = 7200,
        poll_interval_seconds: float = 5,
        state: dict[str, Any] | None = None,
        checkpoint: Callable[[dict[str, Any]], None] | None = None,
    ) -> None:
        self.api_key = api_key
        self.model = model
        self.language = language
        self.transport = transport
        self.timeout_seconds = timeout_seconds
        self.poll_interval_seconds = poll_interval_seconds
        self.state = dict(state or {})
        self.checkpoint = checkpoint

    def _save(self, **values: Any) -> None:
        self.state.update(values)
        if self.checkpoint:
            self.checkpoint(dict(self.state))

    def _request(self, method: str, path: str, **kwargs: Any) -> dict[str, Any]:
        # Reads/deletes are idempotent. Never blindly retry a billable POST.
        for attempt in range(3 if method in {"GET", "DELETE"} else 1):
            try:
                with httpx.Client(transport=self.transport, timeout=60) as client:
                    response = client.request(
                        method,
                        f"{self.BASE_URL}{path}",
                        headers={"Authorization": f"Bearer {self.api_key}"},
                        **kwargs,
                    )
            except httpx.HTTPError as exc:
                if method in {"GET", "DELETE"} and attempt < 2:
                    time.sleep(min(self.poll_interval_seconds, 1))
                    continue
                raise SonioxError(
                    "Sonioxとの通信に失敗しました。保存済み処理IDから再試行できます"
                ) from exc
            if method == "DELETE" and response.status_code == 404:
                return {}
            if (
                response.status_code in {429, 500, 502, 503, 504}
                and method != "POST"
                and attempt < 2
            ):
                time.sleep(min(self.poll_interval_seconds, 1))
                continue
            if response.is_error:
                if method == "POST" and response.status_code < 500:
                    self._save(submission_pending=None)
                raise SonioxError(
                    f"Soniox APIエラー (HTTP {response.status_code})。"
                    "キー・権限・残高を確認してください"
                )
            if response.status_code == 204:
                return {}
            try:
                body = response.json()
                if not isinstance(body, dict):
                    raise ValueError
                return body
            except ValueError as exc:
                raise SonioxError("Soniox API応答の形式が不正です") from exc
        raise SonioxError("Sonioxへの接続に失敗しました")

    @staticmethod
    def _id(payload: dict[str, Any]) -> str:
        try:
            return str(uuid.UUID(payload["id"]))
        except (KeyError, ValueError, TypeError, AttributeError) as exc:
            raise SonioxError("Sonioxの処理IDが不正です") from exc

    def test_connection(self) -> None:
        models = self._request("GET", "/models").get("models", [])
        if not isinstance(models, list):
            raise SonioxError("Sonioxモデル一覧の形式が不正です")
        if not any(isinstance(model, dict) and model.get("id") == self.model for model in models):
            raise SonioxError("指定したSonioxモデルが利用できません")

    def temporary_key(self, session_id: uuid.UUID) -> dict[str, Any]:
        return self._request(
            "POST",
            "/auth/temporary-api-key",
            json={
                "usage_type": "transcribe_websocket",
                "expires_in_seconds": 60,
                "single_use": True,
                "max_session_duration_seconds": 18000,
                "client_reference_id": str(session_id),
            },
        )

    def _recover_submission(self, collection: str, reference: str) -> str:
        cursor: str | None = None
        matches: list[dict[str, Any]] = []
        for _ in range(100):
            page = self._request(
                "GET",
                f"/{collection}",
                params={"limit": 1000, **({"cursor": cursor} if cursor else {})},
            )
            items = page.get(collection, [])
            if not isinstance(items, list) or any(not isinstance(item, dict) for item in items):
                raise SonioxError("Soniox一覧応答の形式が不正です")
            matches.extend(item for item in items if item.get("client_reference_id") == reference)
            cursor = page.get("next_page_cursor")
            if cursor is not None and not isinstance(cursor, str):
                raise SonioxError("Soniox一覧応答の形式が不正です")
            if not cursor:
                break
        else:
            raise SonioxError(
                "Soniox処理の復旧検索が上限に達しました。Consoleで処理IDを確認してください"
            )
        if len(matches) != 1:
            raise SonioxError(
                "Soniox送信の完了を確認できません。二重送信を防ぐため再送を停止しました。Consoleを確認してください"
            )
        return self._id(matches[0])

    def transcribe(
        self,
        audio_path: Path,
        mime_type: str,
        *,
        min_speakers: int | None = None,
        max_speakers: int | None = None,
    ) -> WhisperXResult:
        # Soniox diarization has no min/max speaker options; do not invent fields.
        reference = str(self.state.get("reference_id") or uuid.uuid4())
        self._save(reference_id=reference)
        if self.state.get("submission_pending") == "files" and not self.state.get("file_id"):
            self._save(
                file_id=self._recover_submission("files", reference), submission_pending=None
            )
        if not self.state.get("file_id"):
            self._save(submission_pending="files")
            with audio_path.open("rb") as audio:
                body = self._request(
                    "POST",
                    "/files",
                    files={"file": ("meeting-audio" + audio_path.suffix, audio, mime_type)},
                    data={"client_reference_id": reference},
                )
            self._save(file_id=self._id(body), submission_pending=None)
        if self.state.get("submission_pending") == "transcriptions" and not self.state.get(
            "transcription_id"
        ):
            self._save(
                transcription_id=self._recover_submission("transcriptions", reference),
                submission_pending=None,
            )
        if not self.state.get("transcription_id"):
            self._save(submission_pending="transcriptions")
            body = self._request(
                "POST",
                "/transcriptions",
                json={
                    "file_id": self.state["file_id"],
                    "model": self.model,
                    "language_hints": [self.language],
                    "enable_speaker_diarization": True,
                    "enable_language_identification": True,
                    "client_reference_id": reference,
                },
            )
            self._save(transcription_id=self._id(body), submission_pending=None)
        transcription_id = self._id({"id": self.state["transcription_id"]})
        deadline = time.monotonic() + self.timeout_seconds
        while time.monotonic() < deadline:
            body = self._request("GET", f"/transcriptions/{transcription_id}")
            if body.get("status") == "completed":
                return normalize_soniox_transcript(
                    self._request("GET", f"/transcriptions/{transcription_id}/transcript")
                )
            if body.get("status") == "error":
                raise SonioxError(
                    "Sonioxの全体文字起こしが失敗しました。Consoleで処理を確認してください"
                )
            if body.get("status") not in {"queued", "processing"}:
                raise SonioxError("Sonioxの処理状態が不正です")
            self._save(remote_status=body["status"])
            time.sleep(self.poll_interval_seconds)
        raise SonioxError(
            "Soniox処理の待機がタイムアウトしました。再試行すると保存済み処理IDを再利用します"
        )

    def cleanup(self) -> None:
        """Call only after Final is committed. Retain IDs if deletion fails."""
        if self.state.get("remote_deleted"):
            return
        if self.state.get("transcription_id"):
            self._request(
                "DELETE", f"/transcriptions/{self._id({'id': self.state['transcription_id']})}"
            )
        if self.state.get("file_id"):
            self._request("DELETE", f"/files/{self._id({'id': self.state['file_id']})}")
        self._save(remote_deleted=True, cleanup_pending=False)

    def mark_cleanup_pending(self) -> None:
        self._save(cleanup_pending=True)
