"""One index: its namespaces, its storage, and the write path that keeps them in step.

Every write validates first, commits to SQLite, then applies to memory while holding
the collection's write lock — so an acknowledged write is durable, and a snapshot
(taken under the read lock) always matches the `seq` it records.
"""
from __future__ import annotations

import json
import math
import os
import shutil
import threading
import time
from dataclasses import asdict
from pathlib import Path

import numpy as np
import orjson

from .collection import Collection, Match
from .config import (
    MAX_ID_BYTES,
    MAX_METADATA_BYTES,
    MAX_TOP_K,
    MAX_UPSERT_BATCH,
    IndexConfig,
    InvalidArgument,
    NotFound,
)
from .filters import validate_metadata
from .storage import Storage

SNAPSHOT_EVERY = int(os.environ.get("NEEDLEDB_SNAPSHOT_EVERY", "50000"))


class Index:
    def __init__(self, directory: Path, cfg: IndexConfig):
        self.dir = directory
        self.cfg = cfg
        self.storage = Storage(directory)
        self.collections: dict[str, Collection] = {}
        self._ns_lock = threading.Lock()
        self._writes_since_snapshot = 0
        self._snapshot_lock = threading.Lock()

    # ---- lifecycle -------------------------------------------------------------------

    @classmethod
    def create(cls, directory: Path, cfg: IndexConfig) -> "Index":
        directory.mkdir(parents=True, exist_ok=False)
        index = cls(directory, cfg)
        index.save_config()
        return index

    @classmethod
    def open(cls, directory: Path) -> "Index":
        cfg = IndexConfig.from_dict(json.loads((directory / "index.json").read_text())).validate()
        index = cls(directory, cfg)
        index._load()
        return index

    def save_config(self) -> None:
        tmp = self.dir / "index.json.tmp"
        tmp.write_text(json.dumps(self.cfg.to_dict(), indent=2))
        tmp.replace(self.dir / "index.json")

    def configure(self, ef_search: int | None = None) -> None:
        if ef_search is not None:
            if not isinstance(ef_search, int) or isinstance(ef_search, bool) or not 1 <= ef_search <= 10_000:
                raise InvalidArgument("hnsw.ef_search must be an integer from 1 to 10000")
            self.cfg.hnsw.ef_search = ef_search
        self.save_config()

    def close(self, snapshot: bool = True) -> None:
        if snapshot:
            self.snapshot()
        self.storage.close()

    def destroy(self) -> None:
        self.storage.close()
        shutil.rmtree(self.dir, ignore_errors=True)

    # ---- namespaces ------------------------------------------------------------------

    def _collection(self, namespace: str, create: bool = False) -> Collection | None:
        coll = self.collections.get(namespace)
        if coll is None and create:
            with self._ns_lock:
                coll = self.collections.get(namespace)
                if coll is None:
                    coll = Collection(self.cfg, namespace)
                    self.collections[namespace] = coll
        return coll

    @staticmethod
    def _namespace(namespace: str | None) -> str:
        ns = namespace or ""
        if not isinstance(ns, str) or len(ns.encode()) > 256:
            raise InvalidArgument("namespace must be a string of at most 256 bytes")
        return ns

    def _snapshot_root(self, namespace: str) -> Path:
        name = "default" if namespace == "" else "ns-" + namespace.encode().hex()
        return self.dir / "snapshots" / name

    # ---- validation ------------------------------------------------------------------

    def _validate_records(self, records) -> tuple[list[str], np.ndarray, list[dict | None]]:
        if not isinstance(records, list) or not records:
            raise InvalidArgument("vectors must be a non-empty list")
        if len(records) > MAX_UPSERT_BATCH:
            raise InvalidArgument(f"at most {MAX_UPSERT_BATCH} vectors per upsert")
        ids, rows, metas = [], [], []
        for rec in records:
            if isinstance(rec, dict):
                rid, values, metadata = rec.get("id"), rec.get("values"), rec.get("metadata")
            elif isinstance(rec, (tuple, list)) and len(rec) in (2, 3):
                rid, values = rec[0], rec[1]
                metadata = rec[2] if len(rec) == 3 else None
            else:
                raise InvalidArgument(
                    "each vector must be {id, values, metadata?} or (id, values[, metadata])")
            if not isinstance(rid, str) or not rid or len(rid.encode()) > MAX_ID_BYTES:
                raise InvalidArgument(
                    f"vector ids must be non-empty strings of at most {MAX_ID_BYTES} bytes")
            if values is None:
                raise InvalidArgument(f"vector {rid!r} has no values")
            metadata = validate_metadata(metadata)
            if metadata and len(orjson.dumps(metadata)) > MAX_METADATA_BYTES:
                raise InvalidArgument(f"metadata for {rid!r} exceeds {MAX_METADATA_BYTES} bytes")
            ids.append(rid)
            rows.append(values)
            metas.append(metadata)
        try:
            mat = np.asarray(rows, dtype=np.float32)
        except (TypeError, ValueError):
            raise InvalidArgument("vector values must be lists of numbers of equal length") from None
        if mat.ndim != 2 or mat.shape[1] != self.cfg.dimension:
            got = mat.shape[1] if mat.ndim == 2 else "mixed lengths"
            raise InvalidArgument(f"vectors must have dimension {self.cfg.dimension}, got {got}")
        if not np.all(np.isfinite(mat)):
            raise InvalidArgument("vector values must be finite numbers")
        if self.cfg.metric == "cosine" and not np.all(np.any(mat != 0, axis=1)):
            raise InvalidArgument("cosine indexes cannot store an all-zero vector")
        return ids, mat, metas

    # ---- data plane ------------------------------------------------------------------

    def upsert(self, records, namespace: str | None = None) -> int:
        ns = self._namespace(namespace)
        ids, mat, metas = self._validate_records(records)
        coll = self._collection(ns, create=True)
        with coll.lock.write():
            self.storage.upsert(ns, ids, mat, metas)
            coll.apply_upsert(ids, mat, metas)
        self._after_write(len(ids))
        return len(ids)

    def query(self, *, vector=None, id: str | None = None, top_k: int = 10,
              namespace: str | None = None, filter: dict | None = None,
              include_values: bool = False, include_metadata: bool = False,
              ef_search: int | None = None) -> dict:
        started = time.perf_counter()
        ns = self._namespace(namespace)
        if not isinstance(top_k, int) or isinstance(top_k, bool) or not 1 <= top_k <= MAX_TOP_K:
            raise InvalidArgument(f"topK must be an integer from 1 to {MAX_TOP_K}")
        if (vector is None) == (id is None):
            raise InvalidArgument("provide exactly one of vector or id")
        if ef_search is not None and (not isinstance(ef_search, int) or not 1 <= ef_search <= 10_000):
            raise InvalidArgument("efSearch must be an integer from 1 to 10000")
        if filter is not None and not isinstance(filter, dict):
            raise InvalidArgument("filter must be an object")
        q = None
        if vector is not None:
            try:
                q = np.asarray(vector, dtype=np.float32)
            except (TypeError, ValueError):
                raise InvalidArgument("vector must be a list of numbers") from None
            if q.ndim != 1 or q.shape[0] != self.cfg.dimension:
                raise InvalidArgument(f"query vector must have dimension {self.cfg.dimension}")
            if not np.all(np.isfinite(q)):
                raise InvalidArgument("query vector values must be finite")
        coll = self._collection(ns)
        if coll is None:
            if id is not None:
                raise NotFound(f"vector {id!r} not found in namespace {ns!r}")
            matches, plan = [], "empty"
        else:
            with coll.lock.read():
                if id is not None:
                    q = coll.get_vector(id)
                matches, plan = coll.query(q, top_k, filter or None, ef_search,
                                           include_values, include_metadata)
        return {
            "matches": [_match_dict(m, include_values, include_metadata) for m in matches],
            "namespace": ns,
            "usage": {"latencyMs": round((time.perf_counter() - started) * 1000, 3), "plan": plan},
        }

    def fetch(self, ids: list[str], namespace: str | None = None, include_values: bool = True) -> dict:
        ns = self._namespace(namespace)
        if not isinstance(ids, list) or not all(isinstance(i, str) for i in ids):
            raise InvalidArgument("ids must be a list of strings")
        if len(ids) > 1000:
            raise InvalidArgument("at most 1000 ids per fetch")
        coll = self._collection(ns)
        if coll is None:
            return {"vectors": {}, "namespace": ns}
        with coll.lock.read():
            return {"vectors": coll.fetch(ids, include_values), "namespace": ns}

    def update(self, id: str, values=None, set_metadata: dict | None = None,
               namespace: str | None = None) -> None:
        ns = self._namespace(namespace)
        if not isinstance(id, str) or not id:
            raise InvalidArgument("id must be a non-empty string")
        if values is None and set_metadata is None:
            raise InvalidArgument("provide values, setMetadata, or both")
        if set_metadata is not None:
            set_metadata = validate_metadata(set_metadata)
        coll = self._collection(ns)
        if coll is None:
            raise NotFound(f"vector {id!r} not found in namespace {ns!r}")
        with coll.lock.write():
            slot = coll.id_to_slot.get(id)
            if slot is None:
                raise NotFound(f"vector {id!r} not found in namespace {ns!r}")
            merged = dict(coll.meta.get(slot) or {})
            merged.update(set_metadata or {})
            if values is not None:
                ids, mat, metas = self._validate_records([(id, values, merged or None)])
                self.storage.upsert(ns, ids, mat, metas)
                coll.apply_upsert(ids, mat, metas)
            else:
                if merged and len(orjson.dumps(merged)) > MAX_METADATA_BYTES:
                    raise InvalidArgument(f"metadata for {id!r} exceeds {MAX_METADATA_BYTES} bytes")
                self.storage.set_metadata(ns, id, merged or None)
                coll.apply_set_metadata(id, set_metadata or {})
        self._after_write(1)

    def delete(self, ids: list[str] | None = None, delete_all: bool = False,
               filter: dict | None = None, namespace: str | None = None) -> int:
        ns = self._namespace(namespace)
        if sum((ids is not None, bool(delete_all), filter is not None)) != 1:
            raise InvalidArgument("provide exactly one of ids, deleteAll or filter")
        if ids is not None and (not isinstance(ids, list) or not all(isinstance(i, str) for i in ids)):
            raise InvalidArgument("ids must be a list of strings")
        if filter is not None and (not isinstance(filter, dict) or not filter):
            raise InvalidArgument("filter must be a non-empty object")
        coll = self._collection(ns)
        if coll is None:
            return 0
        if delete_all:
            with coll.lock.write():
                removed = coll.live
                self.storage.drop_namespace(ns)
                with self._ns_lock:
                    self.collections.pop(ns, None)
                shutil.rmtree(self._snapshot_root(ns), ignore_errors=True)
            return removed
        with coll.lock.write():
            if filter is not None:
                ids = coll.matching_ids(filter)
            present = [i for i in dict.fromkeys(ids) if i in coll.id_to_slot]
            if present:
                self.storage.delete(ns, present)
                coll.apply_delete(present)
        self._after_write(len(present))
        return len(present)

    def list_ids(self, prefix: str | None = None, limit: int = 100,
                 pagination_token: str | None = None, namespace: str | None = None) -> dict:
        ns = self._namespace(namespace)
        if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 10_000:
            raise InvalidArgument("limit must be an integer from 1 to 10000")
        coll = self._collection(ns)
        if coll is None:
            return {"vectors": [], "pagination": {}, "namespace": ns}
        with coll.lock.read():
            page, nxt = coll.list_ids(prefix, limit, pagination_token)
        return {"vectors": [{"id": i} for i in page],
                "pagination": {"next": nxt} if nxt else {}, "namespace": ns}

    def describe_stats(self, filter: dict | None = None) -> dict:
        if filter is not None and not isinstance(filter, dict):
            raise InvalidArgument("filter must be an object")
        namespaces, total = {}, 0
        for ns, coll in sorted(self.collections.items()):
            with coll.lock.read():
                count = coll.count(filter)
                namespaces[ns] = {"vectorCount": count, "indexType": coll.ann_kind,
                                  "building": coll.building, "tombstones": coll.tombstones}
            total += count
        return {"dimension": self.cfg.dimension, "metric": self.cfg.metric,
                "totalVectorCount": total, "namespaces": namespaces, "indexFullness": 0.0}

    def summary(self) -> dict:
        colls = list(self.collections.values())
        building = any(c.building for c in colls)
        return {
            "name": self.cfg.name,
            "dimension": self.cfg.dimension,
            "metric": self.cfg.metric,
            "index_type": self.cfg.index_type,
            "hnsw": asdict(self.cfg.hnsw),
            "created_at": self.cfg.created_at,
            "vectorCount": sum(c.live for c in colls),
            "namespaceCount": len(colls),
            "annTypes": sorted({c.ann_kind for c in colls}),
            "memoryBytes": sum(c.memory_bytes() for c in colls),
            "storageBytes": self.storage.size_bytes(),
            "status": {"ready": True, "state": "Building" if building else "Ready"},
        }

    def wait_for_index(self, timeout: float | None = None) -> None:
        for coll in list(self.collections.values()):
            coll.wait_for_index(timeout)

    # ---- snapshots -------------------------------------------------------------------

    def _after_write(self, count: int) -> None:
        self._writes_since_snapshot += count
        if self._writes_since_snapshot >= SNAPSHOT_EVERY:
            self._writes_since_snapshot = 0
            threading.Thread(target=self.snapshot, name=f"snapshot-{self.cfg.name}",
                             daemon=True).start()

    def snapshot(self) -> None:
        """Snapshot every namespace, then purge delete markers all snapshots cover."""
        if not self._snapshot_lock.acquire(blocking=False):
            return
        try:
            seqs = []
            for ns, coll in list(self.collections.items()):
                coll.wait_for_index()
                with coll.lock.read():
                    if self.collections.get(ns) is not coll:
                        continue                      # dropped by deleteAll meanwhile
                    seq = self.storage.seq
                    coll.save(self._snapshot_root(ns), seq)
                seqs.append(seq)
            if seqs:
                self.storage.purge_deleted(min(seqs))
        finally:
            self._snapshot_lock.release()

    def _load(self) -> None:
        for ns in self.storage.namespaces():
            coll = self._collection(ns, create=True)
            with coll.lock.write():
                after = coll.load(self._snapshot_root(ns),
                                  lambda seq: self.storage.metadata_map(ns, seq))
                for chunk in self.storage.rows(ns, after_seq=after or 0, live_only=after is None):
                    self._replay(coll, chunk)
            if coll.live == 0 and not coll.building:
                with self._ns_lock:
                    self.collections.pop(ns, None)

    def _replay(self, coll: Collection, chunk: list[tuple]) -> None:
        dim = self.cfg.dimension
        ids, values, metas = [], [], []

        def flush():
            if ids:
                coll.apply_upsert(list(ids), np.stack(values), list(metas))
                ids.clear(), values.clear(), metas.clear()

        for rid, vals, metadata, _seq, deleted in chunk:
            if deleted:
                flush()
                coll.apply_delete([rid])
            else:
                ids.append(rid)
                values.append(np.frombuffer(vals, dtype=np.float32, count=dim))
                metas.append(orjson.loads(metadata) if metadata else None)
        flush()


def _match_dict(m: Match, include_values: bool, include_metadata: bool) -> dict:
    out = {"id": m.id, "score": m.score if math.isfinite(m.score) else None}
    if include_values:
        out["values"] = m.values
    if include_metadata:
        out["metadata"] = m.metadata
    return out
