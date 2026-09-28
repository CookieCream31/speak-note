from app.models.ai import AIProviderConfig, AIProviderType
from app.services.llm.base import LLMProvider
from app.services.llm.gemini import GeminiProvider
from app.services.llm.ollama import OllamaProvider
from app.services.llm.secrets import SecretCipher


def build_llm_provider(
    config: AIProviderConfig,
    *,
    cipher: SecretCipher | None = None,
    model: str | None = None,
    temperature: float = 0.2,
    timeout_seconds: float = 30.0,
    ollama_num_ctx: int = 65536,
) -> LLMProvider:
    if config.provider_type == AIProviderType.OLLAMA:
        if not config.base_url:
            raise ValueError("Ollama base URL is missing")
        return OllamaProvider(
            config.base_url,
            model,
            temperature,
            timeout_seconds=timeout_seconds,
            num_ctx=ollama_num_ctx,
        )

    if config.provider_type == AIProviderType.GEMINI:
        if not config.encrypted_api_key:
            raise ValueError("Gemini API key is missing")
        if cipher is None:
            raise ValueError("Secret cipher is required for Gemini")
        return GeminiProvider(
            cipher.decrypt(config.encrypted_api_key),
            model,
            temperature,
            timeout_seconds=timeout_seconds,
        )

    raise ValueError("Unsupported LLM provider")
