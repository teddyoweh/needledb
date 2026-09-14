"""All indexes under one data directory."""
from __future__ import annotations

import threading
from pathlib import Path

from .config import AlreadyExists, IndexConfig, NotFound
from .index import Index


class Registry:
    def __init__(self, data_dir: str | Path):
        self.data_dir = Path(data_dir)
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self._indexes: dict[str, Index] = {}
        self._lock = threading.Lock()
        for child in sorted(self.data_dir.iterdir()):
            if child.is_dir() and (child / "index.json").exists():
                index = Index.open(child)
                self._indexes[index.cfg.name] = index

    def create_index(self, cfg: IndexConfig) -> Index:
        cfg.validate()
        with self._lock:
            if cfg.name in self._indexes:
                raise AlreadyExists(f"index {cfg.name!r} already exists")
            index = Index.create(self.data_dir / cfg.name, cfg)
            self._indexes[cfg.name] = index
            return index

    def get(self, name: str) -> Index:
        index = self._indexes.get(name)
        if index is None:
            raise NotFound(f"index {name!r} not found")
        return index

    def list(self) -> list[Index]:
        return [self._indexes[k] for k in sorted(self._indexes)]

    def delete_index(self, name: str) -> None:
        with self._lock:
            index = self._indexes.pop(name, None)
        if index is None:
            raise NotFound(f"index {name!r} not found")
        index.destroy()

    def close(self) -> None:
        """Snapshot and close every index. Safe to call more than once."""
        with self._lock:
            indexes, self._indexes = list(self._indexes.values()), {}
        for index in indexes:
            index.close(snapshot=True)
