from pathlib import Path
from subprocess import CompletedProcess

from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from app.models.job import Job, JobType
from app.models.media import Media, MediaKind
from app.models.meeting import Meeting, MeetingSourceType, MeetingStatus
from app.services.media import (
    FFmpegLiveRecordingAssembler,
    FFmpegMediaService,
    LiveVideoPartInput,
    MediaStorage,
    ProcessedVideo,
    process_video_job,
)
from app.services.realtime import (
    append_realtime_chunk,
    append_realtime_video_chunk,
    finalize_realtime_session,
    finish_realtime_video_part,
    start_realtime_session,
    start_realtime_video_part,
)


class FakeMediaService:
    fallback_duration_ms: int | None = None

    def process_video(
        self,
        _original_path: Path,
        playback_path: Path,
        transcription_path: Path,
        *,
        fallback_duration_ms: int | None = None,
    ) -> ProcessedVideo:
        self.fallback_duration_ms = fallback_duration_ms
        playback_path.parent.mkdir(parents=True, exist_ok=True)
        playback_path.write_bytes(b"playback")
        transcription_path.write_bytes(b"wave")
        return ProcessedVideo(
            duration_ms=12_345,
            playback_size_bytes=len(b"playback"),
            transcription_size_bytes=len(b"wave"),
        )


def test_video_processor_creates_derived_media_and_transcription_job(
    session_factory: sessionmaker[Session],
    tmp_path: Path,
) -> None:
    storage = MediaStorage(tmp_path, 1, 1)
    with session_factory() as session:
        meeting = Meeting(title="Video", source_type=MeetingSourceType.VIDEO_UPLOAD)
        session.add(meeting)
        session.flush()
        original_path = f"meetings/{meeting.id}/original/source.mp4"
        source = storage.absolute_path(original_path)
        source.parent.mkdir(parents=True)
        source.write_bytes(b"original")
        original = Media(
            meeting_id=meeting.id,
            kind=MediaKind.ORIGINAL_VIDEO,
            storage_path=original_path,
            mime_type="video/mp4",
            size_bytes=len(b"original"),
        )
        job = Job(meeting_id=meeting.id, type=JobType.PREPROCESS_MEDIA)
        session.add_all([original, job])
        session.commit()

        media_service = FakeMediaService()
        process_video_job(session, job, media_service, storage)  # type: ignore[arg-type]

        session.refresh(meeting)
        derived = list(
            session.scalars(
                select(Media)
                .where(Media.meeting_id == meeting.id, Media.kind != MediaKind.ORIGINAL_VIDEO)
                .order_by(Media.kind)
            )
        )
        transcription_job = session.scalar(
            select(Job).where(
                Job.meeting_id == meeting.id,
                Job.type == JobType.TRANSCRIBE,
            )
        )

        assert meeting.status == MeetingStatus.QUEUED
        assert media_service.fallback_duration_ms is None
        assert meeting.duration_ms == 12_345
        assert original.duration_ms == 12_345
        assert {item.kind for item in derived} == {
            MediaKind.PLAYBACK_VIDEO,
            MediaKind.TRANSCRIPTION_AUDIO,
        }
        assert all(item.duration_ms == 12_345 for item in derived)
        assert transcription_job is not None
        assert transcription_job.progress == 0
        assert (
            storage.absolute_path(
                next(item.storage_path for item in derived if item.kind == MediaKind.PLAYBACK_VIDEO)
            ).read_bytes()
            == b"playback"
        )


