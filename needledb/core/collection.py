"""One namespace of one index: vectors, ids, the FAISS index and the search planner.

Slots are FAISS labels: both index types are filled positionally, so slot i is the
i-th vector added. The vectors themselves live only inside FAISS — reads use a
zero-copy view of the index's flat storage, so RAM holds one copy, not two.

Deleting or overwriting a record tombstones its slot. Tombstoned slots are excluded
from every search through an IDSelector, and once they pile up a background rebuild
compacts them away. Writes that land during a rebuild are logged and replayed onto
the new state before it is swapped in.

Cosine indexes store unit vectors (inner product == cosine similarity) and keep each
record's original norm, so fetch returns exactly the values that were written.
"""
from __future__ import annotations

import bisect
import json
import shutil
import threading
from dataclasses import dataclass
from pathlib import Path

import faiss
import numpy as np

from .config import (
    AUTO_HNSW_THRESHOLD,
    BRUTE_FORCE_FRACTION,
    BRUTE_FORCE_LIMIT,
    IndexConfig,
    InvalidArgument,
    NotFound,
)
from .filters import MetadataIndex
from .rwlock import RWLock

COMPACT_MIN_DEAD = 1_000
COMPACT_FRACTION = 0.2
_EXACT_CHUNK = 4_096


@dataclass
class Match:
    id: str
    score: float
    values: list[float] | None = None
    metadata: dict | None = None


