import time
from collections import defaultdict, deque

from fastapi import HTTPException


class LoginRateLimiter:
    """单进程登录失败滑动窗口。多进程部署时按 P2 文档迁移到 Redis。"""

    def __init__(self, max_failures: int = 10, window_seconds: int = 900) -> None:
        self.max_failures = max_failures
        self.window_seconds = window_seconds
        self._failures: dict[str, deque[float]] = defaultdict(deque)
        self._locked_until: dict[str, float] = {}

    def _now(self) -> float:
        return time.monotonic()

    def _prune(self, key: str, now: float) -> deque[float]:
        failures = self._failures[key]
        cutoff = now - self.window_seconds
        while failures and failures[0] <= cutoff:
            failures.popleft()
        return failures

    def check(self, key: str, now: float | None = None) -> None:
        current = self._now() if now is None else now
        locked_until = self._locked_until.get(key, 0)
        if locked_until > current:
            retry_after = max(1, int(locked_until - current))
            raise HTTPException(
                status_code=429,
                detail=f"登录尝试过多，请在 {retry_after} 秒后重试",
                headers={"Retry-After": str(retry_after)},
            )
        if locked_until:
            self.clear(key)
        self._prune(key, current)

    def fail(self, key: str, now: float | None = None) -> None:
        current = self._now() if now is None else now
        failures = self._prune(key, current)
        failures.append(current)
        if len(failures) >= self.max_failures:
            self._locked_until[key] = current + self.window_seconds

    def clear(self, key: str) -> None:
        self._failures.pop(key, None)
        self._locked_until.pop(key, None)


login_rate_limiter = LoginRateLimiter()
