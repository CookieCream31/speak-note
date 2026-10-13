import uuid

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.models.meeting import Meeting, MeetingStatus
from app.models.realtime import RealtimeSession, RealtimeSessionStatus
from app.models.transcript import (
    TranscriptKind,
    TranscriptSegment,
    TranscriptStatus,
    TranscriptVersion,
)
from app.schemas.transcript import LiveSpeakerNameUpdate


def update_live_speaker_name(
    session: Session, meeting: Meeting, payload: LiveSpeakerNameUpdate
) -> list[TranscriptSegment]:
    # Serialize edits with recording setup without treating a Live label as a person ID.
    locked = session.scalar(
        select(Meeting)
        .where(Meeting.id == meeting.id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if locked is None:
        raise HTTPException(404, "会議が見つかりません")
    active = session.scalar(
        select(RealtimeSession.id).where(
            RealtimeSession.meeting_id == meeting.id,
            RealtimeSession.status.in_(
                (RealtimeSessionStatus.RECORDING, RealtimeSessionStatus.FINALIZING)
            ),
        )
    )
    if locked.status == MeetingStatus.RECORDING or active is not None:
        raise HTTPException(409, "録音・録画の停止と保存完了後に話者名を変更してください")
    segment_ids: set[uuid.UUID] = set(payload.segment_ids)
    segments = list(
        session.scalars(
            select(TranscriptSegment)
            .join(TranscriptVersion)
            .options(
                selectinload(TranscriptSegment.speaker),
                selectinload(TranscriptSegment.words),
            )
            .where(
                TranscriptSegment.id.in_(segment_ids),
                TranscriptVersion.meeting_id == meeting.id,
                TranscriptVersion.kind == TranscriptKind.LIVE,
                TranscriptVersion.status == TranscriptStatus.COMPLETED,
            )
            .order_by(TranscriptSegment.sequence)
            .with_for_update()
        )
    )
    if len(segments) != len(segment_ids):
        raise HTTPException(404, "保存済みリアルタイム版の発言が見つかりません")
    first = segments[0]
    if len(segments) > 1 and first.provisional_speaker_label in (None, "SPEAKER_UNKNOWN"):
        raise HTTPException(409, "話者未判定の発言は個別に名前を変更してください")
    if any(
        segment.transcript_version_id != first.transcript_version_id
        or segment.provisional_speaker_label != first.provisional_speaker_label
        or segment.provisional_speaker_name != first.provisional_speaker_name
        or segment.sequence != first.sequence + index
        for index, segment in enumerate(segments)
    ):
        raise HTTPException(409, "話者名は連続した同じ話者の発言ごとに変更してください")
    name = (payload.display_name or "").strip() or None
    for segment in segments:
        segment.provisional_speaker_name = name
    session.commit()
    return segments
