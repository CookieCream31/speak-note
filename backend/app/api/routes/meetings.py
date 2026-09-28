import uuid

from fastapi import APIRouter, Header, HTTPException, Query, Response, UploadFile, status
from fastapi.responses import RedirectResponse
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from app.api.dependencies import DbSession, MeetingDep, StorageDep
from app.core.config import get_settings
from app.models.job import Job, JobType
from app.models.knowledge import Project
from app.models.media import Media, MediaKind
from app.models.meeting import Meeting, MeetingSourceType, MeetingStatus
from app.models.meeting_template import MeetingTemplate
from app.models.tag import MeetingTag
from app.models.upload import MediaUploadSession, MediaUploadStatus, utc_now
from app.schemas.job import JobRead
from app.schemas.media import MediaRead, MediaUploadRead
from app.schemas.meeting import (
    MeetingBulkActionRead,
    MeetingBulkActionRequest,
    MeetingCreate,
    MeetingList,
    MeetingRead,
    MeetingUpdate,
)
from app.schemas.upload import (
    MediaUploadChunkRead,
    MediaUploadSessionCreate,
    MediaUploadSessionRead,
)
from app.services.media import (
    InvalidAudioError,
    InvalidUploadChunkError,
    InvalidVideoError,
    UploadTooLargeError,
)

router = APIRouter(prefix="/meetings", tags=["meetings"])


@router.get("", response_model=MeetingList)
def list_meetings(
    session: DbSession,
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    project_id: uuid.UUID | None = None,
) -> MeetingList:
    criteria = Meeting.project_id == project_id if project_id is not None else True
    total = session.scalar(select(func.count()).select_from(Meeting).where(criteria)) or 0
    meeting_models = list(
        session.scalars(
            select(Meeting).where(criteria).order_by(Meeting.created_at.desc()).limit(limit).offset(offset)
        )
    )
    meetings = [MeetingRead.model_validate(meeting) for meeting in meeting_models]
    return MeetingList(items=meetings, total=total, limit=limit, offset=offset)


@router.post("", response_model=MeetingRead, status_code=status.HTTP_201_CREATED)
def create_meeting(payload: MeetingCreate, session: DbSession) -> Meeting:
    if payload.project_id is not None and session.get(Project, payload.project_id) is None:
        raise HTTPException(status_code=404, detail="プロジェクトが見つかりません")
    template = (
        session.get(MeetingTemplate, payload.template_id)
        if payload.template_id is not None
        else session.scalar(select(MeetingTemplate).where(MeetingTemplate.is_default.is_(True)))
    )
    if payload.template_id is not None and template is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="テンプレートが見つかりません")
    meeting = Meeting(
        title=payload.title,
        source_type=payload.source_type,
        min_speakers=payload.min_speakers,
        max_speakers=payload.max_speakers,
        summary_format=payload.summary_format,
        template_id=template.id if template else None,
        template_snapshot=(
            {"template_id": str(template.id), "revision": template.revision,
             "name": template.name, "definition": template.definition}
            if template else None
        ),
        meeting_context=payload.meeting_context,
        project_id=payload.project_id,
    )
    session.add(meeting)
    session.commit()
    session.refresh(meeting)
    return meeting


