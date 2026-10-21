"""Bounded read-only resource evidence; no cloud/local conversion acknowledgement."""

import hashlib
import os
import re
import stat
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

MAX_RESOURCE_IDS = 64
MAX_PROOF_BYTES = 16 * 1024 * 1024
MAX_IMAGE_BYTES = 10 * 1024 * 1024
MIME_SUFFIX = {
    ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
}


def current_resource_ids(content, tag_ids):
    """Keep v1 JSON read-only; never chase URLs or guess references in unknown versions."""
    tags = {uuid.UUID(str(value)) for value in tag_ids}
    if any(value.version != 7 for value in tags) or len(tags) > MAX_RESOURCE_IDS:
        raise ValueError("unsupported resource identities")
    media = set()
    if content is not None:
        if not isinstance(content, dict) or set(content) != {"schemaVersion", "doc"}:
            raise ValueError("unsupported content")
        if (type(content["schemaVersion"]) is not int or content["schemaVersion"] != 1
                or not isinstance(content["doc"], dict)):
            raise ValueError("unsupported content version")
        if content["doc"].get("type") != "doc":
            raise ValueError("unsupported document")
        stack = [(content["doc"], 0)]
        count = 0
        while stack:
            value, depth = stack.pop()
            count += 1
            if depth > 64 or count > 100000:
                raise ValueError("content limit")
            if isinstance(value, dict):
                if value.get("type") == "image":
                    attrs = value.get("attrs")
                    src = attrs.get("src") if isinstance(attrs, dict) else None
                    if not isinstance(src, str) or not src.startswith("local://media/"):
                        raise ValueError("external image")
                    ident = uuid.UUID(src[len("local://media/"):])
                    if ident.version != 7 or src != f"local://media/{ident}":
                        raise ValueError("invalid image identity")
                    media.add(ident)
                    if len(media) > MAX_RESOURCE_IDS:
                        raise ValueError("resource limit")
                stack.extend((child, depth + 1) for child in value.values())
            elif isinstance(value, list):
                stack.extend((child, depth + 1) for child in value)
    return sorted(media), sorted(tags)


@dataclass(frozen=True)
class ImageProof:
    state: Literal["verified", "missing", "unavailable", "not_present"]
    size: int | None = None
    sha256: str | None = None
    mime: str | None = None
    read_bytes: int = 0  # Internal work budget; never part of the public DTO.


def stored_relative_path(url, prefix, ident, *, thumbnail=False):
    """Only the existing server-generated ID path, never a caller-supplied filesystem path."""
    if not isinstance(url, str) or not url:
        return None
    stem = f"{ident}_thumb" if thumbnail else str(ident)
    expected = f"{prefix.rstrip('/')}/{ident.hex[:4]}/{stem}"
    for suffix, mime in MIME_SUFFIX.items():
        if url == expected + suffix:
            return Path(ident.hex[:4]) / (stem + suffix), mime
    return None


def _mime(data):
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def _key(info):
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns


@dataclass(frozen=True)
class ImageRead:
    proof: ImageProof
    data: bytes | None = None


def _read_image(root, relative, expected_mime, remaining, *, capture=False):
    """One descriptor, one bounded read. Captured bytes and digest describe the same read."""
    if (not isinstance(relative, Path) or relative.is_absolute()
            or any(part in {".", ".."} for part in relative.parts) or not relative.parts
            or expected_mime not in MIME_SUFFIX.values() or remaining <= 0):
        return ImageRead(ImageProof("unavailable"))
    handles = []
    total = 0
    blocks = [] if capture else None
    try:
        directory = os.open(Path(root).resolve(), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        handles.append(directory)
        for part in relative.parts[:-1]:
            directory = os.open(
                part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory,
            )
            handles.append(directory)
        name = relative.parts[-1]
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        handles.append(fd)
        before = os.fstat(fd)
        if (not stat.S_ISREG(before.st_mode) or before.st_size <= 0
                or before.st_size > min(MAX_IMAGE_BYTES, remaining)):
            return ImageRead(ImageProof("unavailable"))
        digest = hashlib.sha256()
        total, header = 0, b""
        while True:
            block = os.read(fd, min(1024 * 1024, before.st_size - total + 1))
            if not block:
                break
            if not header:
                header = block[:12]
            total += len(block)
            if total > before.st_size:
                return ImageRead(ImageProof("unavailable", read_bytes=total))
            digest.update(block)
            if blocks is not None:
                blocks.append(block)
        after = os.fstat(fd)
        current = os.stat(name, dir_fd=directory, follow_symlinks=False)
        if (total != before.st_size or _key(before) != _key(after)
                or _key(after) != _key(current) or _mime(header) != expected_mime):
            return ImageRead(ImageProof("unavailable", read_bytes=total))
        proof = ImageProof("verified", total, digest.hexdigest(), expected_mime, total)
        return ImageRead(proof, b"".join(blocks) if blocks is not None else None)
    except FileNotFoundError:
        return ImageRead(ImageProof("missing"))
    except OSError:
        return ImageRead(ImageProof("unavailable", read_bytes=total))
    finally:
        for fd in reversed(handles):
            os.close(fd)


def probe_image(root, relative, expected_mime, remaining=MAX_PROOF_BYTES):
    """Read-only proof API stays byte-free; never perform a second, unbound file read."""
    return _read_image(root, relative, expected_mime, remaining).proof


def read_expected_image(root, relative, expected_mime, expected_size, expected_sha256):
    """Return bytes only if the exact bounded descriptor read matches the caller's proof."""
    if (type(expected_size) is not int or not 1 <= expected_size <= MAX_IMAGE_BYTES
            or not isinstance(expected_sha256, str)
            or re.fullmatch(r"[0-9a-f]{64}", expected_sha256) is None):
        return ImageRead(ImageProof("unavailable"))
    result = _read_image(root, relative, expected_mime, expected_size, capture=True)
    if result.proof.state != "verified":
        return result
    if result.proof.size != expected_size or result.proof.sha256 != expected_sha256:
        return ImageRead(ImageProof("unavailable", read_bytes=result.proof.read_bytes))
    return result
