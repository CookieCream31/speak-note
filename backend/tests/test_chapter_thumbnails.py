import uuid
from pathlib import Path
from subprocess import CompletedProcess

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session, sessionmaker

from app.api.dependencies import get_storage
from app.main import app
from app.models.analysis import AnalysisItem, AnalysisItemKind, AnalysisStatus, AnalysisVersion
from app.models.job import Job, JobStatus, JobType
from app.models.media import Media, MediaKind
from app.models.meeting import Meeting, MeetingSourceType, MeetingStatus
from app.models.realtime import RealtimeSession, RealtimeSessionStatus
from app.models.transcript import (
    TranscriptKind,
    TranscriptSegment,
    TranscriptStatus,
    TranscriptVersion,
)
from app.services.jobs import fail_job, finish_job, recover_interrupted_jobs
from app.services.media import FFmpegMediaService, MediaProcessingError, MediaStorage
from app.services.media.thumbnails import (
    enqueue_chapter_thumbnails,
    process_thumbnail_job,
    thumbnail_storage_path,
)


class Frames(FFmpegMediaService):
    def __init__(self, fail_at: int | None = None) -> None:
        self.calls: list[int] = []
        self.fail_at = fail_at

    def create_thumbnail(self, source: Path, destination: Path, timestamp_ms: int) -> None:
        assert source.read_bytes() == b"video"
        self.calls.append(timestamp_ms)
        if timestamp_ms == self.fail_at:
            raise MediaProcessingError("FFmpeg unavailable")
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(f"frame-{timestamp_ms}".encode())


@pytest.fixture
def saved_video(
    client: TestClient,
    session_factory: sessionmaker[Session],
    tmp_path: Path,
) -> tuple[Meeting, Media, AnalysisVersion, MediaStorage]:
    storage = MediaStorage(tmp_path, 1)
    app.dependency_overrides[get_storage] = lambda: storage
    with session_factory() as session:
        meeting = Meeting(
            title="Chapters",
            source_type=MeetingSourceType.VIDEO_UPLOAD,
            status=MeetingStatus.COMPLETED,
            duration_ms=10_000,
        )
        session.add(meeting)
        session.flush()
        transcript = TranscriptVersion(
            meeting_id=meeting.id,
            version=1,
            kind=TranscriptKind.FINAL,
            status=TranscriptStatus.COMPLETED,
            language="ja",
            model="test",
            diarization_enabled=True,
        )
        video = Media(
            meeting_id=meeting.id,
            kind=MediaKind.PLAYBACK_VIDEO,
            storage_path=f"meetings/{meeting.id}/derived/playback.mp4",
            mime_type="video/mp4",
            size_bytes=5,
            duration_ms=10_000,
        )
        session.add_all([transcript, video])
        session.flush()
        analysis = AnalysisVersion(
            meeting_id=meeting.id,
            transcript_version_id=transcript.id,
            version=1,
            model="test",
            temperature=0,
            prompt_version="test",
            status=AnalysisStatus.COMPLETED,
        )
        session.add(analysis)
        session.flush()
        analysis.items = [
            AnalysisItem(
                kind=AnalysisItemKind.CHAPTER,
                sequence=0,
                content="First",
                start_ms=1500,
                end_ms=7000,
            ),
            AnalysisItem(
                kind=AnalysisItemKind.CHAPTER,
                sequence=1,
                content="Second",
                start_ms=7000,
                end_ms=10_000,
            ),
        ]
        meeting.active_analysis_version_id = analysis.id
        session.commit()
        source = storage.absolute_path(video.storage_path)
        source.parent.mkdir(parents=True)
        source.write_bytes(b"video")
    return meeting, video, analysis, storage


def endpoint(saved_video: tuple[Meeting, Media, AnalysisVersion, MediaStorage]) -> str:
    meeting, _, analysis, _ = saved_video
    return f"/api/v1/meetings/{meeting.id}/analyses/{analysis.id}/chapter-thumbnails"


