import uuid

from fastapi import APIRouter, HTTPException, Query, Response, status
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.api.dependencies import DbSession, MeetingDep
from app.models.analysis import (
    AnalysisItem,
    AnalysisItemKind,
    AnalysisItemState,
    AnalysisStatus,
    AnalysisVersion,
    Bookmark,
)
from app.models.meeting import Meeting
from app.models.transcript import TranscriptSegment, TranscriptVersion
from app.schemas.analysis import (
    AnalysisGenerateRead,
    AnalysisGenerateRequest,
    AnalysisItemRead,
    AnalysisItemUpdate,
    AnalysisVersionRead,
    AnalysisVersionSummaryRead,
    BookmarkCreate,
    BookmarkRead,
    BookmarkUpdate,
    ManualAnalysisImportRequest,
    ManualAnalysisPreviewRead,
    ManualAnalysisPromptRead,
    TimelineMarkerRead,
    TranscriptSearchResultRead,
)
from app.services.analysis import (
    MANUAL_PROMPT_VERSION,
    AnalysisProcessingError,
    ManualImportError,
    build_manual_prompt,
    load_manual_transcript,
    save_manual_analysis,
    validate_manual_response,
)
from app.services.analysis.regeneration import regenerate_summary

router = APIRouter(prefix="/meetings", tags=["analysis"])


def _load_analysis(
    session: DbSession,
    meeting_id: uuid.UUID,
    analysis_id: uuid.UUID,
) -> AnalysisVersion | None:
    return session.scalar(
        select(AnalysisVersion)
        .options(selectinload(AnalysisVersion.items).selectinload(AnalysisItem.evidence))
        .where(
            AnalysisVersion.id == analysis_id,
            AnalysisVersion.meeting_id == meeting_id,
        )
    )


@router.post(
    "/{meeting_id}/analyses",
    response_model=AnalysisGenerateRead,
    status_code=status.HTTP_202_ACCEPTED,
)
def generate_analysis(
    payload: AnalysisGenerateRequest,
    meeting: MeetingDep,
    session: DbSession,
) -> AnalysisGenerateRead:
    try:
        analysis, job = regenerate_summary(session, meeting, payload)
    except AnalysisProcessingError as exc:
        session.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    return AnalysisGenerateRead(
        analysis=AnalysisVersionSummaryRead.model_validate(analysis) if analysis else None,
        job_id=job.id,
    )


@router.get("/{meeting_id}/analyses", response_model=list[AnalysisVersionSummaryRead])
def list_analyses(meeting: MeetingDep, session: DbSession) -> list[AnalysisVersion]:
    return list(
        session.scalars(
            select(AnalysisVersion)
            .where(AnalysisVersion.meeting_id == meeting.id)
            .order_by(AnalysisVersion.version.desc())
        )
    )


@router.get(
    "/{meeting_id}/analyses/manual/prompt",
    response_model=ManualAnalysisPromptRead,
)
def get_manual_analysis_prompt(
    meeting: MeetingDep,
    session: DbSession,
) -> ManualAnalysisPromptRead:
    try:
        transcript = load_manual_transcript(session, meeting)
    except ManualImportError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    return ManualAnalysisPromptRead(
        transcript_version_id=transcript.id,
        prompt_version=MANUAL_PROMPT_VERSION,
        filename=f"speak-note-{meeting.id}-manual-ai.txt",
        prompt=build_manual_prompt(meeting, transcript),
    )


def _load_import_transcript(
    payload: ManualAnalysisImportRequest,
    meeting: Meeting,
    session: DbSession,
) -> TranscriptVersion:
    try:
        transcript = load_manual_transcript(session, meeting)
    except ManualImportError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    if transcript.id != payload.transcript_version_id:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="文字起こしが更新されています。プロンプトを作り直してください",
        )
    return transcript


