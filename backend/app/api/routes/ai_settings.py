import uuid

from fastapi import APIRouter, HTTPException, status
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError

from app.api.dependencies import DbSession
from app.core.config import get_settings
from app.models.ai import AIProfile, AIProviderConfig, AIProviderType, AIUsage, AIUsageSetting
from app.schemas.ai import (
    AIConnectionTestRead,
    AIProfileCreate,
    AIProfileRead,
    AIProfileUpdate,
    AIProviderCreate,
    AIProviderRead,
    AIProviderUpdate,
    AIUsageSettingRead,
    AIUsageSettingUpdate,
)
from app.services.llm import (
    InvalidProviderURLError,
    LLMProvider,
    LLMProviderError,
    SecretCipher,
    SecretConfigurationError,
    SecretDecryptionError,
    build_llm_provider,
    secret_mask,
    validate_ollama_base_url,
)

router = APIRouter(prefix="/ai", tags=["ai-settings"])


def _provider_read(provider: AIProviderConfig) -> AIProviderRead:
    return AIProviderRead(
        id=provider.id,
        provider_type=provider.provider_type,
        name=provider.name,
        base_url=provider.base_url,
        enabled=provider.enabled,
        has_api_key=provider.encrypted_api_key is not None,
        api_key_masked=provider.api_key_hint,
        created_at=provider.created_at,
        updated_at=provider.updated_at,
    )


def _cipher() -> SecretCipher:
    key = get_settings().master_encryption_key.get_secret_value()
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


def _provider_or_404(session: DbSession, provider_id: uuid.UUID) -> AIProviderConfig:
    provider = session.get(AIProviderConfig, provider_id)
    if provider is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Provider not found")
    return provider


def _profile_or_404(session: DbSession, profile_id: uuid.UUID) -> AIProfile:
    profile = session.get(AIProfile, profile_id)
    if profile is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Profile not found")
    return profile


def _normalize_provider_url(provider_type: AIProviderType, base_url: str | None) -> str | None:
    if provider_type != AIProviderType.OLLAMA:
        return None
    if not base_url:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Ollama base URL is required",
        )
    allowed_hosts = set(get_settings().ollama_allowed_host_list)
    try:
        return validate_ollama_base_url(base_url, allowed_hosts)
    except InvalidProviderURLError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(exc),
        ) from exc


@router.get("/providers", response_model=list[AIProviderRead])
def list_providers(session: DbSession) -> list[AIProviderRead]:
    providers = session.scalars(select(AIProviderConfig).order_by(AIProviderConfig.created_at))
    return [_provider_read(provider) for provider in providers]


@router.post(
    "/providers",
    response_model=AIProviderRead,
    status_code=status.HTTP_201_CREATED,
)
def create_provider(payload: AIProviderCreate, session: DbSession) -> AIProviderRead:
    encrypted_api_key = None
    api_key_hint = None
    if payload.provider_type == AIProviderType.GEMINI and payload.api_key:
        encrypted_api_key = _cipher().encrypt(payload.api_key)
        api_key_hint = secret_mask(payload.api_key)
    provider = AIProviderConfig(
        provider_type=payload.provider_type,
        name=payload.name.strip(),
        base_url=_normalize_provider_url(payload.provider_type, payload.base_url),
        enabled=payload.enabled,
        encrypted_api_key=encrypted_api_key,
        api_key_hint=api_key_hint,
    )
    session.add(provider)
    try:
        session.commit()
    except IntegrityError as exc:
        session.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="Provider名は重複できません"
        ) from exc
    session.refresh(provider)
    return _provider_read(provider)


@router.patch("/providers/{provider_id}", response_model=AIProviderRead)
def update_provider(
    provider_id: uuid.UUID,
    payload: AIProviderUpdate,
    session: DbSession,
) -> AIProviderRead:
    provider = _provider_or_404(session, provider_id)
    fields = payload.model_dump(exclude_unset=True, exclude={"api_key", "clear_api_key"})
    if "name" in fields:
        fields["name"] = fields["name"].strip()
    if "base_url" in fields:
        fields["base_url"] = _normalize_provider_url(provider.provider_type, fields["base_url"])
    for field, value in fields.items():
        setattr(provider, field, value)

    if payload.api_key is not None:
        if provider.provider_type != AIProviderType.GEMINI:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="API keyはGemini Providerだけに設定できます",
            )
        provider.encrypted_api_key = _cipher().encrypt(payload.api_key)
        provider.api_key_hint = secret_mask(payload.api_key)
    elif payload.clear_api_key:
        provider.encrypted_api_key = None
        provider.api_key_hint = None

    try:
        session.commit()
    except IntegrityError as exc:
        session.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="Provider名は重複できません"
        ) from exc
    session.refresh(provider)
    return _provider_read(provider)


