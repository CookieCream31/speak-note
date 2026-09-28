import subprocess
from pathlib import Path

from app.services.media.ffmpeg import MediaProcessingError


class RealtimeWindowMediaService:
    def __init__(self, ffmpeg_binary: str = "ffmpeg") -> None:
        self.ffmpeg_binary = ffmpeg_binary

    def extract_audio_window(
        self,
        source_path: Path,
        output_path: Path,
        *,
        start_ms: int,
        end_ms: int,
    ) -> None:
        if start_ms < 0 or end_ms <= start_ms:
            raise MediaProcessingError("Realtime Windowの時刻が不正です")
        output_path.parent.mkdir(parents=True, exist_ok=True)
        arguments = [
            self.ffmpeg_binary,
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            str(source_path),
            "-ss",
            f"{start_ms / 1000:.3f}",
            "-t",
            f"{(end_ms - start_ms) / 1000:.3f}",
            "-map",
            "0:a:0",
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "pcm_s16le",
            str(output_path),
        ]
        try:
            completed = subprocess.run(arguments, check=False, capture_output=True, text=True)
        except OSError as exc:
            raise MediaProcessingError("FFmpegを起動できませんでした") from exc
        if completed.returncode != 0:
            detail = (
                completed.stderr.strip().splitlines()[-1] if completed.stderr.strip() else "unknown"
            )
            raise MediaProcessingError(f"Realtime音声の抽出に失敗しました: {detail[:500]}")
        if not output_path.exists() or output_path.stat().st_size == 0:
            raise MediaProcessingError("Realtime音声が空です")