@router.post(
    "/{meeting_id}/analyses/manual/validate",
    response_model=ManualAnalysisPreviewRead,
)
def validate_manual_analysis(
    payload: ManualAnalysisImportRequest,
    meeting: MeetingDep,
    session: DbSession,
) -> ManualAnalysisPreviewRead:
    transcript = _load_import_transcript(payload, meeting, session)
    try:
        _, preview = validate_manual_response(transcript, payload.response_text)
    except ManualImportError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=str(exc),
        ) from exc
    return preview


@router.post(
    "/{meeting_id}/analyses/manual/import",
    response_model=AnalysisVersionRead,
    status_code=status.HTTP_201_CREATED,
)
def import_manual_analysis(
    payload: ManualAnalysisImportRequest,
    meeting: MeetingDep,
    session: DbSession,
) -> AnalysisVersion:
    transcript = _load_import_transcript(payload, meeting, session)
    try:
        result, _ = validate_manual_response(transcript, payload.response_text)
        return save_manual_analysis(session, meeting, transcript, result)
    except ManualImportError as exc:
        session.rollback()
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=str(exc),
        ) from exc


@router.get("/{meeting_id}/analysis", response_model=AnalysisVersionRead)
def get_active_analysis(meeting: MeetingDep, session: DbSession) -> AnalysisVersion:
    if meeting.active_analysis_version_id is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Analysis not found")
    analysis = _load_analysis(session, meeting.id, meeting.active_analysis_version_id)
    if analysis is None or analysis.status != AnalysisStatus.COMPLETED:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Analysis not found")
    return analysis


@router.get("/{meeting_id}/analyses/{analysis_id}", response_model=AnalysisVersionRead)
def get_analysis(
    analysis_id: uuid.UUID,
    meeting: MeetingDep,
    session: DbSession,
) -> AnalysisVersion:
    analysis = _load_analysis(session, meeting.id, analysis_id)
    if analysis is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Analysis not found")
    return analysis


@router.patch(
    "/{meeting_id}/analyses/{analysis_id}/items/{item_id}",
    response_model=AnalysisItemRead,
)
def update_analysis_item(
    analysis_id: uuid.UUID,
    item_id: uuid.UUID,
    payload: AnalysisItemUpdate,
    meeting: MeetingDep,
    session: DbSession,
) -> AnalysisItem:
    item = session.scalar(
        select(AnalysisItem)
        .join(AnalysisVersion)
        .options(selectinload(AnalysisItem.evidence))
        .where(
            AnalysisItem.id == item_id,
            AnalysisVersion.id == analysis_id,
            AnalysisVersion.meeting_id == meeting.id,
        )
    )
    if item is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Analysis item not found")
    fields = payload.model_dump(exclude_unset=True)
    content_changed = "content" in fields or "assignee" in fields or "deadline" in fields
    for field, value in fields.items():
        if field != "state":
            setattr(item, field, value.strip() if isinstance(value, str) else value)
    if payload.state is not None:
        item.state = payload.state
    elif content_changed:
        item.state = AnalysisItemState.EDITED
    session.commit()
    session.refresh(item)
    return item


@router.get("/{meeting_id}/search", response_model=list[TranscriptSearchResultRead])
def search_transcript(
    meeting: MeetingDep,
    session: DbSession,
    q: str = Query(min_length=1, max_length=200),
    speaker_id: uuid.UUID | None = None,
    limit: int = Query(default=50, ge=1, le=100),
) -> list[TranscriptSearchResultRead]:
    if meeting.active_transcript_version_id is None:
        return []
    statement = (
        select(TranscriptSegment)
        .options(selectinload(TranscriptSegment.speaker))
        .where(
            TranscriptSegment.transcript_version_id == meeting.active_transcript_version_id,
            TranscriptSegment.text.ilike(f"%{q.strip()}%"),
        )
        .order_by(TranscriptSegment.start_ms)
        .limit(limit)
    )
    if speaker_id is not None:
        statement = statement.where(TranscriptSegment.speaker_id == speaker_id)
    results = []
    for segment in session.scalars(statement):
        speaker_name = "話者不明"
        if segment.speaker is not None:
            speaker_name = segment.speaker.display_name or segment.speaker.internal_name
        results.append(
            TranscriptSearchResultRead(
                segment_id=segment.id,
                start_ms=segment.start_ms,
                end_ms=segment.end_ms,
                text=segment.text,
                speaker_id=segment.speaker_id,
                speaker_name=speaker_name,
            )
        )
    return results


