from functools import lru_cache

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "speak-note"
    api_prefix: str = "/api/v1"
    database_url: str = "sqlite:///./speak_note.db"
    cors_origins: str = "http://localhost:3000"
    worker_poll_interval_seconds: float = 2.0
    storage_root: str = "/app/storage"
    max_audio_upload_mb: int = 1024
    max_video_upload_mb: int = 4096
    upload_chunk_mb: int = Field(default=50, ge=1, le=90)
    realtime_chunk_ms: int = 15000
    realtime_window_ms: int = 30000
    realtime_max_chunk_mb: int = 64
    realtime_resume_timeout_seconds: float = Field(default=600.0, gt=0)
    realtime_analysis_interval_ms: int = 30000
    realtime_analysis_draft_tail_ms: int = 2000
    realtime_analysis_timeout_seconds: float = 300.0
    whisperx_base_url: str = "http://host.docker.internal:8000"
    whisperx_api_key: SecretStr = SecretStr("")
    whisperx_model: str = "large-v3"
    whisperx_language: str = "ja"
    whisperx_timeout_seconds: float = 7200.0
    whisperx_max_attempts: int = 3
    whisperx_retry_delay_seconds: float = 1.0
    azure_speech_timeout_seconds: float = 60.0
    azure_speech_max_attempts: int = 3
    azure_speech_retry_delay_seconds: float = 1.0
    master_encryption_key: SecretStr = SecretStr("")
    llm_timeout_seconds: float = 1800.0
    ollama_num_ctx: int = 65536
    ollama_allowed_hosts: str = "host.docker.internal,localhost,127.0.0.1"

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    @property
    def cors_origin_list(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]

    @property
    def ollama_allowed_host_list(self) -> list[str]:
        return [host.strip() for host in self.ollama_allowed_hosts.split(",") if host.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