@router.post("/bulk-actions", response_model=MeetingBulkActionRead)
def bulk_manage_meetings(
    payload: MeetingBulkActionRequest,
    session: DbSession,
    storage: StorageDep,
) -> MeetingBulkActionRead:
    meeting_ids = list(dict.fromkeys(payload.meeting_ids))
    meeting_models = list(
        session.scalars(select(Meeting).where(Meeting.id.in_(meeting_ids)))
    )
    found_ids = {meeting.id for meeting in meeting_models}
    missing_ids = [meeting_id for meeting_id in meeting_ids if meeting_id not in found_ids]
    if missing_ids:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Meeting not found: {missing_ids[0]}",
        )

    if payload.action == "delete":
        for meeting in meeting_models:
            session.delete(meeting)
        session.commit()
        for meeting_id in meeting_ids:
            storage.delete_meeting_files(meeting_id)
    elif payload.action in {"favorite", "unfavorite"}:
        is_favorite = payload.action == "favorite"
        for meeting in meeting_models:
            meeting.is_favorite = is_favorite
        session.commit()
    else:
        tag = session.get(MeetingTag, payload.tag_id)
        if tag is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Tag not found")
        for meeting in meeting_models:
            has_tag = any(existing.id == tag.id for existing in meeting.tags)
            if payload.action == "tag" and not has_tag:
                meeting.tags.append(tag)
            elif payload.action == "untag" and has_tag:
                meeting.tags.remove(tag)
        session.commit()

    return MeetingBulkActionRead(action=payload.action, affected=len(meeting_models))


@router.get("/{meeting_id}", response_model=MeetingRead)
def get_meeting(meeting: MeetingDep) -> Meeting:
    return meeting


@router.patch("/{meeting_id}", response_model=MeetingRead)
def update_meeting(
    payload: MeetingUpdate,
    meeting: MeetingDep,
    session: DbSession,
) -> Meeting:
    updates = payload.model_dump(exclude_unset=True)
    if updates.get("project_id") is not None and session.get(Project, updates["project_id"]) is None:
        raise HTTPException(status_code=404, detail="プロジェクトが見つかりません")
    next_min_speakers = updates.get("min_speakers", meeting.min_speakers)
    next_max_speakers = updates.get("max_speakers", meeting.max_speakers)
    if (
        next_min_speakers is not None
        and next_max_speakers is not None
        and next_min_speakers > next_max_speakers
    ):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="最小話者数は最大話者数以下にしてください",
        )
    for field, value in updates.items():
        setattr(meeting, field, value)
    session.commit()
    session.refresh(meeting)
    return meeting


@router.delete("/{meeting_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_meeting(meeting: MeetingDep, session: DbSession, storage: StorageDep) -> Response:
    meeting_id = meeting.id
    session.delete(meeting)
    session.commit()
    storage.delete_meeting_files(meeting_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/{meeting_id}/jobs", response_model=list[JobRead])
def list_meeting_jobs(meeting: MeetingDep, session: DbSession) -> list[Job]:
    return list(
        session.scalars(
            select(Job)
            .where(
                Job.meeting_id == meeting.id,
                Job.type != JobType.ANALYZE_REALTIME,
            )
            .order_by(Job.created_at.desc())
        )
    )


@router.get("/{meeting_id}/media", response_model=list[MediaRead])
def list_meeting_media(meeting: MeetingDep, session: DbSession) -> list[Media]:
    return list(
        session.scalars(
            select(Media).where(Media.meeting_id == meeting.id).order_by(Media.created_at)
        )
    )


@router.post(
    "/{meeting_id}/uploads",
    response_model=MediaUploadSessionRead,
    status_code=status.HTTP_201_CREATED,
)
def create_media_upload(
    payload: MediaUploadSessionCreate,
    meeting: MeetingDep,
    session: DbSession,
    storage: StorageDep,
) -> MediaUploadSessionRead:
    upload_source = meeting.source_type
    try:
        if meeting.source_type == MeetingSourceType.MEDIA_UPLOAD:
            detected_kind, suffix, mime_type = storage.validate_media_metadata(
                payload.filename, payload.mime_type, payload.size_bytes
            )
            upload_source = (
                MeetingSourceType.VIDEO_UPLOAD
                if detected_kind == "video"
                else MeetingSourceType.AUDIO_UPLOAD
            )
        elif meeting.source_type == MeetingSourceType.VIDEO_UPLOAD:
            suffix, mime_type = storage.validate_video_metadata(
                payload.filename, payload.mime_type, payload.size_bytes
            )
        elif meeting.source_type == MeetingSourceType.AUDIO_UPLOAD:
            suffix, mime_type = storage.validate_audio_metadata(
                payload.filename, payload.mime_type, payload.size_bytes
            )
        else:
            _upload_spec(meeting)
            raise AssertionError("unreachable")
    except (InvalidAudioError, InvalidVideoError) as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)
        ) from exc
    except UploadTooLargeError as exc:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail=str(exc)
        ) from exc

    media_kind, _, duplicate_message = _upload_spec_for_source(upload_source)
    existing = session.scalar(
        select(Media.id).where(Media.meeting_id == meeting.id, Media.kind == media_kind)
    )
    if existing is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=duplicate_message)

    stale_uploads = list(
        session.scalars(
            select(MediaUploadSession).where(MediaUploadSession.meeting_id == meeting.id)
        )
    )
    for stale_upload in stale_uploads:
        session.delete(stale_upload)

    chunk_size_bytes = get_settings().upload_chunk_mb * 1024 * 1024
    upload = MediaUploadSession(
        meeting_id=meeting.id,
        filename_suffix=suffix,
        mime_type=mime_type,
        size_bytes=payload.size_bytes,
        chunk_size_bytes=chunk_size_bytes,
        chunk_count=(payload.size_bytes + chunk_size_bytes - 1) // chunk_size_bytes,
    )
    meeting.status = MeetingStatus.UPLOADING
    session.add(upload)
    session.commit()
    session.refresh(upload)
    for stale_upload in stale_uploads:
        storage.delete_upload_parts(meeting.id, stale_upload.id)
    return _upload_session_read(upload, storage)


