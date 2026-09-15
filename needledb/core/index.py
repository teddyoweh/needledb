"""One index: its namespaces, its storage, and the write path that keeps them in step.

Every write validates first, commits to SQLite, then applies to memory while holding
the collection's write lock — so an acknowledged write is durable, and a snapshot
(taken under the read lock) always matches the `seq` it records.
"""
from __future__ import annotations

import base64
import binascii
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
    EmbedConfig,
    IndexConfig,
    InvalidArgument,
    NotFound,
)
from .filters import validate_metadata
from .storage import Storage

SNAPSHOT_EVERY = int(os.environ.get("NEEDLEDB_SNAPSHOT_EVERY", "50000"))
# Seconds of write quiet before a loaded index moves its vectors onto fp16 storage. Mid-load
# compaction would only be undone by the next batch, so it waits for the load to finish.
SETTLE_SECONDS = float(os.environ.get("NEEDLEDB_SETTLE_SECONDS", "3"))


def decode_vector(value, dimension: int):
    """Vectors may be JSON number lists or base64 little-endian float32 — the fast wire format."""
    if not isinstance(value, str):
        return value
    try:
        raw = base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError):
        raise InvalidArgument("a vector must be a list of numbers or base64-encoded float32") from None
    if len(raw) != dimension * 4:
        raise InvalidArgument(f"a base64 vector must hold {dimension} float32 values ({dimension * 4} bytes), "
                              f"got {len(raw)} bytes")
    return np.frombuffer(raw, dtype="<f4")
_KEEP = object()


