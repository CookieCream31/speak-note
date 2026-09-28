from pathlib import Path
from typing import Protocol

from app.services.transcription.schemas import WhisperXResult


class TranscriptionClient(Protocol):
    supports_overlap_context: bool

    def transcribe(
        self,
        audio_path: Path,
        mime_type: str,
        *,
        min_speakers: int | None = None,
        max_speakers: int | None = None,
    ) -> WhisperXResult: ...