def test_browsing_is_read_only_and_ensure_deduplicates_jobs(
    client: TestClient,
    session_factory: sessionmaker[Session],
    saved_video: tuple[Meeting, Media, AnalysisVersion, MediaStorage],
) -> None:
    assert client.get(endpoint(saved_video)).json()["status"] == "missing"
    with session_factory() as session:
        assert session.scalar(select(func.count()).select_from(Job)) == 0
    first = client.post(endpoint(saved_video)).json()
    assert first["status"] == "queued"
    assert first["thumbnails"][0]["url"] is None
    for _ in range(3):
        assert client.post(endpoint(saved_video)).json()["job"]["id"] == first["job"]["id"]
    with session_factory() as session:
        job = session.get(Job, uuid.UUID(first["job"]["id"]))
        assert job is not None
        job.status = JobStatus.RUNNING
        session.commit()
    assert client.post(endpoint(saved_video)).json()["status"] == "running"
    with session_factory() as session:
        assert session.scalar(select(func.count()).select_from(Job)) == 1


def test_worker_generates_frames_reuses_files_and_serves_scoped_images(
    client: TestClient,
    session_factory: sessionmaker[Session],
    saved_video: tuple[Meeting, Media, AnalysisVersion, MediaStorage],
) -> None:
    meeting, video, analysis, storage = saved_video
    result = client.post(endpoint(saved_video)).json()
    frames = Frames()
    with session_factory() as session:
        job = session.get(Job, uuid.UUID(result["job"]["id"]))
        assert job is not None
        process_thumbnail_job(session, job, frames, storage)
        finish_job(session, job)
        process_thumbnail_job(session, job, frames, storage)
        assert session.get(Meeting, meeting.id).status == MeetingStatus.COMPLETED  # type: ignore[union-attr]
        assert session.get(AnalysisVersion, analysis.id).status == AnalysisStatus.COMPLETED  # type: ignore[union-attr]
    assert frames.calls == [1500, 7000]
    ready = client.post(endpoint(saved_video)).json()
    assert ready["status"] == "completed"
    image = client.get(ready["thumbnails"][0]["url"])
    assert image.status_code == 200
    assert image.content == b"frame-1500"
    assert image.headers["content-type"] == "image/jpeg"
    assert "private" in image.headers["cache-control"]
    assert (
        client.get(f"/api/v1/meetings/{meeting.id}/chapter-thumbnails/{video.id}/-1").status_code
        == 422
    )
    assert (
        client.get(f"/api/v1/meetings/{meeting.id}/chapter-thumbnails/{video.id}/999").status_code
        == 404
    )
    with session_factory() as session:
        other = Meeting(title="Other", source_type=MeetingSourceType.VIDEO_UPLOAD)
        session.add(other)
        session.commit()
        other_id = other.id
        assert session.scalar(select(func.count()).select_from(Job)) == 1
    assert (
        client.get(f"/api/v1/meetings/{other_id}/chapter-thumbnails/{video.id}/1500").status_code
        == 404
    )
    assert (
        client.post(
            f"/api/v1/meetings/{other_id}/analyses/{analysis.id}/chapter-thumbnails"
        ).status_code
        == 404
    )


@pytest.mark.parametrize(
    "blocked", ["recording", "finalizing", "conversion", "audio", "no_chapters"]
)
def test_no_work_for_audio_empty_chapters_or_unfinished_capture(
    blocked: str,
    client: TestClient,
    session_factory: sessionmaker[Session],
    saved_video: tuple[Meeting, Media, AnalysisVersion, MediaStorage],
) -> None:
    meeting, video, analysis, _ = saved_video
    with session_factory() as session:
        if blocked in {"recording", "finalizing"}:
            session.add(
                RealtimeSession(
                    meeting_id=meeting.id,
                    media_id=video.id,
                    transcript_version_id=analysis.transcript_version_id,
                    status=RealtimeSessionStatus(blocked),
                    mime_type="video/webm",
                )
            )
        elif blocked == "conversion":
            session.add(Job(meeting_id=meeting.id, type=JobType.PREPROCESS_MEDIA))
        elif blocked == "audio":
            stored = session.get(Media, video.id)
            assert stored is not None
            stored.kind = MediaKind.ORIGINAL_AUDIO
        else:
            stored_analysis = session.get(AnalysisVersion, analysis.id)
            assert stored_analysis is not None
            stored_analysis.items.clear()
        session.commit()
    response = client.post(endpoint(saved_video))
    assert response.status_code == 200
    assert response.json()["status"] == "unavailable"
    with session_factory() as session:
        assert (
            session.scalar(
                select(func.count()).select_from(Job).where(Job.type == JobType.GENERATE_THUMBNAILS)
            )
            == 0
        )


