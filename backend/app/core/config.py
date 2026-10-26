from pydantic import Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", extra="ignore", hide_input_in_errors=True,
    )

    APP_NAME: str = "quire-api"
    DEBUG: bool = True
    API_V1_PREFIX: str = "/api/v1"
    MYSQL_HOST: str = "127.0.0.1"
    MYSQL_PORT: int = 3306
    MYSQL_USER: str = "quire"
    MYSQL_PASSWORD: str = Field(...)
    MYSQL_DB: str = "quire"
    DATABASE_URL: str | None = None
    REDIS_ENABLED: bool = False
    REDIS_URL: SecretStr = SecretStr("redis://127.0.0.1:6379/0")
    REDIS_KEY_PREFIX: str = Field(default="quire:dev:rl:v1", pattern=r"^[a-zA-Z0-9:_-]{1,80}$")
    REDIS_HMAC_SECRET: SecretStr = SecretStr("")
    REDIS_CONNECT_TIMEOUT: float = Field(default=0.5, gt=0, le=5)
    REDIS_SOCKET_TIMEOUT: float = Field(default=0.5, gt=0, le=5)
    REDIS_MAX_CONNECTIONS: int = Field(default=20, ge=1, le=200)
    REDIS_ATTEMPT_MAX_KEYS: int = Field(default=4096, ge=1, le=10000)
    REDIS_LOGIN_MAX_KEYS: int = Field(default=10000, ge=1, le=10000)

    @model_validator(mode="after")
    def validate_redis(self):
        if self.REDIS_ENABLED:
            if len(self.REDIS_HMAC_SECRET.get_secret_value()) < 32:
                raise ValueError("Redis requires an independent HMAC secret of at least 32 chars")
            if not self.REDIS_URL.get_secret_value().startswith(("redis://", "rediss://")):
                raise ValueError("Redis URL must use redis:// or rediss://")
        return self
    JWT_SECRET: str = Field(...)
    JWT_ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 15
    REFRESH_TOKEN_EXPIRE_DAYS: int = 7
    MEDIA_ROOT: str = "./media"
    MEDIA_PUBLIC_PREFIX: str = "/media"
    # Single-worker defaults; all limits remain positive and configurable.
    REGISTER_IP_PER_HOUR: int = Field(default=5, ge=1)
    REGISTER_GLOBAL_PER_DAY: int = Field(default=100, ge=1)
    LOGIN_IP_PER_MINUTE: int = Field(default=30, ge=1)
    API_IP_PER_MINUTE: int = Field(default=240, ge=1)
    UPLOAD_IP_PER_MINUTE: int = Field(default=20, ge=1)
    UPLOAD_USER_PER_MINUTE: int = Field(default=20, ge=1)
    MEDIA_READ_USER_PER_MINUTE: int = Field(default=120, ge=1)
    MEDIA_USER_MAX_BYTES: int = Field(default=524288000, ge=1)
    MEDIA_USER_MAX_COUNT: int = Field(default=1000, ge=1, le=10000)
    MEDIA_DISK_RESERVE_BYTES: int = Field(default=1073741824, ge=1)
    CORS_ORIGINS: list[str] = ["http://localhost:5173", "http://127.0.0.1:5173"]

    @property
    def database_url(self) -> str:
        if self.DATABASE_URL:
            return self.DATABASE_URL
        from urllib.parse import quote_plus

        pwd = quote_plus(self.MYSQL_PASSWORD)
        return (
            f"mysql+asyncmy://{self.MYSQL_USER}:{pwd}"
            f"@{self.MYSQL_HOST}:{self.MYSQL_PORT}/{self.MYSQL_DB}?charset=utf8mb4"
        )


settings = Settings()