def test_live_video_processor_passes_recorded_duration_as_fallback(
    session_factory: sessionmaker[Session],
    tmp_path: Path,
) -> None:
    storage = MediaStorage(tmp_path, 1, 1)
    with session_factory() as session:
        meeting = Meeting(
            title="Live",
            source_type=MeetingSourceType.LIVE,
            duration_ms=67_215,
        )
        session.add(meeting)
        session.flush()
        original_path = f"meetings/{meeting.id}/original/source.webm"
        source = storage.absolute_path(original_path)
        source.parent.mkdir(parents=True)
        source.write_bytes(b"streaming-webm")
        session.add_all(
            [
                Media(
                    meeting_id=meeting.id,
                    kind=MediaKind.ORIGINAL_VIDEO,
                    storage_path=original_path,
                    mime_type="video/webm",
                    size_bytes=len(b"streaming-webm"),
                    duration_ms=67_215,
                ),
                Job(meeting_id=meeting.id, type=JobType.PREPROCESS_MEDIA),
            ]
        )
        session.commit()

        media_service = FakeMediaService()
        job = session.scalar(
            select(Job).where(
                Job.meeting_id == meeting.id,
                Job.type == JobType.PREPROCESS_MEDIA,
            )
        )
        assert job is not None
        process_video_job(session, job, media_service, storage)  # type: ignore[arg-type]

        assert media_service.fallback_duration_ms == 67_215
        assert meeting.status == MeetingStatus.COMPLETED
        transcription_job = session.scalar(
            select(Job).where(
                Job.meeting_id == meeting.id,
                Job.type == JobType.TRANSCRIBE,
            )
        )
        assert transcription_job is None


def test_ffmpeg_duration_uses_recorded_fallback_when_metadata_has_no_duration() -> None:
    service = FFmpegMediaService()

    duration_ms = service._duration_ms(
        {"streams": [{"codec_type": "video"}, {"codec_type": "audio"}]},
        fallback_duration_ms=67_215,
    )

    assert duration_ms == 67_215


class RecordingFFmpegMediaService(FFmpegMediaService):
    def __init__(self) -> None:
        super().__init__()
        self.commands: list[list[str]] = []

    def _probe(self, _path: Path) -> dict[str, object]:
        return {
            "format": {"duration": "1.0"},
            "streams": [{"codec_type": "video"}, {"codec_type": "audio"}],
        }

    def _run(self, arguments: list[str]) -> CompletedProcess[str]:
        self.commands.append(arguments)
        output_path = Path(arguments[-1])
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_bytes(b"converted")
        return CompletedProcess(arguments, 0, "", "")


def test_ffmpeg_pads_odd_video_dimensions_before_h264_encoding(tmp_path: Path) -> None:
    service = RecordingFFmpegMediaService()
    original_path = tmp_path / "source.webm"
    original_path.write_bytes(b"webm")

    service.process_video(
        original_path,
        tmp_path / "playback.mp4",
        tmp_path / "transcription.wav",
    )

    playback_command = service.commands[0]
    filter_index = playback_command.index("-vf")
    assert playback_command[filter_index + 1] == "pad=ceil(iw/2)*2:ceil(ih/2)*2"
    assert playback_command[playback_command.index("-crf") + 1] == "18"


class RecordingLiveAssembler(FFmpegLiveRecordingAssembler):
    def __init__(self) -> None:
        super().__init__()
        self.commands: list[list[str]] = []

    def _canvas_size(self, parts: list[LiveVideoPartInput]) -> tuple[int, int]:
        return 1920, 1080

    def _run(self, arguments: list[str]) -> CompletedProcess[str]:
        self.commands.append(arguments)
        output_path = Path(arguments[-1])
        output_path.write_bytes(b"assembled")
        return CompletedProcess(arguments, 0, "", "")


def test_compatible_h264_is_copied_without_quality_loss(tmp_path: Path) -> None:
    service = RecordingFFmpegMediaService()
    service._probe = lambda path: {  # type: ignore[method-assign]
        "format": {"duration": "1"},
        "streams": [
            {"codec_type": "video", "codec_name": "h264", "pix_fmt": "yuv420p"},
            {"codec_type": "audio", "codec_name": "aac"},
        ],
    }
    service.process_video(tmp_path / "source.mp4", tmp_path / "out.mp4", tmp_path / "audio.wav")
    command = service.commands[0]
    assert command[command.index("-c:v") + 1] == "copy"
    assert command[command.index("-c:a") + 1] == "copy"
    assert "-vf" not in command
    assert command[command.index("-movflags") + 1] == "+faststart"