class Collection:
    def __init__(self, cfg: IndexConfig, namespace: str):
        self.cfg = cfg
        self.namespace = namespace
        self.d = cfg.dimension
        self.lock = RWLock()
        self._euclidean = cfg.metric == "euclidean"
        self._cosine = cfg.metric == "cosine"
        self._faiss_metric = faiss.METRIC_L2 if self._euclidean else faiss.METRIC_INNER_PRODUCT
        self._job: threading.Thread | None = None
        self._ops: list[tuple] | None = None
        self._generation = 0
        kind = "hnsw" if cfg.index_type == "hnsw" else "flat"
        self._set_state(self._new_ann(kind), kind, np.zeros(0, np.float32),
                        np.zeros(0, bool), [], MetadataIndex())

    # ---- state -------------------------------------------------------------------

    def _new_ann(self, kind: str) -> faiss.Index:
        if kind == "flat":
            return faiss.IndexFlatL2(self.d) if self._euclidean else faiss.IndexFlatIP(self.d)
        idx = faiss.IndexHNSWFlat(self.d, self.cfg.hnsw.m, self._faiss_metric)
        idx.hnsw.efConstruction = self.cfg.hnsw.ef_construction
        idx.hnsw.efSearch = self.cfg.hnsw.ef_search
        return idx

    def _set_state(self, ann: faiss.Index, kind: str, norms: np.ndarray, tomb: np.ndarray,
                   slot_ids: list[str | None], meta: MetadataIndex,
                   id_to_slot: dict[str, int] | None = None) -> None:
        self._ann = ann
        self.ann_kind = kind
        self._storage = ann if kind == "flat" else faiss.downcast_index(ann.storage)
        self.n = int(ann.ntotal)
        cap = max(self.n, 1024)
        self._norm = np.zeros(cap, np.float32)
        self._norm[: self.n] = norms
        self._tomb = np.zeros(cap, bool)
        self._tomb[: self.n] = tomb
        self.slot_ids = slot_ids
        if id_to_slot is None:
            id_to_slot = {rid: s for s, rid in enumerate(slot_ids) if not tomb[s]}
        self.id_to_slot = id_to_slot
        self.live = len(id_to_slot)
        self.meta = meta

    def _vectors(self) -> np.ndarray:
        """Zero-copy (n x d) view of the stored vectors. Valid until the next add, which
        only happens under the write lock — so it is safe for the life of any read."""
        if self.n == 0:
            return np.empty((0, self.d), np.float32)
        return faiss.rev_swig_ptr(self._storage.get_xb(), self.n * self.d).reshape(self.n, self.d)

    def _original(self, slot: int) -> np.ndarray:
        row = self._vectors()[slot]
        return row * self._norm[slot] if self._cosine else row.copy()

    @property
    def building(self) -> bool:
        return self._job is not None

    @property
    def tombstones(self) -> int:
        return self.n - self.live

    def memory_bytes(self) -> int:
        """Estimate of resident bytes: vectors, HNSW links, and per-slot bookkeeping."""
        vectors = self.n * self.d * 4
        links = self.n * self.cfg.hnsw.m * 2 * 4 * 1.05 if self.ann_kind == "hnsw" else 0
        return int(vectors + links + self.n * 5)

    # ---- writes (caller holds the write lock) ---------------------------------------

    def apply_upsert(self, ids: list[str], values: np.ndarray, metas: list[dict | None]) -> None:
        """Insert or overwrite records. `values` are the original vectors (count x d)."""
        if not ids:
            return
        if self._ops is not None:
            self._ops.append(("upsert", ids, values, metas))
        last = {rid: i for i, rid in enumerate(ids)}          # last occurrence wins
        if len(last) != len(ids):
            keep = sorted(last.values())
            ids = [ids[i] for i in keep]
            values = values[keep]
            metas = [metas[i] for i in keep]
        norms = np.linalg.norm(values, axis=1).astype(np.float32)
        if self._cosine:
            if np.any(norms == 0):
                raise InvalidArgument("cosine indexes cannot store an all-zero vector")
            stored = values / norms[:, None]
        else:
            stored = values
        for rid in ids:
            old = self.id_to_slot.get(rid)
            if old is not None:
                self._tombstone(old)
        count, start = len(ids), self.n
        self._grow(start + count)
        self._norm[start:start + count] = norms
        self._tomb[start:start + count] = False
        self._ann.add(np.ascontiguousarray(stored, dtype=np.float32))
        for offset, rid in enumerate(ids):
            slot = start + offset
            self.slot_ids.append(rid)
            self.id_to_slot[rid] = slot
            self.meta.add(slot, metas[offset])
        self.n += count
        self.live += count
        self._maybe_rebuild()

    def apply_set_metadata(self, rid: str, set_metadata: dict) -> None:
        slot = self.id_to_slot.get(rid)
        if slot is None:
            raise NotFound(f"vector {rid!r} not found in namespace {self.namespace!r}")
        if self._ops is not None:
            self._ops.append(("meta", rid, set_metadata))
        merged = dict(self.meta.get(slot) or {})
        merged.update(set_metadata)
        self.meta.remove(slot)
        self.meta.add(slot, merged or None)

    def apply_delete(self, ids: list[str]) -> list[str]:
        removed = [rid for rid in ids if rid in self.id_to_slot]
        if not removed:
            return removed
        if self._ops is not None:
            self._ops.append(("delete", removed))
        for rid in removed:
            self._tombstone(self.id_to_slot[rid])
        self._maybe_rebuild()
        return removed

    def _grow(self, slots: int) -> None:
        if slots <= len(self._norm):
            return
        cap = max(slots, len(self._norm) * 2)
        norm = np.zeros(cap, np.float32)
        norm[: self.n] = self._norm[: self.n]
        tomb = np.zeros(cap, bool)
        tomb[: self.n] = self._tomb[: self.n]
        self._norm, self._tomb = norm, tomb

    def _tombstone(self, slot: int) -> None:
        if self._tomb[slot]:
            return
        self._tomb[slot] = True
        rid = self.slot_ids[slot]
        if self.id_to_slot.get(rid) == slot:
            del self.id_to_slot[rid]
        self.meta.remove(slot)
        self.live -= 1

    # ---- background rebuild: flat -> HNSW, and compaction ----------------------------

    def _maybe_rebuild(self) -> None:
        if self._job is not None:
            return
        promote = (self.cfg.index_type == "auto" and self.ann_kind == "flat"
                   and self.live >= AUTO_HNSW_THRESHOLD)
        dead = self.tombstones
        compact = dead >= COMPACT_MIN_DEAD and dead >= COMPACT_FRACTION * self.n
        if promote or compact:
            self._start_rebuild("hnsw" if promote else self.ann_kind)

    def _start_rebuild(self, kind: str) -> None:
        live_slots = np.flatnonzero(~self._tomb[: self.n])
        vectors = self._vectors()[live_slots]                      # a copy
        ids = [self.slot_ids[s] for s in live_slots]
        norms = self._norm[live_slots].copy()
        metas = [self.meta.get(s) for s in live_slots]
        self._ops = []
        thread = threading.Thread(
            target=self._rebuild, args=(kind, vectors, ids, norms, metas, self._generation),
            name=f"rebuild-{self.cfg.name}-{self.namespace or 'default'}", daemon=True)
        self._job = thread
        thread.start()

    def _rebuild(self, kind, vectors, ids, norms, metas, generation) -> None:
        try:
            ann = self._new_ann(kind)
            if ids:
                ann.add(vectors)
            del vectors
            meta = MetadataIndex()
            for slot, m in enumerate(metas):
                meta.add(slot, m)
            id_to_slot = {rid: s for s, rid in enumerate(ids)}
        except BaseException:
            with self.lock.write():
                self._job, self._ops = None, None
            raise
        with self.lock.write():
            if generation != self._generation:
                return
            ops, self._ops = self._ops or [], None
            self._set_state(ann, kind, norms, np.zeros(len(ids), bool), ids, meta, id_to_slot)
            self._generation += 1
            self._job = None
            for op in ops:
                if op[0] == "upsert":
                    self.apply_upsert(op[1], op[2], op[3])
                elif op[0] == "delete":
                    self.apply_delete(op[1])
                elif op[1] in self.id_to_slot:
                    self.apply_set_metadata(op[1], op[2])
            self._maybe_rebuild()

    def wait_for_index(self, timeout: float | None = None) -> None:
        """Block until background rebuilds (including chained ones) have finished."""
        while (thread := self._job) is not None:
            thread.join(timeout)
            if timeout is not None:
                return

    # ---- reads (caller holds the read lock) -----------------------------------------

    def get_vector(self, rid: str) -> np.ndarray:
        slot = self.id_to_slot.get(rid)
        if slot is None:
            raise NotFound(f"vector {rid!r} not found in namespace {self.namespace!r}")
        return self._original(slot).astype(np.float32)

    def fetch(self, ids: list[str]) -> dict[str, dict]:
        out = {}
        for rid in ids:
            slot = self.id_to_slot.get(rid)
            if slot is not None:
                out[rid] = {"id": rid, "values": self._original(slot).astype(np.float32).tolist(),
                            "metadata": self.meta.get(slot)}
        return out

    def list_ids(self, prefix: str | None, limit: int, after: str | None) -> tuple[list[str], str | None]:
        ids = sorted(rid for rid in self.id_to_slot if not prefix or rid.startswith(prefix))
        if after:
            ids = ids[bisect.bisect_right(ids, after):]
        page = ids[:limit]
        return page, (page[-1] if len(ids) > limit else None)

    def count(self, flt: dict | None) -> int:
        if not flt:
            return self.live
        return int(np.count_nonzero(self.meta.evaluate(flt, self.n) & ~self._tomb[: self.n]))

    def matching_ids(self, flt: dict) -> list[str]:
        mask = self.meta.evaluate(flt, self.n) & ~self._tomb[: self.n]
        return [self.slot_ids[s] for s in np.flatnonzero(mask)]

    def query(self, vector: np.ndarray, top_k: int, flt: dict | None = None,
              ef_search: int | None = None, include_values: bool = False,
              include_metadata: bool = False) -> tuple[list[Match], str]:
        if self.live == 0:
            return [], "empty"
        q = np.array(vector, dtype=np.float32)
        if self._cosine:
            qn = float(np.linalg.norm(q))
            if qn == 0:
                raise InvalidArgument("cosine queries cannot use an all-zero vector")
            q /= qn
        n, k = self.n, min(top_k, self.live)
        ef = ef_search or self.cfg.hnsw.ef_search

        if flt:
            mask = self.meta.evaluate(flt, n) & ~self._tomb[:n]
            count = int(np.count_nonzero(mask))
            if count == 0:
                return [], "filtered-empty"
            k = min(k, count)
            if count <= max(BRUTE_FORCE_LIMIT, int(BRUTE_FORCE_FRACTION * self.live)):
                slots, scores = self._exact(q, np.flatnonzero(mask), k)
                plan = "filtered-exact"
            elif self.ann_kind == "flat":
                slots, scores = self._ann_search(q, k, mask, ef)
                plan = "filtered-exact"
            else:
                selectivity = count / self.live
                boosted = int(min(max(ef / np.sqrt(selectivity), ef), 4 * ef))
                slots, scores = self._ann_search(q, k, mask, boosted)
                plan = "filtered-hnsw"
        else:
            mask = ~self._tomb[:n] if self.tombstones else None
            slots, scores = self._ann_search(q, k, mask, ef)
            plan = "exact" if self.ann_kind == "flat" else "hnsw"

        matches = []
        for slot, score in zip(slots.tolist(), scores.tolist()):
            if slot < 0:
                continue
            m = Match(id=self.slot_ids[slot], score=score)
            if include_values:
                m.values = self._original(slot).astype(np.float32).tolist()
            if include_metadata:
                m.metadata = self.meta.get(slot)
            matches.append(m)
        return matches, plan

    def _exact(self, q: np.ndarray, cand: np.ndarray, k: int) -> tuple[np.ndarray, np.ndarray]:
        """Exact top-k over candidate slots, in chunks so memory stays bounded."""
        xb = self._vectors()
        qq = float(q @ q)
        best_slots = np.empty(0, np.int64)
        best_keys = np.empty(0, np.float32)
        for start in range(0, len(cand), _EXACT_CHUNK):
            chunk = cand[start:start + _EXACT_CHUNK]
            dots = xb[chunk] @ q
            # Higher key is better; for euclidean the key is the negated squared distance.
            keys = (2.0 * dots - self._norm[chunk] ** 2 - qq) if self._euclidean else dots
            slots = np.concatenate([best_slots, chunk])
            keys = np.concatenate([best_keys, keys.astype(np.float32)])
            if len(keys) > k:
                part = np.argpartition(-keys, k - 1)[:k]
                slots, keys = slots[part], keys[part]
            best_slots, best_keys = slots, keys
        order = np.argsort(-best_keys, kind="stable")
        keys = best_keys[order]
        return best_slots[order], (-keys if self._euclidean else keys)

    def _ann_search(self, q: np.ndarray, k: int, mask: np.ndarray | None,
                    ef: int) -> tuple[np.ndarray, np.ndarray]:
        if self.ann_kind == "hnsw":
            params = faiss.SearchParametersHNSW()
            params.efSearch = max(int(ef), k)
        else:
            params = faiss.SearchParameters()
        bits = None
        if mask is not None:
            bits = np.packbits(mask, bitorder="little")    # bit i == label i; kept alive below
            params.sel = faiss.IDSelectorBitmap(len(mask), faiss.swig_ptr(bits))
        distances, labels = self._ann.search(q.reshape(1, -1), k, params=params)
        del bits
        return labels[0], distances[0]

    # ---- snapshots ------------------------------------------------------------------

    def save(self, root: Path, seq: int) -> None:
        """Write a snapshot as root/<seq>/ and point root/CURRENT at it. Caller holds
        the read lock, so the files match `seq` exactly."""
        root.mkdir(parents=True, exist_ok=True)
        target, tmp = root / str(seq), root / f".{seq}.tmp"
        shutil.rmtree(tmp, ignore_errors=True)
        tmp.mkdir()
        faiss.write_index(self._ann, str(tmp / "index.faiss"))
        with open(tmp / "slots.npz", "wb") as f:
            np.savez(f, norm=self._norm[: self.n], tomb=self._tomb[: self.n])
        (tmp / "slots.json").write_text(json.dumps(
            {"seq": seq, "n": self.n, "ann_kind": self.ann_kind, "slot_ids": self.slot_ids}))
        shutil.rmtree(target, ignore_errors=True)
        tmp.rename(target)
        pointer = root / "CURRENT.tmp"
        pointer.write_text(str(seq))
        pointer.replace(root / "CURRENT")
        for old in root.iterdir():
            if old.is_dir() and old.name != str(seq):
                shutil.rmtree(old, ignore_errors=True)

    def load(self, root: Path, metadata_for) -> int | None:
        """Restore the CURRENT snapshot and return its seq, or None when there is no
        usable snapshot (the caller then rebuilds from storage)."""
        try:
            seq = int((root / "CURRENT").read_text())
            snap = root / str(seq)
            info = json.loads((snap / "slots.json").read_text())
            with np.load(snap / "slots.npz") as arrays:
                norm, tomb = arrays["norm"], arrays["tomb"]
            ann = faiss.read_index(str(snap / "index.faiss"))
        except (OSError, ValueError, KeyError, RuntimeError):
            return None
        slot_ids = info["slot_ids"]
        if not (ann.d == self.d and ann.ntotal == info["n"] == len(slot_ids) == len(norm) == len(tomb)
                and ann.metric_type == self._faiss_metric and info["seq"] == seq):
            return None
        metadata = metadata_for(seq)
        meta = MetadataIndex()
        for slot, rid in enumerate(slot_ids):
            if not tomb[slot]:
                meta.add(slot, metadata.get(rid))
        self._set_state(ann, info["ann_kind"], norm, tomb, slot_ids, meta)
        return seq
