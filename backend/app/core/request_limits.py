"""Bounded single-process attempt limits. Never trust raw forwarding headers here."""

import math
import threading
import time
from collections import deque

from fastapi import HTTPException


class AttemptLimiter:
    def __init__(self, max_keys: int = 4096) -> None:
        self.max_keys = max_keys
        self._buckets: dict[tuple[str, str], tuple[deque[float], int]] = {}
        self._lock = threading.Lock()
        self._last_prune = 0.0

    def consume(self, bucket: str, key: str, limit: int, window: int,
                *, now: float | None = None) -> None:
        current = time.monotonic() if now is None else now
        with self._lock:
            if current - self._last_prune >= 60 or len(self._buckets) >= self.max_keys:
                expired = [k for k, (q, w) in self._buckets.items()
                           if not q or q[-1] <= current - w]
                for k in expired:
                    del self._buckets[k]
                self._last_prune = current
            ident = (bucket, key)
            if ident not in self._buckets:
                if len(self._buckets) >= self.max_keys:
                    self._reject(60)
                self._buckets[ident] = (deque(), window)
            queue, _ = self._buckets[ident]
            while queue and queue[0] <= current - window:
                queue.popleft()
            if len(queue) >= limit:
                self._reject(max(1, math.ceil(queue[0] + window - current)))
            queue.append(current)

    @staticmethod
    def _reject(seconds: int) -> None:
        raise HTTPException(429, "请求过于频繁，请稍后重试", headers={
            "Retry-After": str(seconds), "Cache-Control": "private, no-store",
        })


attempt_limiter = AttemptLimiter()
