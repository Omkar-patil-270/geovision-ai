# backend/app/routers/cache_utils.py
"""
Tiny in-memory TTL cache shared by location / predictions / story routers.

This is intentionally simple (a dict + timestamps, no external deps) so it
works out of the box with zero extra infrastructure. It's process-local:
fine for a single backend instance / dev deployment. If GeoVisionAI is ever
run with multiple worker processes, swap this for Redis without changing
any call sites (get/set/get_or_set have the same shape).
"""
import time
import asyncio
import hashlib
import json
from typing import Any, Awaitable, Callable, Optional

_store: dict[str, tuple[float, Any]] = {}
_locks: dict[str, asyncio.Lock] = {}


def make_key(*parts: Any) -> str:
    """Builds a stable cache key out of any JSON-able parts."""
    raw = json.dumps(parts, sort_keys=True, default=str)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def get(key: str) -> Optional[Any]:
    entry = _store.get(key)
    if not entry:
        return None
    expires_at, value = entry
    if expires_at < time.time():
        _store.pop(key, None)
        return None
    return value


def set(key: str, value: Any, ttl_seconds: int = 3600) -> None:
    _store[key] = (time.time() + ttl_seconds, value)


async def get_or_set(key: str, ttl_seconds: int, factory: Callable[[], Awaitable[Any]]) -> Any:
    """
    Cache-aside helper with a per-key lock, so two concurrent requests for
    the same not-yet-cached key don't both hit the upstream API (e.g. two
    browser tabs searching "Kolhapur" at the same moment).
    """
    cached = get(key)
    if cached is not None:
        return cached

    lock = _locks.setdefault(key, asyncio.Lock())
    async with lock:
        # Another coroutine may have populated it while we waited for the lock.
        cached = get(key)
        if cached is not None:
            return cached
        value = await factory()
        if value is not None:
            set(key, value, ttl_seconds)
        return value


def clear() -> None:
    _store.clear()
    _locks.clear()