@router.delete("/providers/{provider_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_provider(provider_id: uuid.UUID, session: DbSession) -> None:
    provider = _provider_or_404(session, provider_id)
    session.delete(provider)
    try:
        session.commit()
    except IntegrityError as exc:
        session.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="使用中のProviderは削除できません",
        ) from exc


def _runtime_provider(config: AIProviderConfig) -> LLMProvider:
    try:
        cipher = _cipher() if config.provider_type == AIProviderType.GEMINI else None
        # 接続確認とモデル一覧取得は生成モデルに依存しない。
        return build_llm_provider(config, cipher=cipher)
    except (ValueError, SecretDecryptionError) as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(exc),
        ) from exc


@router.post("/providers/{provider_id}/test", response_model=AIConnectionTestRead)
async def test_provider_connection(
    provider_id: uuid.UUID,
    session: DbSession,
) -> AIConnectionTestRead:
    provider = _provider_or_404(session, provider_id)
    runtime = _runtime_provider(provider)
    try:
        await runtime.list_models()
    except LLMProviderError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc
    return AIConnectionTestRead(success=True, message="接続に成功しました")


@router.get("/providers/{provider_id}/models", response_model=AIConnectionTestRead)
async def list_provider_models(
    provider_id: uuid.UUID,
    session: DbSession,
) -> AIConnectionTestRead:
    provider = _provider_or_404(session, provider_id)
    runtime = _runtime_provider(provider)
    try:
        models = await runtime.list_models()
    except LLMProviderError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc
    return AIConnectionTestRead(success=True, message="モデルを取得しました", models=models)


@router.get("/profiles", response_model=list[AIProfileRead])
def list_profiles(session: DbSession) -> list[AIProfile]:
    return list(session.scalars(select(AIProfile).order_by(AIProfile.created_at)))


@router.post("/profiles", response_model=AIProfileRead, status_code=status.HTTP_201_CREATED)
def create_profile(payload: AIProfileCreate, session: DbSession) -> AIProfile:
    _provider_or_404(session, payload.provider_id)
    if payload.is_default:
        session.execute(update(AIProfile).values(is_default=False))
    profile = AIProfile(
        name=payload.name.strip(),
        provider_id=payload.provider_id,
        model=payload.model.strip(),
        temperature=payload.temperature,
        is_default=payload.is_default,
    )
    session.add(profile)
    try:
        session.commit()
    except IntegrityError as exc:
        session.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="Profile名は重複できません"
        ) from exc
    session.refresh(profile)
    return profile


@router.patch("/profiles/{profile_id}", response_model=AIProfileRead)
def update_profile(
    profile_id: uuid.UUID,
    payload: AIProfileUpdate,
    session: DbSession,
) -> AIProfile:
    profile = _profile_or_404(session, profile_id)
    fields = payload.model_dump(exclude_unset=True)
    if "provider_id" in fields:
        _provider_or_404(session, fields["provider_id"])
    if fields.get("is_default") is True:
        session.execute(
            update(AIProfile).where(AIProfile.id != profile.id).values(is_default=False)
        )
    if "name" in fields:
        fields["name"] = fields["name"].strip()
    if "model" in fields:
        fields["model"] = fields["model"].strip()
    for field, value in fields.items():
        setattr(profile, field, value)
    try:
        session.commit()
    except IntegrityError as exc:
        session.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="Profile名は重複できません"
        ) from exc
    session.refresh(profile)
    return profile


@router.delete("/profiles/{profile_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_profile(profile_id: uuid.UUID, session: DbSession) -> None:
    profile = _profile_or_404(session, profile_id)
    session.delete(profile)
    session.commit()


@router.get("/usage", response_model=list[AIUsageSettingRead])
def list_usage_settings(session: DbSession) -> list[AIUsageSetting]:
    existing = {item.usage: item for item in session.scalars(select(AIUsageSetting))}
    for usage in AIUsage:
        if usage not in existing:
            item = AIUsageSetting(usage=usage, disabled=False)
            session.add(item)
            existing[usage] = item
    session.commit()
    return [existing[usage] for usage in AIUsage]


@router.put("/usage/{usage}", response_model=AIUsageSettingRead)
def update_usage_setting(
    usage: AIUsage,
    payload: AIUsageSettingUpdate,
    session: DbSession,
) -> AIUsageSetting:
    if payload.profile_id is not None:
        _profile_or_404(session, payload.profile_id)
    setting = session.get(AIUsageSetting, usage)
    if setting is None:
        setting = AIUsageSetting(usage=usage)
        session.add(setting)
    setting.profile_id = None if payload.disabled else payload.profile_id
    setting.disabled = payload.disabled
    session.commit()
    session.refresh(setting)
    return setting
