"""Embedding-provider API keys saved from the web app.

Kept in _system/providers.json, readable only by the account the server runs as (mode 600),
and never returned by the API: descriptions carry the last four characters at most. Keys
set in the environment take precedence (see needledb.embed.key_source).
"""
from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path


class ProviderKeys:
    def __init__(self, directory: Path):
        self._path = directory / "providers.json"
        self._lock = threading.Lock()
        self._keys = self._read()

    def _read(self) -> dict[str, dict]:
        try:
            data = json.loads(self._path.read_text())
        except FileNotFoundError:
            return {}
        except (OSError, ValueError):
            return {}
        if not isinstance(data, dict):
            return {}
        return {k: v for k, v in data.items() if isinstance(v, dict) and isinstance(v.get("key"), str)}

    def _write(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self._path.with_suffix(".tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump(self._keys, f)
        os.chmod(tmp, 0o600)
        os.replace(tmp, self._path)

    def get(self, provider: str) -> str | None:
        entry = self._keys.get(provider)
        return entry["key"] if entry else None

    def set(self, provider: str, key: str, set_by: str | None) -> None:
        with self._lock:
            self._keys[provider] = {"key": key, "setAt": time.time(), "setBy": set_by}
            self._write()

    def remove(self, provider: str) -> bool:
        with self._lock:
            if self._keys.pop(provider, None) is None:
                return False
            self._write()
            return True

    def describe(self, provider: str) -> dict | None:
        entry = self._keys.get(provider)
        if not entry:
            return None
        return {"hint": entry["key"][-4:], "setAt": entry.get("setAt"), "setBy": entry.get("setBy")}
