import logging
from pathlib import Path

from app.core.config import settings

logger = logging.getLogger(__name__)


def media_disk_paths(*public_paths: str) -> list[Path]:
    """把服务端生成的公开媒体地址安全映射到媒体根目录内。"""
    root = Path(settings.MEDIA_ROOT).resolve()
    prefix = settings.MEDIA_PUBLIC_PREFIX.rstrip("/") + "/"
    paths: list[Path] = []
    for public_path in public_paths:
        if not public_path or not public_path.startswith(prefix):
            continue
        candidate = (root / public_path[len(prefix):]).resolve()
        try:
            candidate.relative_to(root)
        except ValueError:
            logger.warning("ignored media path outside storage root: %s", public_path)
            continue
        paths.append(candidate)
    return paths


def remove_media_paths(paths: list[Path]) -> None:
    """数据库提交后尽力清理文件；清理失败不反向破坏已完成的事务。"""
    for path in paths:
        try:
            path.unlink(missing_ok=True)
        except OSError:
            logger.warning("failed to remove media file: %s", path, exc_info=True)
