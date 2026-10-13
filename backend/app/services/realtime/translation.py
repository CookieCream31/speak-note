import uuid
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.meeting import Meeting, MeetingSourceType
from app.models.realtime import RealtimeSession, RealtimeSessionStatus
from app.models.translation import RealtimeTranslation
from app.schemas.translation import StreamingTranslation, parse_translation_config
from app.services.realtime.capture import RealtimeCaptureError
from app.services.transcription.languages import LANGUAGES


def validate_meeting_translation(
    db: Session, meeting: Meeting, config: dict[str, Any] | None
) -> None:
    if config is None:
        return
    parsed = parse_translation_config(config).model_dump()
    if meeting.source_type not in {
        MeetingSourceType.LIVE,
        MeetingSourceType.SHARED_AUDIO,
        MeetingSourceType.AUDIO_RECORDING,
    }:
        raise ValueError("リアルタイム翻訳は画面共有・マイク録音の会議で利用できます")
    if any(code not in LANGUAGES for key, code in parsed.items() if key != "type"):
        raise ValueError("翻訳の言語が対応していません")


def append_translation(
    db: Session, session_id: uuid.UUID, result: StreamingTranslation
) -> RealtimeTranslation:
    recording = db.scalar(
        select(RealtimeSession)
        .where(RealtimeSession.id == session_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    config = (recording.transcription_request or {}).get("translation") if recording else None
    if recording is None or recording.transcription_provider != "soniox" or not config:
        raise RealtimeCaptureError("この録音ではリアルタイム翻訳が有効ではありません")
    parsed = parse_translation_config(config)
    if result.source_language not in LANGUAGES or result.target_language not in LANGUAGES:
        raise RealtimeCaptureError("翻訳結果の言語が不正です")
    if parsed.type == "one_way":
        valid = result.target_language == parsed.target_language
    else:
        valid = (result.source_language, result.target_language) in {
            (parsed.language_a, parsed.language_b),
            (parsed.language_b, parsed.language_a),
        }
    if not valid:
        raise RealtimeCaptureError("翻訳結果が録音開始時の翻訳設定と一致しません")
    identifier = uuid.uuid5(session_id, f"translation:{result.result_id}")
    existing = db.get(RealtimeTranslation, identifier)
    if existing is not None:
        if any(getattr(existing, key) != value for key, value in result.model_dump().items()):
            raise RealtimeCaptureError("同じ翻訳IDに異なる結果を保存できません")
        db.commit()  # Release the session row lock before waiting for more socket messages.
        return existing
    if recording.status != RealtimeSessionStatus.RECORDING:
        raise RealtimeCaptureError("録音終了後に翻訳を追加できません")
    previous = db.scalar(
        select(func.max(RealtimeTranslation.sequence)).where(
            RealtimeTranslation.session_id == session_id
        )
    )
    stored = RealtimeTranslation(
        id=identifier,
        session_id=session_id,
        sequence=(previous or 0) + 1,
        **result.model_dump(),
    )
    db.add(stored)
    db.commit()
    db.refresh(stored)
    return stored
