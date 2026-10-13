from typing import Any

from sqlalchemy.orm import Session

from app.core.config import Settings, get_settings
from app.models.job import Job
from app.models.meeting import Meeting
from app.models.realtime import RealtimeSession
from app.models.transcript import TranscriptVersion
from app.models.transcription import (
    AsyncTranscriptionSettings,
    RealtimeTranscriptionProvider,
    RealtimeTranscriptionSettings,
)
from app.services.llm import SecretCipher, SecretConfigurationError, SecretDecryptionError
from app.services.transcription.azure import AzureSpeechClient
from app.services.transcription.base import TranscriptionClient
from app.services.transcription.client import WhisperXClient
from app.services.transcription.languages import TranscriptionLanguageError, provider_language
from app.services.transcription.soniox import SonioxClient


class RealtimeTranscriptionConfigurationError(RuntimeError):
    pass


def get_realtime_transcription_settings(db: Session) -> RealtimeTranscriptionSettings:
    settings = db.get(RealtimeTranscriptionSettings, 1)
    if settings is None:
        settings = RealtimeTranscriptionSettings(id=1)
        db.add(settings)
        db.flush()
    return settings


def get_async_transcription_settings(db: Session) -> AsyncTranscriptionSettings:
    settings = db.get(AsyncTranscriptionSettings, 1)
    if settings is None:
        settings = AsyncTranscriptionSettings(id=1)
        db.add(settings)
        db.flush()
    return settings


def decrypt_soniox_key(
    settings: RealtimeTranscriptionSettings | AsyncTranscriptionSettings,
    application_settings: Settings,
) -> str:
    if not settings.soniox_encrypted_api_key:
        raise RealtimeTranscriptionConfigurationError("SonioxのAPI Keyを保存してください")
    try:
        return SecretCipher(application_settings.master_encryption_key.get_secret_value()).decrypt(
            settings.soniox_encrypted_api_key
        )
    except (SecretConfigurationError, SecretDecryptionError) as exc:
        raise RealtimeTranscriptionConfigurationError(
            "SonioxのAPI Keyを復号できません。MASTER_ENCRYPTION_KEYを確認してください"
        ) from exc


def snapshot_async_transcription(db: Session, meeting: Meeting | None = None) -> dict[str, Any]:
    stored = get_async_transcription_settings(db)
    if stored.provider == "soniox" and not stored.soniox_encrypted_api_key:
        raise RealtimeTranscriptionConfigurationError("Sonioxの非同期API Keyを保存してください")
    application = get_settings()
    try:
        language, options = provider_language(
            meeting,
            stored.provider,
            stored.soniox_language
            if stored.provider == "soniox"
            else application.whisperx_language,
        )
    except TranscriptionLanguageError as exc:
        raise RealtimeTranscriptionConfigurationError(str(exc)) from exc
    return {
        "provider": stored.provider,
        "model": stored.soniox_model if stored.provider == "soniox" else application.whisperx_model,
        "language": language,
        **options,
    }


def build_final_transcription_client(
    db: Session, job: Job, application_settings: Settings
) -> TranscriptionClient:
    request = job.transcription_request or {"provider": "whisperx"}
    if request["provider"] == "soniox":
        stored = get_async_transcription_settings(db)

        def checkpoint(state: dict[str, Any]) -> None:
            job.transcription_request = state
            db.commit()

        return SonioxClient(
            decrypt_soniox_key(stored, application_settings),
            model=request["model"],
            language=request["language"],
            language_hints=request.get("language_hints"),
            language_hints_strict=request.get("language_hints_strict", False),
            state={**request, "reference_id": str(job.id)},
            checkpoint=checkpoint,
        )
    if request["provider"] != "whisperx":
        raise RealtimeTranscriptionConfigurationError("全体文字起こしのプロバイダーが不正です")
    return WhisperXClient(
        base_url=application_settings.whisperx_base_url,
        api_key=application_settings.whisperx_api_key.get_secret_value(),
        model=request.get("model", application_settings.whisperx_model),
        language=request.get("language", application_settings.whisperx_language),
        timeout_seconds=application_settings.whisperx_timeout_seconds,
        max_attempts=application_settings.whisperx_max_attempts,
        retry_delay_seconds=application_settings.whisperx_retry_delay_seconds,
    )


def resolve_realtime_transcription(
    db: Session,
    application_settings: Settings,
    meeting: Meeting | None = None,
) -> tuple[RealtimeTranscriptionProvider, str, str, str | None]:
    settings = get_realtime_transcription_settings(db)
    # New captures always use Soniox, including installations with old settings.
    # The legacy worker client below remains available for already saved jobs.
    provider = RealtimeTranscriptionProvider.SONIOX
    if not settings.soniox_encrypted_api_key:
        raise RealtimeTranscriptionConfigurationError(
            "SonioxのリアルタイムAPI KeyをAI設定で保存してください"
        )
    return (
        provider,
        settings.soniox_model,
        _language(meeting, provider.value, settings.soniox_language),
        None,
    )


def _language(meeting: Meeting | None, provider: str, fallback: str) -> str:
    try:
        return provider_language(meeting, provider, fallback)[0]
    except TranscriptionLanguageError as exc:
        raise RealtimeTranscriptionConfigurationError(str(exc)) from exc


def build_realtime_transcription_client(
    db: Session,
    realtime_session: RealtimeSession,
    application_settings: Settings,
) -> TranscriptionClient:
    provider = RealtimeTranscriptionProvider(realtime_session.transcription_provider)
    if provider == RealtimeTranscriptionProvider.SONIOX:
        raise RealtimeTranscriptionConfigurationError(
            "Soniox LiveはブラウザのWebSocketで処理します"
        )
    if provider == RealtimeTranscriptionProvider.WHISPERX:
        transcript = db.get(TranscriptVersion, realtime_session.transcript_version_id)
        return WhisperXClient(
            base_url=application_settings.whisperx_base_url,
            api_key=application_settings.whisperx_api_key.get_secret_value(),
            model=transcript.model if transcript else application_settings.whisperx_model,
            language=transcript.language if transcript else application_settings.whisperx_language,
            timeout_seconds=application_settings.whisperx_timeout_seconds,
            max_attempts=application_settings.whisperx_max_attempts,
            retry_delay_seconds=application_settings.whisperx_retry_delay_seconds,
        )

    stored = get_realtime_transcription_settings(db)
    if stored.encrypted_api_key is None or not realtime_session.transcription_region:
        raise RealtimeTranscriptionConfigurationError(
            "Azure AI Speechの接続情報が設定されていません"
        )
    key = application_settings.master_encryption_key.get_secret_value()
    if not key:
        raise RealtimeTranscriptionConfigurationError("MASTER_ENCRYPTION_KEYが設定されていません")
    try:
        api_key = SecretCipher(key).decrypt(stored.encrypted_api_key)
    except (SecretConfigurationError, SecretDecryptionError) as exc:
        raise RealtimeTranscriptionConfigurationError(
            "Azure AI SpeechのAPI Keyを復号できません"
        ) from exc
    transcript = db.get(TranscriptVersion, realtime_session.transcript_version_id)
    if transcript is None:
        raise RealtimeTranscriptionConfigurationError("Live Transcriptが見つかりません")
    return AzureSpeechClient(
        region=realtime_session.transcription_region,
        api_key=api_key,
        language=transcript.language,
        timeout_seconds=application_settings.azure_speech_timeout_seconds,
        max_attempts=application_settings.azure_speech_max_attempts,
        retry_delay_seconds=application_settings.azure_speech_retry_delay_seconds,
    )