def test_live_canvas_preserves_source_aspect_and_4k_resolution() -> None:
    assembler = FFmpegLiveRecordingAssembler()
    sizes = {"square": (1440, 1440), "4k": (3840, 2160), "odd": (1279, 719)}
    assembler.probe_service._probe = lambda path: {  # type: ignore[method-assign]
        "streams": [
            {"codec_type": "video", "width": sizes[path.name][0], "height": sizes[path.name][1]}
        ],
    }

    def part(name: str) -> LiveVideoPartInput:
        return LiveVideoPartInput(Path(name), 0, 1000)

    assert assembler._canvas_size([part("square")]) == (1440, 1440)
    assert assembler._canvas_size([part("square"), part("4k")]) == (3840, 2160)
    assert assembler._canvas_size([part("odd")]) == (1278, 718)


def test_live_recording_assembler_places_parts_on_continuous_timeline(tmp_path: Path) -> None:
    first = tmp_path / "first.webm"
    second = tmp_path / "second.webm"
    audio = tmp_path / "audio.webm"
    output = tmp_path / "output.mp4"
    first.write_bytes(b"video-1")
    second.write_bytes(b"video-2")
    audio.write_bytes(b"audio")
    assembler = RecordingLiveAssembler()

    size = assembler.assemble(
        [
            LiveVideoPartInput(first, 0, 10_000),
            LiveVideoPartInput(second, 15_000, 30_000),
        ],
        audio,
        output,
        duration_ms=30_000,
    )

    command = assembler.commands[0]
    filter_graph = command[command.index("-filter_complex") + 1]
    assert "color=c=black:s=1920x1080:r=30:d=30.000" in command
    assert "setpts=PTS-STARTPTS+0.000/TB" in filter_graph
    assert "setpts=PTS-STARTPTS+15.000/TB" in filter_graph
    assert "overlay=eof_action=pass:shortest=0" in filter_graph
    assert command[command.index("-map") + 1] == "[video]"
    assert output.read_bytes() == b"assembled"
    assert size == len(b"assembled")


def test_split_live_video_processor_assembles_before_normal_processing(
    session_factory: sessionmaker[Session],
    tmp_path: Path,
) -> None:
    storage = MediaStorage(tmp_path, 10, 10)
    with session_factory() as session:
        meeting = Meeting(title="Split live", source_type=MeetingSourceType.LIVE)
        session.add(meeting)
        session.commit()
        realtime_session = start_realtime_session(
            session,
            meeting,
            storage,
            mime_type="video/webm;codecs=vp8",
            audio_mime_type="audio/webm;codecs=opus",
            has_system_audio=True,
            model="large-v3",
            language="ja",
            split_capture=True,
        )
        append_realtime_chunk(
            session,
            realtime_session,
            storage,
            sequence=0,
            start_ms=0,
            end_ms=10_000,
            content=b"audio",
            window_ms=30_000,
            step_ms=15_000,
            max_chunk_bytes=1024,
        )
        part = start_realtime_video_part(
            session,
            realtime_session,
            storage,
            sequence=0,
            start_ms=0,
            mime_type="video/webm;codecs=vp8",
        )
        append_realtime_video_chunk(
            session,
            realtime_session,
            part,
            storage,
            sequence=0,
            content=b"video",
            max_chunk_bytes=1024,
        )
        finish_realtime_video_part(session, realtime_session, part, end_ms=10_000)
        job = finalize_realtime_session(session, realtime_session)
        media_service = FakeMediaService()
        assembler = RecordingLiveAssembler()

        process_video_job(
            session,
            job,
            media_service,  # type: ignore[arg-type]
            storage,
            assembler,
        )

        original = session.scalar(
            select(Media).where(
                Media.meeting_id == meeting.id,
                Media.kind == MediaKind.ORIGINAL_VIDEO,
            )
        )
        assert original is not None
        assert original.mime_type == "video/mp4"
        assert original.size_bytes == len(b"assembled")
        assert storage.absolute_path(original.storage_path).read_bytes() == b"assembled"
        assert media_service.fallback_duration_ms == 10_000
        assert meeting.status == MeetingStatus.COMPLETED