def test_failure_keeps_results_and_frames_and_explicit_retry_skips_finished_frames(
    client: TestClient,
    session_factory: sessionmaker[Session],
    saved_video: tuple[Meeting, Media, AnalysisVersion, MediaStorage],
) -> None:
    meeting, video, analysis, storage = saved_video
    job_id = client.post(endpoint(saved_video)).json()["job"]["id"]
    with session_factory() as session:
        job = session.get(Job, uuid.UUID(job_id))
        assert job is not None
        with pytest.raises(MediaProcessingError):
            process_thumbnail_job(session, job, Frames(fail_at=7000), storage)
        fail_job(session, job, "FFmpeg unavailable")
        assert session.get(Meeting, meeting.id).status == MeetingStatus.COMPLETED  # type: ignore[union-attr]
        assert session.get(AnalysisVersion, analysis.id).items[0].content == "First"  # type: ignore[union-attr]
    failed = client.post(endpoint(saved_video)).json()
    assert failed["status"] == "failed"
    assert failed["job"]["id"] == job_id
    assert failed["thumbnails"][0]["url"] is not None
    assert (
        storage.absolute_path(thumbnail_storage_path(meeting.id, video.id, 1500)).read_bytes()
        == b"frame-1500"
    )
    assert client.post(f"/api/v1/jobs/{job_id}/retry").status_code == 200
    assert client.post(f"/api/v1/jobs/{job_id}/retry").status_code == 409
    frames = Frames()
    with session_factory() as session:
        job = session.get(Job, uuid.UUID(job_id))
        assert job is not None
        process_thumbnail_job(session, job, frames, storage)
        finish_job(session, job)
        assert session.get(Meeting, meeting.id).status == MeetingStatus.COMPLETED  # type: ignore[union-attr]
        assert session.scalar(select(func.count()).select_from(Job)) == 1
    assert frames.calls == [7000]


def test_history_and_new_chapters_use_their_own_timestamps_and_reuse_matching_frames(
    client: TestClient,
    session_factory: sessionmaker[Session],
    saved_video: tuple[Meeting, Media, AnalysisVersion, MediaStorage],
) -> None:
    meeting, _, old, storage = saved_video
    job_id = client.post(endpoint(saved_video)).json()["job"]["id"]
    with session_factory() as session:
        new = AnalysisVersion(
            meeting_id=meeting.id,
            transcript_version_id=old.transcript_version_id,
            version=2,
            model="new",
            temperature=0,
            prompt_version="test",
            status=AnalysisStatus.COMPLETED,
        )
        new.items = [
            AnalysisItem(kind=AnalysisItemKind.CHAPTER, sequence=0, content="New", start_ms=1500),
            AnalysisItem(kind=AnalysisItemKind.CHAPTER, sequence=1, content="Added", start_ms=8500),
        ]
        session.add(new)
        session.commit()
        new_id = new.id
        frames = Frames()
        job = session.get(Job, uuid.UUID(job_id))
        assert job is not None
        process_thumbnail_job(session, job, frames, storage)
        finish_job(session, job)
        assert frames.calls == [1500, 7000, 8500]
    new_path = f"/api/v1/meetings/{meeting.id}/analyses/{new_id}/chapter-thumbnails"
    old_result = client.get(endpoint(saved_video)).json()
    new_result = client.get(new_path).json()
    assert [item["start_ms"] for item in old_result["thumbnails"]] == [1500, 7000]
    assert [item["start_ms"] for item in new_result["thumbnails"]] == [1500, 8500]
    assert old_result["thumbnails"][0]["url"] == new_result["thumbnails"][0]["url"]
    with session_factory() as session:
        item = session.scalar(
            select(AnalysisItem).where(
                AnalysisItem.analysis_version_id == new_id, AnalysisItem.sequence == 0
            )
        )
        assert item is not None
        item.start_ms = 2000
        session.commit()
    assert client.get(new_path).json()["thumbnails"][0]["url"] is None
    assert client.get(endpoint(saved_video)).json() == old_result
    assert client.post(new_path).json()["status"] == "queued"


