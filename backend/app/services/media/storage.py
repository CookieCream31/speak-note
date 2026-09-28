import os
import shutil
import uuid
from dataclasses import dataclass
from pathlib import Path

from fastapi import UploadFile

ALLOWED_AUDIO_TYPES: dict[str, frozenset[str]] = {
    ".m4a": frozenset({"audio/mp4", "audio/x-m4a", "video/mp4"}),
    ".mp3": frozenset({"audio/mpeg", "audio/mp3"}),
    ".wav": frozenset({"audio/wav", "audio/x-wav", "audio/wave"}),
    ".flac": frozenset({"audio/flac", "audio/x-flac"}),
}
ALLOWED_VIDEO_TYPES: dict[str, frozenset[str]] = {
    ".mp4": frozenset({"video/mp4"}),
    ".mov": frozenset({"video/quicktime"}),
    ".webm": frozenset({"video/webm"}),
}
COPY_CHUNK_BYTES = 1024 * 1024


class InvalidAudioError(ValueError):
    pass


class InvalidVideoError(ValueError):
    pass


class UploadTooLargeError(ValueError):
    pass


class InvalidUploadChunkError(ValueError):
    pass


@dataclass(frozen=True)
class StoredUpload:
    storage_path: str
    mime_type: str
    size_bytes: int