@router.get(
    "/{meeting_id}/uploads/{upload_id}",
    response_model=MediaUploadSessionRead,
)
def get_media_upload(
    upload_id: uuid.UUID,
    meeting: MeetingDep,
    session: DbSession,
    storage: StorageDep,
) -> MediaUploadSessionRead:
    upload = _get_upload_or_404(session, meeting.id, upload_id)
    return _upload_session_read(upload, storage)


@router.put(
    "/{meeting_id}/uploads/{upload_id}/chunks/{chunk_index}",
    response_model=MediaUploadChunkRead,
)
def upload_media_chunk(
    upload_id: uuid.UUID,
    chunk_index: int,
    meeting: MeetingDep,
    session: DbSession,
    storage: StorageDep,
    file: UploadFile,
) -> MediaUploadChunkRead:
    upload = _get_upload_or_404(session, meeting.id, upload_id)
    if upload.status != MediaUploadStatus.UPLOADING:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This upload has already been completed",
        )
    if chunk_index < 0 or chunk_index >= upload.chunk_count:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="チャンク番号が範囲外です",
        )

    expected_size = min(
        upload.chunk_size_bytes,
        upload.size_bytes - chunk_index * upload.chunk_size_bytes,
    )
    try:
        storage.save_upload_chunk(
            file,
            meeting.id,
            upload.id,
            chunk_index,
            expected_size,
        )
    except InvalidUploadChunkError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)
        ) from exc
    finally:
        file.file.close()

    upload.updated_at = utc_now()
    session.commit()
    received = storage.received_upload_chunks(meeting.id, upload.id, upload.chunk_count)
    return MediaUploadChunkRead(
        upload_id=upload.id,
        chunk_index=chunk_index,
        received_chunks=len(received),
        chunk_count=upload.chunk_count,
    )