class Index:
    def __init__(self, directory: Path, cfg: IndexConfig):
        self.dir = directory
        self.cfg = cfg
        self.storage = Storage(directory)
        self.collections: dict[str, Collection] = {}
        self._ns_lock = threading.Lock()
        self._writes_since_snapshot = 0
        self._snapshot_lock = threading.Lock()
        self._settle: threading.Timer | None = None

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

    def configure(self, ef_search: int | None = None, embed=_KEEP) -> None:
        """Change the search width, and/or connect (a dict), change or disconnect (None) the
        embedding model. A model can only be connected if it makes vectors of this dimension."""
        if embed is not _KEEP and embed is not None:
            embed = EmbedConfig.from_dict(embed)
            embed.validate(self.cfg.dimension)
        if ef_search is not None:
            if not isinstance(ef_search, int) or isinstance(ef_search, bool) or not 1 <= ef_search <= 10_000:
                raise InvalidArgument("hnsw.ef_search must be an integer from 1 to 10000")
            self.cfg.hnsw.ef_search = ef_search
        if embed is not _KEEP:
            self.cfg.embed = embed
        self.save_config()

    def close(self, snapshot: bool = True) -> None:
        if self._settle is not None:
            self._settle.cancel()
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
            rows.append(decode_vector(values, self.cfg.dimension))
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

    def _embed_records(self, records):
        """Give text records their vectors. Records that already have values pass through.

        A text record is `{id, text, metadata?}`; any other top-level fields are treated as
        metadata. The text itself is kept in metadata under the index's `embed.field`.
        """
        embed = self.cfg.embed
        if embed is None or not isinstance(records, list) or not 0 < len(records) <= MAX_UPSERT_BATCH:
            return records
        out, pending, texts = list(records), [], []
        for i, rec in enumerate(records):
            if not isinstance(rec, dict) or rec.get("values") is not None:
                continue
            text = rec.get("text", rec.get(embed.field))
            if text is None:
                continue
            if not isinstance(text, str) or not text.strip():
                raise InvalidArgument(f"record {rec.get('id')!r} needs non-empty text")
            metadata = rec.get("metadata")
            if metadata is not None and not isinstance(metadata, dict):
                raise InvalidArgument("metadata must be an object")
            extra = {k: v for k, v in rec.items() if k not in ("id", "values", "metadata", "text", embed.field)}
            out[i] = {"id": rec.get("id"), "metadata": {**extra, **(metadata or {}), embed.field: text}}
            pending.append(i)
            texts.append(text)
        if texts:
            from ..embed import embed_texts

            vectors = embed_texts(embed.provider, embed.model, self.cfg.dimension, texts, "document")
            for row, i in enumerate(pending):
                out[i]["values"] = vectors[row]
        return out

    def upsert(self, records, namespace: str | None = None) -> int:
        ns = self._namespace(namespace)
        ids, mat, metas = self._validate_records(self._embed_records(records))
        coll = self._collection(ns, create=True)
        with coll.lock.write():
            self.storage.upsert(ns, ids, mat, metas)
            coll.apply_upsert(ids, mat, metas)
        self._after_write(len(ids))
        return len(ids)

    def query(self, *, vector=None, id: str | None = None, text: str | None = None, top_k: int = 10,
              namespace: str | None = None, filter: dict | None = None,
              include_values: bool = False, include_metadata: bool = False,
              ef_search: int | None = None) -> dict:
        started = time.perf_counter()
        ns = self._namespace(namespace)
        if not isinstance(top_k, int) or isinstance(top_k, bool) or not 1 <= top_k <= MAX_TOP_K:
            raise InvalidArgument(f"topK must be an integer from 1 to {MAX_TOP_K}")
        if sum(x is not None for x in (vector, id, text)) != 1:
            raise InvalidArgument("provide exactly one of vector, id or text")
        embed_ms = None
        if text is not None:
            if self.cfg.embed is None:
                raise InvalidArgument("this index has no embedding model, so it can't search by text; send a vector")
            from ..embed import embed_cached  # repeated searches, e.g. while typing, skip the model

            embed_started = time.perf_counter()
            vector = embed_cached(self.cfg.embed.provider, self.cfg.embed.model, self.cfg.dimension, [text], "query")[0]
            embed_ms = round((time.perf_counter() - embed_started) * 1000, 3)
        if ef_search is not None and (not isinstance(ef_search, int) or not 1 <= ef_search <= 10_000):
            raise InvalidArgument("efSearch must be an integer from 1 to 10000")
        if filter is not None and not isinstance(filter, dict):
            raise InvalidArgument("filter must be an object")
        q = None
        if vector is not None:
            vector = decode_vector(vector, self.cfg.dimension)
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
            "usage": {"latencyMs": round((time.perf_counter() - started) * 1000, 3), "plan": plan,
                      **({"embedMs": embed_ms} if embed_ms is not None else {})},
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

    def vector_map(self, namespace: str | None = None, limit: int = 1500, color_by: str | None = None) -> dict:
        """A 2-D projection of a sample of a namespace, for the explorer.

        Each point carries its k-means `cluster`; with `color_by`, also that metadata
        field's value as `group`. `colorFields` lists fields worth colouring by: scalar
        values with 2–12 distinct values across the sample.
        """
        ns = self._namespace(namespace)
        if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 5000:
            raise InvalidArgument("limit must be an integer from 1 to 5000")
        if color_by is not None and (not isinstance(color_by, str) or not 0 < len(color_by) <= 128):
            raise InvalidArgument("color_by must be a metadata field name")
        empty = {"namespace": ns, "total": 0, "sampled": 0, "explained": [0.0, 0.0], "points": [], "colorFields": []}
        coll = self._collection(ns)
        if coll is None:
            return empty
        with coll.lock.read():
            total = coll.live
            projection = coll.projection(limit)
            if projection is None:
                return empty
            points, distinct = [], {}
            for slot, (x, y), cluster in zip(projection["slots"].tolist(), projection["coords"].tolist(),
                                             projection["clusters"].tolist()):
                metadata = coll.meta.get(slot) or {}
                point = {"id": coll.slot_ids[slot], "x": round(x, 5), "y": round(y, 5),
                         "cluster": int(cluster), "label": _label(metadata)}
                if color_by is not None:
                    point["group"] = _group(metadata.get(color_by))
                points.append(point)
                for field, value in metadata.items():
                    seen = distinct.setdefault(field, set())
                    if seen is not None and _group(value) is not None:
                        seen.add(_group(value))
                        if len(seen) > 12:
                            distinct[field] = None
        fields = sorted(f for f, seen in distinct.items() if seen is not None and len(seen) >= 2)
        return {"namespace": ns, "total": total, "sampled": len(points),
                "explained": [round(v, 4) for v in projection["explained"]], "points": points,
                "colorFields": fields}

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
            "storage": "fp16" if any(c.half_precision for c in colls) else "float32",
            "hnsw": asdict(self.cfg.hnsw),
            "embed": asdict(self.cfg.embed) if self.cfg.embed else None,
            "created_at": self.cfg.created_at,
            "vectorCount": sum(c.live for c in colls),
            "namespaceCount": len(colls),
            "annTypes": sorted({c.ann_kind for c in colls}),
            "memoryBytes": sum(c.memory_bytes() for c in colls),
            "storageBytes": self.storage.size_bytes(),
            "status": {"ready": True, "state": "Building" if building else "Ready"},
        }

    def wait_for_index(self, timeout: float | None = None) -> None:
        """Wait for background builds, then settle storage — what a finished load looks like."""
        for coll in list(self.collections.values()):
            coll.wait_for_index(timeout)
            coll.compact_storage()

    # ---- snapshots -------------------------------------------------------------------

    def _after_write(self, count: int) -> None:
        self._writes_since_snapshot += count
        if self._writes_since_snapshot >= SNAPSHOT_EVERY:
            self._writes_since_snapshot = 0
            threading.Thread(target=self.snapshot, name=f"snapshot-{self.cfg.name}",
                             daemon=True).start()
        self._settle_later()

    def _settle_later(self) -> None:
        """Restart the quiet-period timer that compacts storage once writing stops."""
        if SETTLE_SECONDS <= 0:
            return
        if self._settle is not None:
            self._settle.cancel()
        self._settle = threading.Timer(SETTLE_SECONDS, self._settle_now)
        self._settle.name = f"settle-{self.cfg.name}"
        self._settle.daemon = True
        self._settle.start()

    def _settle_now(self) -> None:
        for coll in list(self.collections.values()):
            if not coll.building:
                coll.compact_storage(quiet_for=SETTLE_SECONDS)

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


_LABEL_FIELDS = ("title", "name", "label", "heading", "headline", "text", "summary", "description")


def _label(metadata: dict | None) -> str | None:
    """The field a person would call a record by, trimmed for a tooltip."""
    for field in _LABEL_FIELDS:
        value = (metadata or {}).get(field)
        if isinstance(value, str) and value.strip():
            return value if len(value) <= 90 else value[:89] + "…"
    return None


def _group(value) -> str | None:
    """A metadata value as a colour group: short strings, booleans and whole numbers."""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    if isinstance(value, str) and value.strip() and len(value) <= 40:
        return value
    return None


def _match_dict(m: Match, include_values: bool, include_metadata: bool) -> dict:
    out = {"id": m.id, "score": m.score if math.isfinite(m.score) else None}
    if include_values:
        out["values"] = m.values
    if include_metadata:
        out["metadata"] = m.metadata
    return out