def test_new_chapter_after_running_job_requires_a_followup(
    client: TestClient,
    session_factory: sessionmaker[Session],
    saved_video: tuple[Meeting, Media, AnalysisVersion, MediaStorage],
) -> None:
    meeting, _, analysis, storage = saved_video
    first = client.post(endpoint(saved_video)).json()["job"]["id"]
    with session_factory() as session:
        job = session.get(Job, uuid.UUID(first))
        assert job is not None
        process_thumbnail_job(session, job, Frames(), storage)
        session.add(
            AnalysisItem(
                analysis_version_id=analysis.id,
                kind=AnalysisItemKind.CHAPTER,
                sequence=2,
                content="Later",
                start_ms=9000,
            )
        )
        session.commit()
        assert (
            enqueue_chapter_thumbnails(session, session.get(Meeting, meeting.id), storage).id
            == job.id
        )  # type: ignore[arg-type,union-attr]
        finish_job(session, job)
    assert client.get(endpoint(saved_video)).json()["status"] == "missing"
    next_job = client.post(endpoint(saved_video)).json()["job"]["id"]
    assert next_job != first


@pytest.mark.parametrize("trigger", [JobType.PREPROCESS_MEDIA, JobType.ANALYZE])
def test_completed_analysis_or_conversion_automatically_reserves_thumbnails(
    trigger: JobType,
    session_factory: sessionmaker[Session],
    saved_video: tuple[Meeting, Media, AnalysisVersion, MediaStorage],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.core.config import get_settings
    from app.services.media import thumbnails

    meeting, _, _, storage = saved_video
    monkeypatch.setattr(
        thumbnails,
        "get_settings",
        lambda: get_settings().model_copy(update={"storage_root": storage.root}),
    )
    with session_factory() as session:
        job = Job(meeting_id=meeting.id, type=trigger, status=JobStatus.RUNNING)
        session.add(job)
        session.commit()
        finish_job(session, job)
        scheduled = session.scalar(select(Job).where(Job.type == JobType.GENERATE_THUMBNAILS))
        assert scheduled is not None and scheduled.status == JobStatus.QUEUED


def test_worker_dispatch_and_interrupted_recovery(
    session_factory: sessionmaker[Session],
    saved_video: tuple[Meeting, Media, AnalysisVersion, MediaStorage],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.workers import main

    meeting, _, _, storage = saved_video
    frames = Frames()
    monkeypatch.setattr(main, "MediaStorage", lambda *_args: storage)
    monkeypatch.setattr(main, "FFmpegMediaService", lambda: frames)
    with session_factory() as session:
        job = enqueue_chapter_thumbnails(session, session.get(Meeting, meeting.id), storage)  # type: ignore[arg-type]
        assert job is not None
        job.status = JobStatus.RUNNING
        session.commit()
        assert recover_interrupted_jobs(session) == 1
        main.process_job(session, job)
        finish_job(session, job)
        assert frames.calls == [1500, 7000]
        assert job.status == JobStatus.COMPLETED


def test_manual_chapters_automatically_reserve_frames(
    session_factory: sessionmaker[Session],
    saved_video: tuple[Meeting, Media, AnalysisVersion, MediaStorage],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.core.config import get_settings
    from app.schemas.analysis import ChapterOutput, StructuredMinutesOutput
    from app.services.analysis.manual import save_manual_analysis
    from app.services.media import thumbnails

    meeting, _, analysis, storage = saved_video
    monkeypatch.setattr(
        thumbnails,
        "get_settings",
        lambda: get_settings().model_copy(update={"storage_root": storage.root}),
    )
    with session_factory() as session:
        transcript = session.get(TranscriptVersion, analysis.transcript_version_id)
        stored_meeting = session.get(Meeting, meeting.id)
        assert transcript is not None and stored_meeting is not None
        segment = TranscriptSegment(
            transcript_version_id=transcript.id,
            sequence=0,
            start_ms=2000,
            end_ms=6000,
            text="Manual chapter",
        )
        session.add(segment)
        session.commit()
        result = StructuredMinutesOutput(
            summary="Imported",
            summary_evidence_segment_ids=[segment.id],
            chapters=[
                ChapterOutput(
                    title="Manual", start_ms=2000, end_ms=6000, evidence_segment_ids=[segment.id]
                )
            ],
        )
        saved = save_manual_analysis(session, stored_meeting, transcript, result)
        assert saved.status == AnalysisStatus.COMPLETED
        assert (
            session.scalar(select(Job).where(Job.type == JobType.GENERATE_THUMBNAILS)) is not None
        )


def test_out_of_duration_chapters_are_skipped_without_inventing_a_frame(
    client: TestClient,
    session_factory: sessionmaker[Session],
    saved_video: tuple[Meeting, Media, AnalysisVersion, MediaStorage],
) -> None:
    _, _, analysis, storage = saved_video
    with session_factory() as session:
        session.add(
            AnalysisItem(
                analysis_version_id=analysis.id,
                kind=AnalysisItemKind.CHAPTER,
                sequence=2,
                content="Outside",
                start_ms=10_000,
            )
        )
        session.commit()
    result = client.post(endpoint(saved_video)).json()
    assert [item["start_ms"] for item in result["thumbnails"]] == [1500, 7000]
    with session_factory() as session:
        job = session.get(Job, uuid.UUID(result["job"]["id"]))
        assert job is not None
        frames = Frames()
        process_thumbnail_job(session, job, frames, storage)
        assert frames.calls == [1500, 7000]


def test_worker_and_retry_reject_recording_started_after_enqueue(
    client: TestClient,
    session_factory: sessionmaker[Session],
    saved_video: tuple[Meeting, Media, AnalysisVersion, MediaStorage],
) -> None:
    meeting, _, _, storage = saved_video
    job_id = client.post(endpoint(saved_video)).json()["job"]["id"]
    with session_factory() as session:
        stored = session.get(Meeting, meeting.id)
        job = session.get(Job, uuid.UUID(job_id))
        assert stored is not None and job is not None
        stored.status = MeetingStatus.RECORDING
        session.commit()
        frames = Frames()
        with pytest.raises(RuntimeError, match="録音・録画"):
            process_thumbnail_job(session, job, frames, storage)
        assert frames.calls == []
        fail_job(session, job, "recording")
        assert stored.status == MeetingStatus.RECORDING
    assert client.post(f"/api/v1/jobs/{job_id}/retry").status_code == 409


def test_retrying_an_older_failure_cannot_duplicate_active_work(
    client: TestClient,
    session_factory: sessionmaker[Session],
    saved_video: tuple[Meeting, Media, AnalysisVersion, MediaStorage],
) -> None:
    meeting, _, _, _ = saved_video
    active_id = client.post(endpoint(saved_video)).json()["job"]["id"]
    with session_factory() as session:
        failed = Job(
            meeting_id=meeting.id, type=JobType.GENERATE_THUMBNAILS, status=JobStatus.FAILED
        )
        session.add(failed)
        session.commit()
        failed_id = failed.id
    assert client.post(f"/api/v1/jobs/{failed_id}/retry").status_code == 409
    assert client.post(endpoint(saved_video)).json()["job"]["id"] == active_id


@pytest.mark.parametrize("empty", [False, True])
def test_ffmpeg_frame_failure_never_replaces_an_existing_image(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    empty: bool,
) -> None:
    service = FFmpegMediaService()
    destination = tmp_path / "1500.jpg"
    destination.write_bytes(b"previous")

    def run(arguments: list[str]) -> CompletedProcess[str]:
        Path(arguments[-1]).write_bytes(b"" if empty else b"partial")
        if not empty:
            raise MediaProcessingError("decode failed")
        return CompletedProcess(arguments, 0, "", "")

    monkeypatch.setattr(service, "_run", run)
    with pytest.raises(MediaProcessingError):
        service.create_thumbnail(tmp_path / "source.mp4", destination, 1500)
    assert destination.read_bytes() == b"previous"
    assert list(tmp_path.glob(".*.processing.jpg")) == []


def test_ffmpeg_extracts_exact_milliseconds_without_shell_or_distortion(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = FFmpegMediaService()
    arguments: list[str] = []

    def run(values: list[str]) -> CompletedProcess[str]:
        arguments.extend(values)
        Path(values[-1]).write_bytes(b"jpeg")
        return CompletedProcess(values, 0, "", "")

    monkeypatch.setattr(service, "_run", run)
    destination = tmp_path / "frame.jpg"
    service.create_thumbnail(tmp_path / "source.mp4", destination, 93_456)
    assert arguments[arguments.index("-ss") + 1] == "93.456"
    assert arguments[arguments.index("-frames:v") + 1] == "1"
    assert "force_original_aspect_ratio=decrease" in arguments[arguments.index("-vf") + 1]
    assert destination.read_bytes() == b"jpeg"
    with pytest.raises(MediaProcessingError):
        service.create_thumbnail(tmp_path / "source.mp4", destination, -1)