class MediaStorage:
    def __init__(
        self,
        root: str | Path,
        max_audio_upload_mb: int,
        max_video_upload_mb: int | None = None,
    ) -> None:
        self.root = Path(root).resolve()
        self.max_audio_upload_bytes = max_audio_upload_mb * 1024 * 1024
        self.max_video_upload_bytes = (
            (max_video_upload_mb if max_video_upload_mb is not None else max_audio_upload_mb)
            * 1024
            * 1024
        )

    def absolute_path(self, storage_path: str) -> Path:
        candidate = (self.root / storage_path).resolve()
        if not candidate.is_relative_to(self.root):
            raise ValueError("Invalid storage path")
        return candidate

    def save_audio(
        self, upload: UploadFile, meeting_id: uuid.UUID, media_id: uuid.UUID
    ) -> StoredUpload:
        return self._save_upload(
            upload,
            meeting_id,
            media_id,
            allowed_types=ALLOWED_AUDIO_TYPES,
            max_upload_bytes=self.max_audio_upload_bytes,
            invalid_error=InvalidAudioError,
            type_label="音声",
            allowed_label="m4a、mp3、wav、flac",
        )

    def save_video(
        self, upload: UploadFile, meeting_id: uuid.UUID, media_id: uuid.UUID
    ) -> StoredUpload:
        return self._save_upload(
            upload,
            meeting_id,
            media_id,
            allowed_types=ALLOWED_VIDEO_TYPES,
            max_upload_bytes=self.max_video_upload_bytes,
            invalid_error=InvalidVideoError,
            type_label="動画",
            allowed_label="mp4、mov、webm",
        )

    def validate_media_metadata(
        self, filename: str, mime_type: str, size_bytes: int
    ) -> tuple[str, str, str]:
        suffix = Path(filename).suffix.lower()
        if suffix in ALLOWED_VIDEO_TYPES:
            validated_suffix, validated_mime = self.validate_video_metadata(
                filename, mime_type, size_bytes
            )
            return "video", validated_suffix, validated_mime
        if suffix in ALLOWED_AUDIO_TYPES:
            validated_suffix, validated_mime = self.validate_audio_metadata(
                filename, mime_type, size_bytes
            )
            return "audio", validated_suffix, validated_mime
        raise InvalidVideoError(
            "mp4、mov、webm、m4a、mp3、wav、flac形式のファイルを選択してください"
        )

    def validate_audio_metadata(
        self, filename: str, mime_type: str, size_bytes: int
    ) -> tuple[str, str]:
        return self._validate_metadata(
            filename,
            mime_type,
            size_bytes,
            allowed_types=ALLOWED_AUDIO_TYPES,
            max_upload_bytes=self.max_audio_upload_bytes,
            invalid_error=InvalidAudioError,
            type_label="音声",
            allowed_label="m4a、mp3、wav、flac",
        )

    def validate_video_metadata(
        self, filename: str, mime_type: str, size_bytes: int
    ) -> tuple[str, str]:
        return self._validate_metadata(
            filename,
            mime_type,
            size_bytes,
            allowed_types=ALLOWED_VIDEO_TYPES,
            max_upload_bytes=self.max_video_upload_bytes,
            invalid_error=InvalidVideoError,
            type_label="動画",
            allowed_label="mp4、mov、webm",
        )

    def _validate_metadata(
        self,
        filename: str,
        mime_type: str,
        size_bytes: int,
        *,
        allowed_types: dict[str, frozenset[str]],
        max_upload_bytes: int,
        invalid_error: type[ValueError],
        type_label: str,
        allowed_label: str,
    ) -> tuple[str, str]:
        suffix = Path(filename).suffix.lower()
        normalized_mime_type = mime_type.split(";", maxsplit=1)[0].strip().lower()
        if suffix not in allowed_types or normalized_mime_type not in allowed_types[suffix]:
            raise invalid_error(f"{allowed_label}形式の{type_label}ファイルを選択してください")
        if size_bytes <= 0:
            raise invalid_error(f"空の{type_label}ファイルはアップロードできません")
        if size_bytes > max_upload_bytes:
            limit_mb = max_upload_bytes // (1024 * 1024)
            raise UploadTooLargeError(f"{type_label}ファイルは{limit_mb}MB以下にしてください")
        return suffix, normalized_mime_type

    def save_upload_chunk(
        self,
        upload: UploadFile,
        meeting_id: uuid.UUID,
        upload_id: uuid.UUID,
        chunk_index: int,
        expected_size_bytes: int,
    ) -> int:
        directory = self._upload_directory(meeting_id, upload_id)
        directory.mkdir(parents=True, exist_ok=True)
        destination = directory / f"{chunk_index}.part"
        temporary = directory / f".{chunk_index}.uploading"
        size_bytes = 0
        try:
            with temporary.open("wb") as output:
                while chunk := upload.file.read(COPY_CHUNK_BYTES):
                    size_bytes += len(chunk)
                    if size_bytes > expected_size_bytes:
                        raise InvalidUploadChunkError("チャンクのサイズが正しくありません")
                    output.write(chunk)
            if size_bytes != expected_size_bytes:
                raise InvalidUploadChunkError("チャンクのサイズが正しくありません")
            os.replace(temporary, destination)
        except Exception:
            temporary.unlink(missing_ok=True)
            raise
        return size_bytes

    def received_upload_chunks(
        self, meeting_id: uuid.UUID, upload_id: uuid.UUID, chunk_count: int
    ) -> list[int]:
        directory = self._upload_directory(meeting_id, upload_id)
        return [index for index in range(chunk_count) if (directory / f"{index}.part").is_file()]

    def assemble_upload(
        self,
        meeting_id: uuid.UUID,
        upload_id: uuid.UUID,
        media_id: uuid.UUID,
        filename_suffix: str,
        mime_type: str,
        chunk_count: int,
        expected_size_bytes: int,
    ) -> StoredUpload:
        upload_directory = self._upload_directory(meeting_id, upload_id)
        relative_path = (
            Path("meetings")
            / str(meeting_id)
            / "original"
            / f"{media_id}{filename_suffix}"
        )
        destination = self.absolute_path(relative_path.as_posix())
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_name(f".{media_id}.assembling")
        total_size_bytes = 0
        try:
            with temporary.open("wb") as output:
                for chunk_index in range(chunk_count):
                    chunk_path = upload_directory / f"{chunk_index}.part"
                    if not chunk_path.is_file():
                        raise InvalidUploadChunkError(
                            f"チャンク{chunk_index + 1}がアップロードされていません"
                        )
                    with chunk_path.open("rb") as source:
                        while chunk := source.read(COPY_CHUNK_BYTES):
                            total_size_bytes += len(chunk)
                            if total_size_bytes > expected_size_bytes:
                                raise InvalidUploadChunkError(
                                    "アップロードサイズが正しくありません"
                                )
                            output.write(chunk)
            if total_size_bytes != expected_size_bytes:
                raise InvalidUploadChunkError("アップロードサイズが正しくありません")
            os.replace(temporary, destination)
        except Exception:
            temporary.unlink(missing_ok=True)
            raise
        return StoredUpload(relative_path.as_posix(), mime_type, total_size_bytes)

    def delete_upload_parts(self, meeting_id: uuid.UUID, upload_id: uuid.UUID) -> None:
        directory = self._upload_directory(meeting_id, upload_id)
        if directory.exists():
            shutil.rmtree(directory)

    def _upload_directory(self, meeting_id: uuid.UUID, upload_id: uuid.UUID) -> Path:
        relative = Path("meetings") / str(meeting_id) / "uploads" / str(upload_id)
        return self.absolute_path(relative.as_posix())

    def _save_upload(
        self,
        upload: UploadFile,
        meeting_id: uuid.UUID,
        media_id: uuid.UUID,
        *,
        allowed_types: dict[str, frozenset[str]],
        max_upload_bytes: int,
        invalid_error: type[ValueError],
        type_label: str,
        allowed_label: str,
    ) -> StoredUpload:
        suffix, mime_type = self._validate_metadata(
            upload.filename or "",
            upload.content_type or "",
            1,
            allowed_types=allowed_types,
            max_upload_bytes=max_upload_bytes,
            invalid_error=invalid_error,
            type_label=type_label,
            allowed_label=allowed_label,
        )

        relative_path = Path("meetings") / str(meeting_id) / "original" / f"{media_id}{suffix}"
        destination = self.absolute_path(relative_path.as_posix())
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_name(f".{media_id}.uploading")
        size_bytes = 0

        try:
            with temporary.open("xb") as output:
                while chunk := upload.file.read(COPY_CHUNK_BYTES):
                    size_bytes += len(chunk)
                    if size_bytes > max_upload_bytes:
                        limit_mb = max_upload_bytes // (1024 * 1024)
                        raise UploadTooLargeError(
                            f"{type_label}ファイルは{limit_mb}MB以下にしてください"
                        )
                    output.write(chunk)
            if size_bytes == 0:
                raise invalid_error(f"空の{type_label}ファイルはアップロードできません")
            os.replace(temporary, destination)
        except Exception:
            temporary.unlink(missing_ok=True)
            raise

        return StoredUpload(
            storage_path=relative_path.as_posix(),
            mime_type=mime_type,
            size_bytes=size_bytes,
        )

    def delete_file(self, storage_path: str) -> None:
        self.absolute_path(storage_path).unlink(missing_ok=True)

    def delete_meeting_files(self, meeting_id: uuid.UUID) -> None:
        meeting_directory = self.absolute_path(str(Path("meetings") / str(meeting_id)))
        if meeting_directory.exists():
            shutil.rmtree(meeting_directory)
