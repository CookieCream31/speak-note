import os
import subprocess
from dataclasses import dataclass
from pathlib import Path
from subprocess import CompletedProcess

from app.services.media.ffmpeg import FFmpegMediaService, MediaProcessingError


@dataclass(frozen=True)
class LiveVideoPartInput:
    path: Path
    start_ms: int
    end_ms: int


class FFmpegLiveRecordingAssembler:
    def __init__(self, ffmpeg_binary: str = "ffmpeg", ffprobe_binary: str = "ffprobe") -> None:
        self.ffmpeg_binary = ffmpeg_binary
        self.probe_service = FFmpegMediaService(ffmpeg_binary, ffprobe_binary)

    def _canvas_size(self, parts: list[LiveVideoPartInput]) -> tuple[int, int]:
        sizes: list[tuple[int, int]] = []
        for part in parts:
            streams = self.probe_service._probe(part.path).get("streams")
            if not isinstance(streams, list):
                raise MediaProcessingError("録画映像のサイズを取得できませんでした")
            video: dict[str, object] = next(
                (
                    stream
                    for stream in streams
                    if isinstance(stream, dict) and stream.get("codec_type") == "video"
                ),
                {},
            )
            width, height = video.get("width"), video.get("height")
            if not isinstance(width, int) or not isinstance(height, int) or min(width, height) <= 0:
                raise MediaProcessingError("録画映像のサイズが不正です")
            sizes.append((width, height))
        width, height = max(sizes, key=lambda size: size[0] * size[1])
        ratio = min(1.0, 3840 / width, 2160 / height)
        return max(2, int(width * ratio) // 2 * 2), max(2, int(height * ratio) // 2 * 2)

    def _run(self, arguments: list[str]) -> CompletedProcess[str]:
        return subprocess.run(
            arguments,
            check=False,
            capture_output=True,
            text=True,
        )

    def assemble(
        self,
        parts: list[LiveVideoPartInput],
        audio_path: Path,
        output_path: Path,
        *,
        duration_ms: int,
    ) -> int:
        if duration_ms <= 0:
            raise MediaProcessingError("録画時間が不正です")
        ordered_parts = sorted(parts, key=lambda part: (part.start_ms, part.end_ms))
        if not ordered_parts:
            raise MediaProcessingError("録画映像Partがありません")
        if not audio_path.is_file() or audio_path.stat().st_size <= 0:
            raise MediaProcessingError("録音データがありません")
        for part in ordered_parts:
            if part.start_ms < 0 or part.end_ms <= part.start_ms:
                raise MediaProcessingError("録画映像Partの時刻が不正です")
            if part.start_ms >= duration_ms:
                raise MediaProcessingError("録画映像Partの開始時刻が録画時間を超えています")
            if not part.path.is_file() or part.path.stat().st_size <= 0:
                raise MediaProcessingError("録画映像Partが空です")

        width, height = self._canvas_size(ordered_parts)
        duration_seconds = duration_ms / 1000
        arguments = [
            self.ffmpeg_binary,
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"color=c=black:s={width}x{height}:r=30:d={duration_seconds:.3f}",
        ]
        for part in ordered_parts:
            arguments.extend(["-i", str(part.path)])
        audio_input_index = len(ordered_parts) + 1
        arguments.extend(["-i", str(audio_path)])

        filters: list[str] = []
        previous_label = "0:v:0"
        for index, part in enumerate(ordered_parts, start=1):
            part_duration_seconds = min(duration_ms, part.end_ms) / 1000 - part.start_ms / 1000
            start_seconds = part.start_ms / 1000
            normalized_label = f"part{index}"
            output_label = f"composite{index}"
            filters.append(
                f"[{index}:v:0]"
                f"scale={width}:{height}:force_original_aspect_ratio=decrease:force_divisible_by=2,"
                f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black,"
                "setsar=1,fps=30,"
                f"trim=duration={part_duration_seconds:.3f},"
                f"settb=AVTB,setpts=PTS-STARTPTS+{start_seconds:.3f}/TB"
                f"[{normalized_label}]"
            )
            filters.append(
                f"[{previous_label}][{normalized_label}]"
                f"overlay=eof_action=pass:shortest=0[{output_label}]"
            )
            previous_label = output_label
        filters.append(f"[{previous_label}]format=yuv420p[video]")

        output_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = output_path.with_name(f".{output_path.stem}.assembling.mp4")
        temporary.unlink(missing_ok=True)
        arguments.extend(
            [
                "-filter_complex",
                ";".join(filters),
                "-map",
                "[video]",
                "-map",
                f"{audio_input_index}:a:0",
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-crf",
                "18",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-b:a",
                "192k",
                "-af",
                "apad",
                "-t",
                f"{duration_seconds:.3f}",
                "-movflags",
                "+faststart",
                str(temporary),
            ]
        )
        try:
            completed = self._run(arguments)
        except OSError as exc:
            raise MediaProcessingError("FFmpegを起動できませんでした") from exc
        if completed.returncode != 0:
            temporary.unlink(missing_ok=True)
            detail = (
                completed.stderr.strip().splitlines()[-1] if completed.stderr.strip() else "unknown"
            )
            raise MediaProcessingError(f"画面共有録画の結合に失敗しました: {detail[:1000]}")
        if not temporary.is_file() or temporary.stat().st_size <= 0:
            temporary.unlink(missing_ok=True)
            raise MediaProcessingError("画面共有録画の結合結果が空です")
        os.replace(temporary, output_path)
        return output_path.stat().st_size