@router.get("/{meeting_id}/bookmarks", response_model=list[BookmarkRead])
def list_bookmarks(meeting: MeetingDep, session: DbSession) -> list[Bookmark]:
    return list(
        session.scalars(
            select(Bookmark)
            .where(Bookmark.meeting_id == meeting.id)
            .order_by(Bookmark.timestamp_ms, Bookmark.created_at)
        )
    )


@router.post(
    "/{meeting_id}/bookmarks",
    response_model=BookmarkRead,
    status_code=status.HTTP_201_CREATED,
)
def create_bookmark(
    payload: BookmarkCreate,
    meeting: MeetingDep,
    session: DbSession,
) -> Bookmark:
    bookmark = Bookmark(
        meeting_id=meeting.id,
        timestamp_ms=payload.timestamp_ms,
        title=payload.title.strip(),
        note=payload.note.strip() if payload.note else None,
    )
    session.add(bookmark)
    session.commit()
    session.refresh(bookmark)
    return bookmark


@router.patch("/{meeting_id}/bookmarks/{bookmark_id}", response_model=BookmarkRead)
def update_bookmark(
    bookmark_id: uuid.UUID,
    payload: BookmarkUpdate,
    meeting: MeetingDep,
    session: DbSession,
) -> Bookmark:
    bookmark = session.scalar(
        select(Bookmark).where(
            Bookmark.id == bookmark_id,
            Bookmark.meeting_id == meeting.id,
        )
    )
    if bookmark is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Bookmark not found")
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(bookmark, field, value.strip() if isinstance(value, str) else value)
    session.commit()
    session.refresh(bookmark)
    return bookmark


@router.delete(
    "/{meeting_id}/bookmarks/{bookmark_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def delete_bookmark(
    bookmark_id: uuid.UUID,
    meeting: MeetingDep,
    session: DbSession,
) -> Response:
    bookmark = session.scalar(
        select(Bookmark).where(
            Bookmark.id == bookmark_id,
            Bookmark.meeting_id == meeting.id,
        )
    )
    if bookmark is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Bookmark not found")
    session.delete(bookmark)
    session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/{meeting_id}/timeline", response_model=list[TimelineMarkerRead])
def get_timeline(meeting: MeetingDep, session: DbSession) -> list[TimelineMarkerRead]:
    markers: list[TimelineMarkerRead] = []
    if meeting.active_analysis_version_id is not None:
        timeline_kinds = {
            AnalysisItemKind.CHAPTER,
            AnalysisItemKind.DECISION,
            AnalysisItemKind.ACTION_ITEM,
            AnalysisItemKind.IMPORTANT_POINT,
            AnalysisItemKind.HIGHLIGHT,
        }
        items = session.scalars(
            select(AnalysisItem).where(
                AnalysisItem.analysis_version_id == meeting.active_analysis_version_id,
                AnalysisItem.kind.in_(timeline_kinds),
                AnalysisItem.start_ms.is_not(None),
            )
        )
        markers.extend(
            TimelineMarkerRead(
                id=item.id,
                kind=item.kind.value,
                timestamp_ms=item.start_ms or 0,
                end_ms=item.end_ms,
                title=item.content,
            )
            for item in items
        )
    bookmarks = session.scalars(select(Bookmark).where(Bookmark.meeting_id == meeting.id))
    markers.extend(
        TimelineMarkerRead(
            id=bookmark.id,
            kind="bookmark",
            timestamp_ms=bookmark.timestamp_ms,
            end_ms=None,
            title=bookmark.title,
        )
        for bookmark in bookmarks
    )
    return sorted(markers, key=lambda marker: (marker.timestamp_ms, marker.kind))
