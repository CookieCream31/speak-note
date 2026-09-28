from sqlalchemy.orm import Session

from app.core.config import Settings
from app.models.realtime import RealtimeSession
from app.models.transcript import TranscriptVersion
from app.models.transcription import (
    RealtimeTranscriptionProvider,
    RealtimeTranscriptionSettings,
)
from app.services.llm import SecretCipher, SecretConfigurationError, SecretDecryptionError
from app.services.transcription.azure import AzureSpeechClient, AzureSpeechError
from app.services.transcription.base import TranscriptionClient
from app.services.transcription.client import WhisperXClient


class RealtimeTranscriptionConfigurationError(RuntimeError):
    pass


def get_realtime_transcription_settings(db: Session) -> RealtimeTranscriptionSettings:
    settings = db.get(RealtimeTranscriptionSettings, 1)
    if settings is None:
        settings = RealtimeTranscriptionSettings(id=1)
        db.add(settings)
        db.flush()
    return settings


def resolve_realtime_transcription(
    db: Session,
    application_settings: Settings,
) -> tuple[RealtimeTranscriptionProvider, str, str, str | None]:
    settings = get_realtime_transcription_settings(db)
    provider = RealtimeTranscriptionProvider(settings.provider)
    if provider == RealtimeTranscriptionProvider.AZURE_SPEECH:
        if not settings.azure_region or settings.encrypted_api_key is None:
            raise RealtimeTranscriptionConfigurationError(
                "Azure AI SpeechのリージョンとAPI KeyをAI設定で保存してください"
            )
        try:
            region = AzureSpeechClient(
                region=settings.azure_region,
                api_key="configuration-check",
            ).region
        except AzureSpeechError as exc:
            raise RealtimeTranscriptionConfigurationError(str(exc)) from exc
        return provider, "azure-speech", settings.azure_language, region
    return (
        provider,
        application_settings.whisperx_model,
        application_settings.whisperx_language,
        None,
    )


def build_realtime_transcription_client(
    db: Session,
    realtime_session: RealtimeSession,
    application_settings: Settings,
) -> TranscriptionClient:
    provider = RealtimeTranscriptionProvider(realtime_session.transcription_provider)
    if provider == RealtimeTranscriptionProvider.WHISPERX:
        return WhisperXClient(
            base_url=application_settings.whisperx_base_url,
            api_key=application_settings.whisperx_api_key.get_secret_value(),
            model=application_settings.whisperx_model,
            language=application_settings.whisperx_language,
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
        raise RealtimeTranscriptionConfigurationError(
            "MASTER_ENCRYPTION_KEYが設定されていません"
        )
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
