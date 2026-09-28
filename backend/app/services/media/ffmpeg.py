import json
import os
import subprocess
from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from pathlib import Path


class MediaProcessingError(RuntimeError):
    pass


@dataclass(frozen=True)
class ProcessedVideo:
    duration_ms: int
    playback_size_bytes: int
    transcription_size_bytes: int


class FFmpegMediaService:
    def __init__(self, ffmpeg_binary: str = "ffmpeg", ffprobe_binary: str = "ffprobe") -> None:
        self.ffmpeg_binary = ffmpeg_binary
        self.ffprobe_binary = ffprobe_binary

    def process_video(
        self,
        original_path: Path,
        playback_path: Path,
        transcription_path: Path,
        *,
        fallback_duration_ms: int | None = None,
    ) -> ProcessedVideo:
        metadata = self._probe(original_path)
        streams = metadata.get("streams")
        if not isinstance(streams, list):
            raise MediaProcessingError("動画のストリーム情報を取得できませんでした")
        if not any(stream.get("codec_type") == "video" for stream in streams):
            raise MediaProcessingError("動画ストリームが見つかりません")
        if not any(stream.get("codec_type") == "audio" for stream in streams):
            raise MediaProcessingError("音声を含まない動画は文字起こしできません")

        video = next(stream for stream in streams if stream.get("codec_type") == "video")
        audio = next(stream for stream in streams if stream.get("codec_type") == "audio")
        # Compatible H.264 is remuxed, not encoded a second time (including live MP4).
        video_options = (
            ["-c:v", "copy"]
            if (
                video.get("codec_name") == "h264"
                and video.get("pix_fmt") in {"yuv420p", "yuvj420p"}
            )
            else [
                "-c:v",
                "libx264",
                "-vf",
                "pad=ceil(iw/2)*2:ceil(ih/2)*2",
                "-preset",
                "veryfast",
                "-crf",
                "18",
                "-pix_fmt",
                "yuv420p",
            ]
        )
        audio_options = (
            ["-c:a", "copy"]
            if audio.get("codec_name") == "aac"
            else [
                "-c:a",
                "aac",
                "-b:a",
                "192k",
            ]
        )
        duration_ms = self._duration_ms(metadata, fallback_duration_ms=fallback_duration_ms)
        playback_path.parent.mkdir(parents=True, exist_ok=True)
        transcription_path.parent.mkdir(parents=True, exist_ok=True)
        playback_temp = playback_path.with_name(f".{playback_path.stem}.processing.mp4")
        transcription_temp = transcription_path.with_name(
            f".{transcription_path.stem}.processing.wav"
        )
        playback_temp.unlink(missing_ok=True)
        transcription_temp.unlink(missing_ok=True)

        try:
            self._run(
                [
                    self.ffmpeg_binary,
                    "-nostdin",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-y",
                    "-i",
                    str(original_path),
                    "-map",
                    "0:v:0",
                    "-map",
                    "0:a:0",
                    *video_options,
                    *audio_options,
                    "-movflags",
                    "+faststart",
                    str(playback_temp),
                ]
            )
            self._run(
                [
                    self.ffmpeg_binary,
                    "-nostdin",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-y",
                    "-i",
                    str(original_path),
                    "-map",
                    "0:a:0",
                    "-vn",
                    "-ac",
                    "1",
                    "-ar",
                    "16000",
                    "-c:a",
                    "pcm_s16le",
                    str(transcription_temp),
                ]
            )
            if playback_temp.stat().st_size == 0 or transcription_temp.stat().st_size == 0:
                raise MediaProcessingError("FFmpegが空の変換ファイルを生成しました")
            os.replace(playback_temp, playback_path)
            os.replace(transcription_temp, transcription_path)
        except Exception:
            playback_temp.unlink(missing_ok=True)
            transcription_temp.unlink(missing_ok=True)
            raise

        return ProcessedVideo(
            duration_ms=duration_ms,
            playback_size_bytes=playback_path.stat().st_size,
            transcription_size_bytes=transcription_path.stat().st_size,
        )

    def _probe(self, path: Path) -> dict[str, object]:
        completed = self._run(
            [
                self.ffprobe_binary,
                "-v",
                "error",
                "-show_entries",
                "format=duration:stream=codec_type,codec_name,pix_fmt,width,height,duration",
                "-of",
                "json",
                str(path),
            ]
        )
        try:
            data = json.loads(completed.stdout)
        except json.JSONDecodeError as exc:
            raise MediaProcessingError("動画メタデータを解析できませんでした") from exc
        if not isinstance(data, dict):
            raise MediaProcessingError("動画メタデータの形式が不正です")
        return data

    def _duration_ms(
        self,
        metadata: dict[str, object],
        *,
        fallback_duration_ms: int | None = None,
    ) -> int:
        format_data = metadata.get("format")
        candidates: list[object] = []
        if isinstance(format_data, dict):
            candidates.append(format_data.get("duration"))
        streams = metadata.get("streams")
        if isinstance(streams, list):
            candidates.extend(
                stream.get("duration") for stream in streams if isinstance(stream, dict)
            )

        for candidate in candidates:
            try:
                seconds = Decimal(str(candidate))
            except (InvalidOperation, ValueError):
                continue
            if seconds > 0:
                return int((seconds * 1000).quantize(Decimal("1"), ROUND_HALF_UP))
        if fallback_duration_ms is not None and fallback_duration_ms > 0:
            return fallback_duration_ms
        raise MediaProcessingError("動画の再生時間を取得できませんでした")

    @staticmethod
    def _run(arguments: list[str]) -> subprocess.CompletedProcess[str]:
        try:
            completed = subprocess.run(
                arguments,
                check=False,
                capture_output=True,
                text=True,
            )
        except OSError as exc:
            raise MediaProcessingError("FFmpegを起動できませんでした") from exc
        if completed.returncode != 0:
            lines = [line.strip() for line in completed.stderr.splitlines() if line.strip()]
            generic_messages = (
                "Nothing was written into output file",
                "Error opening output file",
                "Error opening output files",
                "Error sending frames to consumers",
                "Task finished with error code",
                "Terminating thread with return code",
                "Conversion failed",
            )
            detail = next(
                (
                    line
                    for line in lines
                    if not any(message in line for message in generic_messages)
                ),
                lines[-1] if lines else "unknown",
            )
            raise MediaProcessingError(f"FFmpeg処理に失敗しました: {detail[:500]}")
        return completed
