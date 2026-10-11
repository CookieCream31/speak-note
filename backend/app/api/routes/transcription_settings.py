from fastapi import APIRouter, HTTPException, status

from app.api.dependencies import DbSession
from app.core.config import get_settings as get_app_settings
from app.models.transcription import (
    AsyncTranscriptionSettings,
    RealtimeTranscriptionProvider,
    RealtimeTranscriptionSettings,
)
from app.schemas.transcription_settings import (
    AsyncTranscriptionSettingsRead,
    AsyncTranscriptionSettingsUpdate,
    RealtimeTranscriptionConnectionRead,
    RealtimeTranscriptionSettingsRead,
    RealtimeTranscriptionSettingsUpdate,
    SonioxSettingsUpdate,
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
from app.services.transcription.settings import (
    get_async_transcription_settings,
    get_realtime_transcription_settings,
)
from app.services.transcription.soniox import SonioxClient, SonioxError

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
        soniox_model=settings.soniox_model,
        soniox_language=settings.soniox_language,
        has_soniox_api_key=settings.soniox_encrypted_api_key is not None,
        soniox_api_key_masked=settings.soniox_api_key_hint,
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
    if "azure_region" in payload.model_fields_set:
        settings.azure_region = region
    if "azure_language" in payload.model_fields_set:
        settings.azure_language = payload.azure_language
    _update_soniox(settings, payload, realtime=True)
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
    if settings.provider == "soniox":
        return _test_soniox(settings)
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


def _update_soniox(
    settings: RealtimeTranscriptionSettings | AsyncTranscriptionSettings,
    payload: SonioxSettingsUpdate,
    *,
    realtime: bool,
) -> None:
    if payload.soniox_model is not None:
        prefix = "stt-rt-" if realtime else "stt-async-"
        if not payload.soniox_model.startswith(prefix) or not payload.soniox_model.isascii():
            raise HTTPException(
                status_code=422, detail=f"Sonioxモデルは{prefix}で始まるモデルを指定してください"
            )
        settings.soniox_model = payload.soniox_model
    if payload.soniox_language is not None:
        settings.soniox_language = payload.soniox_language
    if payload.soniox_api_key is not None:
        key = payload.soniox_api_key.strip()
        if not key:
            raise HTTPException(status_code=422, detail="Soniox API Keyを入力してください")
        settings.soniox_encrypted_api_key = _cipher().encrypt(key)
        settings.soniox_api_key_hint = secret_mask(key)
    elif payload.clear_soniox_api_key:
        settings.soniox_encrypted_api_key = None
        settings.soniox_api_key_hint = None
    if settings.provider == "soniox" and not settings.soniox_encrypted_api_key:
        raise HTTPException(status_code=422, detail="Soniox API Keyを入力してください")


def _async_read(settings: AsyncTranscriptionSettings) -> AsyncTranscriptionSettingsRead:
    return AsyncTranscriptionSettingsRead(
        provider=settings.provider,
        soniox_model=settings.soniox_model,
        soniox_language=settings.soniox_language,
        has_soniox_api_key=settings.soniox_encrypted_api_key is not None,
        soniox_api_key_masked=settings.soniox_api_key_hint,
        updated_at=settings.updated_at,
    )


@router.get("/async-settings", response_model=AsyncTranscriptionSettingsRead)
def read_async_settings(session: DbSession) -> AsyncTranscriptionSettingsRead:
    settings = get_async_transcription_settings(session)
    session.commit()
    session.refresh(settings)
    return _async_read(settings)


@router.put("/async-settings", response_model=AsyncTranscriptionSettingsRead)
def update_async_settings(
    payload: AsyncTranscriptionSettingsUpdate, session: DbSession
) -> AsyncTranscriptionSettingsRead:
    settings = get_async_transcription_settings(session)
    settings.provider = payload.provider.value
    _update_soniox(settings, payload, realtime=False)
    session.commit()
    session.refresh(settings)
    return _async_read(settings)


def _test_soniox(
    settings: RealtimeTranscriptionSettings | AsyncTranscriptionSettings,
) -> RealtimeTranscriptionConnectionRead:
    if not settings.soniox_encrypted_api_key:
        raise HTTPException(status_code=422, detail="Soniox API Keyを保存してください")
    try:
        key = _cipher().decrypt(settings.soniox_encrypted_api_key)
        client = SonioxClient(key, model=settings.soniox_model)
        client.test_connection()
        # Verify Temporary API keys permission without sending/billing audio.
        if isinstance(settings, RealtimeTranscriptionSettings):
            import uuid

            client.temporary_key(uuid.uuid4())
    except SecretDecryptionError as exc:
        raise HTTPException(status_code=422, detail="Soniox API Keyを復号できません") from exc
    except SonioxError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return RealtimeTranscriptionConnectionRead(success=True, message="Sonioxへの接続に成功しました")


@router.post("/async-settings/test", response_model=RealtimeTranscriptionConnectionRead)
def test_async_connection(session: DbSession) -> RealtimeTranscriptionConnectionRead:
    settings = get_async_transcription_settings(session)
    if settings.provider != "soniox":
        raise HTTPException(status_code=422, detail="Sonioxを選択して保存してください")
    return _test_soniox(settings)