@router.post(
    "/{meeting_id}/uploads/{upload_id}/complete",
    response_model=MediaUploadRead,
    status_code=status.HTTP_202_ACCEPTED,
)
def complete_media_upload(
    upload_id: uuid.UUID,
    meeting: MeetingDep,
    session: DbSession,
    storage: StorageDep,
) -> MediaUploadRead:
    upload = _get_upload_or_404(session, meeting.id, upload_id, for_update=True)
    if upload.status == MediaUploadStatus.COMPLETED:
        media = session.get(Media, upload.media_id)
        job = session.get(Job, upload.job_id)
        if media is None or job is None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Completed upload is inconsistent",
            )
        return MediaUploadRead(
            media=MediaRead.model_validate(media), job=JobRead.model_validate(job)
        )

    received = storage.received_upload_chunks(meeting.id, upload.id, upload.chunk_count)
    if len(received) != upload.chunk_count:
        missing = sorted(set(range(upload.chunk_count)) - set(received))
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"未送信のチャンクがあります: {missing[0] + 1}",
        )

    if meeting.source_type == MeetingSourceType.MEDIA_UPLOAD:
        try:
            detected_kind, _, _ = storage.validate_media_metadata(
                f"upload{upload.filename_suffix}", upload.mime_type, upload.size_bytes
            )
        except (InvalidAudioError, InvalidVideoError, UploadTooLargeError) as exc:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT, detail=str(exc)
            ) from exc
        meeting.source_type = (
            MeetingSourceType.VIDEO_UPLOAD
            if detected_kind == "video"
            else MeetingSourceType.AUDIO_UPLOAD
        )

    media_kind, job_type, duplicate_message = _upload_spec(meeting)
    try:
        stored = storage.assemble_upload(
            meeting.id,
            upload.id,
            upload.media_id,
            upload.filename_suffix,
            upload.mime_type,
            upload.chunk_count,
            upload.size_bytes,
        )
    except InvalidUploadChunkError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc

    result = _save_upload_and_job(
        meeting,
        session,
        storage,
        media_id=upload.media_id,
        job_id=upload.job_id,
        media_kind=media_kind,
        job_type=job_type,
        stored_path=stored.storage_path,
        mime_type=stored.mime_type,
        size_bytes=stored.size_bytes,
        accept="application/json",
        duplicate_message=duplicate_message,
        upload_session=upload,
    )
    storage.delete_upload_parts(meeting.id, upload.id)
    if isinstance(result, RedirectResponse):
        raise RuntimeError("Chunked upload unexpectedly returned a redirect")
    return result


@router.post(
    "/{meeting_id}/audio",
    status_code=status.HTTP_202_ACCEPTED,
    response_model=None,
)
def upload_audio(
    meeting: MeetingDep,
    session: DbSession,
    storage: StorageDep,
    file: UploadFile,
    accept: str = Header(default="application/json"),
) -> MediaUploadRead | RedirectResponse:
    if meeting.source_type != MeetingSourceType.AUDIO_UPLOAD:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This meeting is not configured for audio upload",
        )
    existing = session.scalar(
        select(Media.id).where(
            Media.meeting_id == meeting.id,
            Media.kind == MediaKind.ORIGINAL_AUDIO,
        )
    )
    if existing is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="An audio file has already been uploaded",
        )

    media_id = uuid.uuid4()
    try:
        stored = storage.save_audio(file, meeting.id, media_id)
    except InvalidAudioError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)
        ) from exc
    except UploadTooLargeError as exc:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail=str(exc)
        ) from exc
    finally:
        file.file.close()

    return _save_upload_and_job(
        meeting,
        session,
        storage,
        media_id=media_id,
        media_kind=MediaKind.ORIGINAL_AUDIO,
        job_type=JobType.TRANSCRIBE,
        stored_path=stored.storage_path,
        mime_type=stored.mime_type,
        size_bytes=stored.size_bytes,
        accept=accept,
        duplicate_message="An audio file has already been uploaded",
    )


