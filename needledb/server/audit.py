"""An append-only record of security-relevant events: sign-ins, rejected keys, lockouts,
key and index changes. Kept in data/_system/audit.sqlite, capped to the newest events."""
from __future__ import annotations

import json
import sqlite3
import threading
import time
from pathlib import Path

from .auth import Principal

_SCHEMA = """
create table if not exists events (
    id         integer primary key autoincrement,
    ts         real not null,
    action     text not null,
    actor_id   text,
    actor_name text,
    ip         text,
    target     text,
    ok         integer not null default 1,
    detail     text
);
"""


class AuditLog:
    def __init__(self, directory: Path, keep: int = 20_000):
        directory.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(directory / "audit.sqlite", check_same_thread=False, isolation_level=None)
        self._conn.execute("pragma journal_mode = wal")
        self._conn.executescript(_SCHEMA)
        self._lock = threading.Lock()
        self._keep = keep
        self._writes = 0

    def record(self, action: str, *, actor: Principal | None = None, ip: str | None = None,
               target: str | None = None, ok: bool = True, detail: dict | None = None) -> None:
        with self._lock:
            self._conn.execute(
                "insert into events (ts, action, actor_id, actor_name, ip, target, ok, detail) "
                "values (?, ?, ?, ?, ?, ?, ?, ?)",
                (time.time(), action, actor.id if actor else None, actor.name if actor else None, ip, target,
                 1 if ok else 0, json.dumps(detail) if detail else None))
            self._writes += 1
            if self._writes % 500 == 0:
                self._conn.execute("delete from events where id <= (select max(id) from events) - ?", (self._keep,))

    def recent(self, limit: int = 50, before: int | None = None) -> list[dict]:
        with self._lock:
            rows = self._conn.execute(
                "select id, ts, action, actor_id, actor_name, ip, target, ok, detail from events "
                "where (? is null or id < ?) order by id desc limit ?", (before, before, limit)).fetchall()
        return [{"id": r[0], "ts": r[1], "action": r[2], "actorId": r[3], "actorName": r[4], "ip": r[5],
                 "target": r[6], "ok": bool(r[7]), "detail": json.loads(r[8]) if r[8] else None} for r in rows]

    def close(self) -> None:
        with self._lock:
            self._conn.close()
