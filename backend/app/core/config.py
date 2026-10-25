from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

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
    REDIS_URL: str = "redis://127.0.0.1:6379/0"
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
