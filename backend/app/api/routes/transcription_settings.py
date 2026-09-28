from fastapi import APIRouter, HTTPException, status

from app.api.dependencies import DbSession
from app.core.config import get_settings as get_app_settings
from app.models.transcription import (
    RealtimeTranscriptionProvider,
    RealtimeTranscriptionSettings,
)
from app.schemas.transcription_settings import (
    RealtimeTranscriptionConnectionRead,
    RealtimeTranscriptionSettingsRead,
    RealtimeTranscriptionSettingsUpdate,
)
from app.services.llm import (
    SecretCipher,
    SecretConfigurationError,
    SecretDecryptionError,
    secret_mask,
)
from app.services.transcription.azure import (
    AzureSpeechClient,
    AzureSpeechError,
    validate_azure_region,
)
from app.services.transcription.settings import get_realtime_transcription_settings

router = APIRouter(prefix="/transcription", tags=["transcription-settings"])


def _cipher() -> SecretCipher:
    key = get_app_settings().master_encryption_key.get_secret_value()
    if not key:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="MASTER_ENCRYPTION_KEYが設定されていません",
        )
    try:
        return SecretCipher(key)
    except SecretConfigurationError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="MASTER_ENCRYPTION_KEYの形式が不正です",
        ) from exc


def _read(settings: RealtimeTranscriptionSettings) -> RealtimeTranscriptionSettingsRead:
    return RealtimeTranscriptionSettingsRead(
        provider=RealtimeTranscriptionProvider(settings.provider),
        azure_region=settings.azure_region,
        azure_language=settings.azure_language,
        has_api_key=settings.encrypted_api_key is not None,
        api_key_masked=settings.api_key_hint,
        updated_at=settings.updated_at,
    )


@router.get("/realtime-settings", response_model=RealtimeTranscriptionSettingsRead)
def read_settings(session: DbSession) -> RealtimeTranscriptionSettingsRead:
    settings = get_realtime_transcription_settings(session)
    session.commit()
    session.refresh(settings)
    return _read(settings)


@router.put("/realtime-settings", response_model=RealtimeTranscriptionSettingsRead)
def update_settings(
    payload: RealtimeTranscriptionSettingsUpdate,
    session: DbSession,
) -> RealtimeTranscriptionSettingsRead:
    settings = get_realtime_transcription_settings(session)
    region = payload.azure_region
    if region is not None:
        try:
            region = validate_azure_region(region)
        except AzureSpeechError as exc:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=str(exc),
            ) from exc
    settings.provider = payload.provider.value
    settings.azure_region = region
    settings.azure_language = payload.azure_language
    if payload.api_key is not None:
        settings.encrypted_api_key = _cipher().encrypt(payload.api_key)
        settings.api_key_hint = secret_mask(payload.api_key)
    elif payload.clear_api_key:
        settings.encrypted_api_key = None
        settings.api_key_hint = None

    if payload.provider == RealtimeTranscriptionProvider.AZURE_SPEECH:
        if settings.azure_region is None:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Azure AI Speechのリージョンを入力してください",
            )
        if settings.encrypted_api_key is None:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Azure AI SpeechのAPI Keyを入力してください",
            )
    session.commit()
    session.refresh(settings)
    return _read(settings)


@router.post(
    "/realtime-settings/test",
    response_model=RealtimeTranscriptionConnectionRead,
)
def test_azure_connection(session: DbSession) -> RealtimeTranscriptionConnectionRead:
    settings = get_realtime_transcription_settings(session)
    if settings.azure_region is None or settings.encrypted_api_key is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Azure AI SpeechのリージョンとAPI Keyを保存してください",
        )
    try:
        api_key = _cipher().decrypt(settings.encrypted_api_key)
        client = AzureSpeechClient(
            region=settings.azure_region,
            api_key=api_key,
            language=settings.azure_language,
            timeout_seconds=get_app_settings().azure_speech_timeout_seconds,
        )
        client.test_connection()
    except SecretDecryptionError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Azure AI SpeechのAPI Keyを復号できません",
        ) from exc
    except AzureSpeechError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc
    return RealtimeTranscriptionConnectionRead(
        success=True,
        message="Azure AI Speechへの接続に成功しました",
    )
