"""SQLite storage for one index: the source of truth for every record.

Each write batch is one transaction that takes the next `seq`. Snapshots record the
`seq` they reflect, so a restart loads the snapshot and replays only newer rows.
Deleted records stay as tombstone rows (values dropped) until every namespace has
been snapshotted past them, so replay can apply the delete.
"""
from __future__ import annotations

import sqlite3
import threading
from pathlib import Path
from typing import Iterator

import numpy as np
import orjson

_SCHEMA = """
create table if not exists records (
    namespace text not null,
    id        text not null,
    vals      blob,
    metadata  blob,
    seq       integer not null,
    deleted   integer not null default 0,
    primary key (namespace, id)
);
create index if not exists records_ns_seq on records(namespace, seq);
create table if not exists meta (key text primary key, value text);
"""


class Storage:
    def __init__(self, directory: Path):
        self.path = directory / "data.sqlite"
        self._conn = sqlite3.connect(self.path, check_same_thread=False, isolation_level=None)
        self._conn.execute("pragma journal_mode = wal")
        self._conn.execute("pragma synchronous = normal")
        self._conn.executescript(_SCHEMA)
        self._lock = threading.Lock()
        row = self._conn.execute("select coalesce(max(seq), 0) from records").fetchone()
        # Rows that set the high-water mark can be purged, so it is also kept in `meta`;
        # seq must never move backwards or replay would skip newer writes.
        saved = self._conn.execute("select value from meta where key = 'seq'").fetchone()
        self.seq = max(int(row[0]), int(saved[0]) if saved else 0)

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    # ---- writes -------------------------------------------------------------------

    def _next_seq(self) -> int:
        self.seq += 1
        return self.seq

    def upsert(self, namespace: str, ids: list[str], values: np.ndarray,
               metas: list[dict | None]) -> int:
        with self._lock:
            seq = self._next_seq()
            rows = [
                (namespace, rid, values[i].astype(np.float32).tobytes(),
                 orjson.dumps(metas[i]) if metas[i] else None, seq)
                for i, rid in enumerate(ids)
            ]
            self._conn.execute("begin")
            try:
                self._conn.executemany(
                    "insert into records (namespace, id, vals, metadata, seq, deleted) "
                    "values (?, ?, ?, ?, ?, 0) on conflict (namespace, id) do update set "
                    "vals = excluded.vals, metadata = excluded.metadata, "
                    "seq = excluded.seq, deleted = 0",
                    rows,
                )
                self._conn.execute("commit")
            except BaseException:
                self._conn.execute("rollback")
                self.seq -= 1
                raise
            return seq

    def set_metadata(self, namespace: str, rid: str, metadata: dict | None) -> int:
        with self._lock:
            seq = self._next_seq()
            self._conn.execute(
                "update records set metadata = ?, seq = ? where namespace = ? and id = ?",
                (orjson.dumps(metadata) if metadata else None, seq, namespace, rid))
            return seq

    def delete(self, namespace: str, ids: list[str]) -> int:
        with self._lock:
            seq = self._next_seq()
            self._conn.execute("begin")
            try:
                self._conn.executemany(
                    "update records set deleted = 1, vals = null, metadata = null, seq = ? "
                    "where namespace = ? and id = ? and deleted = 0",
                    [(seq, namespace, rid) for rid in ids])
                self._conn.execute("commit")
            except BaseException:
                self._conn.execute("rollback")
                raise
            return seq

    def _save_seq(self) -> None:
        self._conn.execute(
            "insert into meta (key, value) values ('seq', ?) "
            "on conflict (key) do update set value = excluded.value", (str(self.seq),))

    def drop_namespace(self, namespace: str) -> None:
        with self._lock:
            self._save_seq()
            self._conn.execute("delete from records where namespace = ?", (namespace,))

    def purge_deleted(self, up_to_seq: int) -> None:
        with self._lock:
            self._save_seq()
            self._conn.execute("delete from records where deleted = 1 and seq <= ?", (up_to_seq,))

    # ---- reads --------------------------------------------------------------------

    def namespaces(self) -> list[str]:
        with self._lock:
            return [r[0] for r in self._conn.execute(
                "select distinct namespace from records")]

    def rows(self, namespace: str, after_seq: int = 0, live_only: bool = False,
             batch: int = 5000) -> Iterator[list[tuple]]:
        """(id, vals, metadata, seq, deleted) in seq order, in batches."""
        live = "and deleted = 0" if live_only else ""
        cols = "select id, vals, metadata, seq, deleted from records where namespace = ?"
        # Keyset pagination on (seq, id); the first page is strictly after `after_seq`.
        where, params = "seq > ?", (after_seq,)
        while True:
            with self._lock:
                chunk = self._conn.execute(
                    f"{cols} and {where} {live} order by seq, id limit ?",
                    (namespace, *params, batch)).fetchall()
            if not chunk:
                return
            yield chunk
            last_seq, last_id = chunk[-1][3], chunk[-1][0]
            where, params = "(seq > ? or (seq = ? and id > ?))", (last_seq, last_seq, last_id)

    def metadata_map(self, namespace: str, up_to_seq: int) -> dict[str, dict | None]:
        out: dict[str, dict | None] = {}
        with self._lock:
            cur = self._conn.execute(
                "select id, metadata from records where namespace = ? and deleted = 0 and seq <= ?",
                (namespace, up_to_seq))
            for rid, blob in cur:
                out[rid] = orjson.loads(blob) if blob else None
        return out

    def get_meta(self, key: str) -> str | None:
        with self._lock:
            row = self._conn.execute("select value from meta where key = ?", (key,)).fetchone()
        return row[0] if row else None

    def set_meta(self, key: str, value: str) -> None:
        with self._lock:
            self._conn.execute(
                "insert into meta (key, value) values (?, ?) "
                "on conflict (key) do update set value = excluded.value", (key, value))

    def size_bytes(self) -> int:
        total = 0
        for suffix in ("", "-wal", "-shm"):
            p = Path(str(self.path) + suffix)
            if p.exists():
                total += p.stat().st_size
        return total
