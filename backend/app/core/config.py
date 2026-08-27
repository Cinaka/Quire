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
    MYSQL_PASSWORD: str = Field(...)          # 必填，缺失则启动失败
    MYSQL_DB: str = "quire"

    # 可选：直接给完整 DSN 时优先用它（部署到云数据库、或临时切库时很方便）
    DATABASE_URL: str | None = None
    REDIS_ENABLED: bool = False
    REDIS_URL: str = "redis://127.0.0.1:6379/0"
    JWT_SECRET: str = Field(...)              # 必填
    JWT_ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 120
    REFRESH_TOKEN_EXPIRE_DAYS: int = 30
    CORS_ORIGINS: list[str] = ["http://localhost:5173", "http://127.0.0.1:5173"]

    @property
    def database_url(self) -> str:
        if self.DATABASE_URL:
            return self.DATABASE_URL
        from urllib.parse import quote_plus
        pwd = quote_plus(self.MYSQL_PASSWORD)   # 密码含 @ # / : 等字符时必须转义
        return (
            f"mysql+asyncmy://{self.MYSQL_USER}:{pwd}"
            f"@{self.MYSQL_HOST}:{self.MYSQL_PORT}/{self.MYSQL_DB}?charset=utf8mb4"
        )

settings = Settings()