@router.post(
    "/{meeting_id}/video",
    status_code=status.HTTP_202_ACCEPTED,
    response_model=None,
)
def upload_video(
    meeting: MeetingDep,
    session: DbSession,
    storage: StorageDep,
    file: UploadFile,
    accept: str = Header(default="application/json"),
) -> MediaUploadRead | RedirectResponse:
    if meeting.source_type != MeetingSourceType.VIDEO_UPLOAD:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This meeting is not configured for video upload",
        )
    existing = session.scalar(
        select(Media.id).where(
            Media.meeting_id == meeting.id,
            Media.kind == MediaKind.ORIGINAL_VIDEO,
        )
    )
    if existing is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="A video file has already been uploaded",
        )

    media_id = uuid.uuid4()
    try:
        stored = storage.save_video(file, meeting.id, media_id)
    except InvalidVideoError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)
        ) from exc
    except UploadTooLargeError as exc:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail=str(exc)
        ) from exc
    finally:
        file.file.close()

    return _save_upload_and_job(
        meeting,
        session,
        storage,
        media_id=media_id,
        media_kind=MediaKind.ORIGINAL_VIDEO,
        job_type=JobType.PREPROCESS_MEDIA,
        stored_path=stored.storage_path,
        mime_type=stored.mime_type,
        size_bytes=stored.size_bytes,
        accept=accept,
        duplicate_message="A video file has already been uploaded",
    )


def _save_upload_and_job(
    meeting: Meeting,
    session: DbSession,
    storage: StorageDep,
    *,
    media_id: uuid.UUID,
    job_id: uuid.UUID | None = None,
    media_kind: MediaKind,
    job_type: JobType,
    stored_path: str,
    mime_type: str,
    size_bytes: int,
    accept: str,
    duplicate_message: str,
    upload_session: MediaUploadSession | None = None,
) -> MediaUploadRead | RedirectResponse:
    media = Media(
        id=media_id,
        meeting_id=meeting.id,
        kind=media_kind,
        storage_path=stored_path,
        mime_type=mime_type,
        size_bytes=size_bytes,
    )
    job = Job(id=job_id or uuid.uuid4(), meeting_id=meeting.id, type=job_type, progress=0)
    meeting.status = MeetingStatus.QUEUED
    if upload_session is not None:
        upload_session.status = MediaUploadStatus.COMPLETED
        upload_session.updated_at = utc_now()
    session.add_all([media, job])
    try:
        session.commit()
    except IntegrityError as exc:
        session.rollback()
        storage.delete_file(stored_path)
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=duplicate_message,
        ) from exc
    except Exception:
        session.rollback()
        storage.delete_file(stored_path)
        raise

    session.refresh(media)
    session.refresh(job)
    if "text/html" in accept:
        return RedirectResponse(
            url=f"/meetings/{meeting.id}", status_code=status.HTTP_303_SEE_OTHER
        )
    return MediaUploadRead(media=MediaRead.model_validate(media), job=JobRead.model_validate(job))


def _get_upload_or_404(
    session: DbSession,
    meeting_id: uuid.UUID,
    upload_id: uuid.UUID,
    *,
    for_update: bool = False,
) -> MediaUploadSession:
    statement = select(MediaUploadSession).where(
        MediaUploadSession.id == upload_id,
        MediaUploadSession.meeting_id == meeting_id,
    )
    if for_update:
        statement = statement.with_for_update()
    upload = session.scalar(statement)
    if upload is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Upload not found")
    return upload


def _upload_session_read(
    upload: MediaUploadSession, storage: StorageDep
) -> MediaUploadSessionRead:
    result = MediaUploadSessionRead.model_validate(upload)
    return result.model_copy(
        update={
            "received_chunks": storage.received_upload_chunks(
                upload.meeting_id, upload.id, upload.chunk_count
            )
        }
    )


def _upload_spec_for_source(
    source_type: MeetingSourceType,
) -> tuple[MediaKind, JobType, str]:
    if source_type == MeetingSourceType.VIDEO_UPLOAD:
        return (
            MediaKind.ORIGINAL_VIDEO,
            JobType.PREPROCESS_MEDIA,
            "A video file has already been uploaded",
        )
    if source_type == MeetingSourceType.AUDIO_UPLOAD:
        return (
            MediaKind.ORIGINAL_AUDIO,
            JobType.TRANSCRIBE,
            "An audio file has already been uploaded",
        )
    raise HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail="Live meetings do not accept file uploads",
    )


def _upload_spec(meeting: Meeting) -> tuple[MediaKind, JobType, str]:
    return _upload_spec_for_source(meeting.source_type)
