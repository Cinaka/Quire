"""POSIX no-replace publishing. Existing deterministic P4 paths stay unchanged."""

import fcntl
import os
import re
import shutil
import stat
import uuid
from contextlib import contextmanager
from pathlib import Path


@contextmanager
def media_directory(root: str, folder: str):
    if re.fullmatch(r"[0-9a-f]{4}", folder) is None:
        raise ValueError("invalid media directory")
    root_fd = os.open(Path(root).resolve(), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    directory = None
    try:
        try:
            os.mkdir(folder, 0o750, dir_fd=root_fd)
        except FileExistsError:
            pass
        directory = os.open(folder, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root_fd)
        yield directory
    finally:
        if directory is not None:
            os.close(directory)
        os.close(root_fd)


def _name(name: str) -> None:
    if re.fullmatch(r"[0-9a-f-]{36}(?:_thumb)?\.(?:jpg|png|webp|gif)", name) is None:
        raise ValueError("invalid media filename")


def existing_bytes(directory: int, name: str, limit: int = 10 * 1024 * 1024) -> bytes | None:
    _name(name)
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    except FileNotFoundError:
        return None
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= limit:
            raise FileExistsError("existing media is not a bounded regular file")
        data = stream.read(limit + 1)
        if len(data) != info.st_size:
            raise FileExistsError("existing media changed")
        return data


def publish_media(root: str, folder: str, files: dict[str, bytes], *,
                  allow_existing: bool, reserve_bytes: int) -> list[tuple[Path, int, int]]:
    """All new files are exclusive. Failure removes only inodes created by this attempt."""
    created: list[tuple[Path, int, int]] = []
    lock = os.open(Path(root).resolve() / ".upload.lock",
                   os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX)
        with media_directory(root, folder) as directory:
            pending = {}
            for name, data in files.items():
                old = existing_bytes(directory, name)
                if old is not None:
                    if not allow_existing or old != data:
                        raise FileExistsError("existing media cannot be replaced")
                else:
                    pending[name] = data
            if shutil.disk_usage(root).free - sum(map(len, pending.values())) < reserve_bytes:
                raise OSError("media disk reserve reached")
            for name, data in pending.items():
                temporary = ".upload-" + uuid.uuid4().hex
                fd = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW,
                             0o640, dir_fd=directory)
                try:
                    with os.fdopen(fd, "wb") as stream:
                        stream.write(data)
                        stream.flush()
                        os.fsync(stream.fileno())
                    # Atomic, no replacement even if another process won after preflight.
                    os.link(temporary, name, src_dir_fd=directory, dst_dir_fd=directory,
                            follow_symlinks=False)
                    info = os.stat(name, dir_fd=directory, follow_symlinks=False)
                    created.append((Path(root).resolve() / folder / name, info.st_dev, info.st_ino))
                finally:
                    os.unlink(temporary, dir_fd=directory)
            os.fsync(directory)
        return created
    except BaseException:
        discard_created(created)
        raise
    finally:
        os.close(lock)


def discard_created(created: list[tuple[Path, int, int]]) -> None:
    for path, device, inode in created:
        try:
            info = path.lstat()
            if (info.st_dev, info.st_ino) == (device, inode):
                path.unlink()
        except FileNotFoundError:
            pass


def stored_file_size(root: str, folder: str, name: str) -> int:
    _name(name)
    with media_directory(root, folder) as directory:
        try:
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        except FileNotFoundError:
            return 0
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode):
                raise OSError("media is not a regular file")
            return info.st_size
        finally:
            os.close(fd)
