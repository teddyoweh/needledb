"""Metadata filters: the grammar, validation, and the index that evaluates them.

Grammar (Pinecone-compatible):

    filter    := { field: condition, ... }          # several fields = implicit $and
               | { "$and": [filter, ...] } | { "$or": [filter, ...] }
    condition := scalar                              # shorthand for {"$eq": scalar}
               | { "$eq" | "$ne": scalar }
               | { "$gt" | "$gte" | "$lt" | "$lte": number }
               | { "$in" | "$nin": [scalar, ...] }
               | { "$exists": bool }

For list-valued metadata, `$eq` and `$in` match when ANY element matches. `$ne` and
`$nin` are the exact complements of `$eq` and `$in`, so they also match records
that lack the field.

Evaluation produces a boolean mask over collection slots. Postings (value -> slots)
answer equality; a float column per numeric field answers ranges vectorized.
"""
from __future__ import annotations

import math
from typing import Any

import numpy as np

from .config import InvalidArgument

_COMPARISON = ("$gt", "$gte", "$lt", "$lte")
_SCALAR_OPS = ("$eq", "$ne")
_SET_OPS = ("$in", "$nin")
_ALL_OPS = set(_COMPARISON) | set(_SCALAR_OPS) | set(_SET_OPS) | {"$exists"}


def _key(value: Any) -> tuple:
    """A hashable, type-aware posting key. Numbers compare numerically (1 == 1.0),
    booleans never equal numbers, strings compare exactly."""
    if isinstance(value, bool):
        return ("b", value)
    if isinstance(value, (int, float)):
        return ("n", float(value))
    if isinstance(value, str):
        return ("s", value)
    raise InvalidArgument(f"filter values must be strings, numbers or booleans, got {value!r}")


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def validate_metadata(metadata: Any) -> dict | None:
    if metadata is None:
        return None
    if not isinstance(metadata, dict):
        raise InvalidArgument("metadata must be an object")
    for field, value in metadata.items():
        if not isinstance(field, str) or not field or field.startswith("$"):
            raise InvalidArgument(f"invalid metadata field name {field!r}")
        if isinstance(value, list):
            if not all(isinstance(v, str) for v in value):
                raise InvalidArgument(f"metadata list {field!r} must contain only strings")
        elif isinstance(value, float):
            if not math.isfinite(value):
                raise InvalidArgument(f"metadata {field!r} must be a finite number")
        elif not isinstance(value, (str, int, bool)):
            raise InvalidArgument(
                f"metadata {field!r} must be a string, number, boolean or list of strings")
    return metadata


class MetadataIndex:
    """Per-field postings, numeric columns and presence, aligned to collection slots."""

    def __init__(self) -> None:
        self._postings: dict[str, dict[tuple, set[int]]] = {}
        self._numeric: dict[str, np.ndarray] = {}
        self._presence: dict[str, set[int]] = {}
        self._slot_meta: list[dict | None] = []
        self._capacity = 0
        # Masks for single postings, reused until the next metadata change.
        self.version = 0
        self._cache: dict[tuple, tuple[int, np.ndarray]] = {}

    # ---- maintenance -------------------------------------------------------------

    def _grow(self, slots: int) -> None:
        if slots <= self._capacity:
            return
        new_cap = max(slots, self._capacity * 2, 1024)
        for field, col in self._numeric.items():
            grown = np.full(new_cap, np.nan, dtype=np.float64)
            grown[: len(col)] = col
            self._numeric[field] = grown
        self._slot_meta.extend([None] * (new_cap - len(self._slot_meta)))
        self._capacity = new_cap

    def add(self, slot: int, metadata: dict | None) -> None:
        self._grow(slot + 1)
        self._slot_meta[slot] = metadata or None
        if not metadata:
            return
        self.version += 1
        for field, value in metadata.items():
            self._presence.setdefault(field, set()).add(slot)
            postings = self._postings.setdefault(field, {})
            values = value if isinstance(value, list) else [value]
            for v in values:
                postings.setdefault(_key(v), set()).add(slot)
            if _is_number(value):
                col = self._numeric.get(field)
                if col is None:
                    col = np.full(self._capacity, np.nan, dtype=np.float64)
                    self._numeric[field] = col
                col[slot] = float(value)

    def remove(self, slot: int) -> None:
        if slot >= len(self._slot_meta):
            return
        metadata = self._slot_meta[slot]
        if not metadata:
            return
        self.version += 1
        for field, value in metadata.items():
            self._presence.get(field, set()).discard(slot)
            postings = self._postings.get(field, {})
            for v in (value if isinstance(value, list) else [value]):
                bucket = postings.get(_key(v))
                if bucket is not None:
                    bucket.discard(slot)
                    if not bucket:
                        postings.pop(_key(v), None)
            if _is_number(value) and field in self._numeric:
                self._numeric[field][slot] = np.nan
        self._slot_meta[slot] = None

    def get(self, slot: int) -> dict | None:
        return self._slot_meta[slot] if slot < len(self._slot_meta) else None

    # ---- evaluation --------------------------------------------------------------

    def evaluate(self, flt: dict, n_slots: int) -> np.ndarray:
        """Boolean mask of length n_slots: True where the slot's metadata matches."""
        if not isinstance(flt, dict):
            raise InvalidArgument("filter must be an object")
        if not flt:
            return np.ones(n_slots, dtype=bool)
        return self._eval_object(flt, n_slots)

    def _mask_from(self, slots: set[int] | None, n: int) -> np.ndarray:
        mask = np.zeros(n, dtype=bool)
        if slots:
            idx = np.fromiter(slots, dtype=np.int64, count=len(slots))
            mask[idx[idx < n]] = True
        return mask

    def _cached(self, cache_key: tuple, slots: set[int] | None, n: int) -> np.ndarray:
        """Read-only mask for one posting or presence set, cached per metadata version."""
        key = (*cache_key, n)
        hit = self._cache.get(key)
        if hit is not None and hit[0] == self.version:
            return hit[1]
        mask = self._mask_from(slots, n)
        mask.flags.writeable = False
        if len(self._cache) >= 1024:
            self._cache.clear()
        self._cache[key] = (self.version, mask)
        return mask

    def _eval_object(self, obj: dict, n: int) -> np.ndarray:
        result = np.ones(n, dtype=bool)
        for key, value in obj.items():
            if key == "$and":
                result &= self._eval_list(value, n, "$and", all_=True)
            elif key == "$or":
                result &= self._eval_list(value, n, "$or", all_=False)
            elif key.startswith("$"):
                raise InvalidArgument(f"unknown operator {key!r} at the top level of a filter")
            else:
                result &= self._eval_field(key, value, n)
        return result

    def _eval_list(self, items: Any, n: int, op: str, all_: bool) -> np.ndarray:
        if not isinstance(items, list) or not items:
            raise InvalidArgument(f"{op} requires a non-empty list of filters")
        masks = []
        for item in items:
            if not isinstance(item, dict):
                raise InvalidArgument(f"every item in {op} must be a filter object")
            masks.append(self._eval_object(item, n))
        out = masks[0].copy()
        for m in masks[1:]:
            if all_:
                out &= m
            else:
                out |= m
        return out

    def _eval_field(self, field: str, condition: Any, n: int) -> np.ndarray:
        if not isinstance(condition, dict):
            return self._eq(field, condition, n)
        if not condition:
            raise InvalidArgument(f"empty condition for field {field!r}")
        result = np.ones(n, dtype=bool)
        for op, arg in condition.items():
            if op not in _ALL_OPS:
                raise InvalidArgument(f"unknown operator {op!r} for field {field!r}")
            if op == "$eq":
                result &= self._eq(field, arg, n)
            elif op == "$ne":
                result &= ~self._eq(field, arg, n)
            elif op in _SET_OPS:
                if not isinstance(arg, list):
                    raise InvalidArgument(f"{op} for field {field!r} requires a list")
                m = self._in(field, arg, n)
                result &= m if op == "$in" else ~m
            elif op in _COMPARISON:
                result &= self._compare(field, op, arg, n)
            elif op == "$exists":
                if not isinstance(arg, bool):
                    raise InvalidArgument(f"$exists for field {field!r} requires true or false")
                m = self._cached(("?", field), self._presence.get(field), n)
                result &= m if arg else ~m
        return result

    def _eq(self, field: str, value: Any, n: int) -> np.ndarray:
        if isinstance(value, (dict, list)):
            raise InvalidArgument(f"$eq for field {field!r} requires a scalar")
        key = _key(value)
        return self._cached(("=", field, key), self._postings.get(field, {}).get(key), n)

    def _in(self, field: str, values: list, n: int) -> np.ndarray:
        postings = self._postings.get(field, {})
        mask = np.zeros(n, dtype=bool)
        for v in values:
            if isinstance(v, (dict, list)):
                raise InvalidArgument(f"$in / $nin values for {field!r} must be scalars")
            key = _key(v)
            bucket = postings.get(key)
            if bucket:
                mask |= self._cached(("=", field, key), bucket, n)
        return mask

    def _compare(self, field: str, op: str, value: Any, n: int) -> np.ndarray:
        if not _is_number(value):
            raise InvalidArgument(f"{op} for field {field!r} requires a number")
        col = self._numeric.get(field)
        if col is None:
            return np.zeros(n, dtype=bool)
        view = col[:n]
        with np.errstate(invalid="ignore"):
            if op == "$gt":
                return view > value
            if op == "$gte":
                return view >= value
            if op == "$lt":
                return view < value
            return view <= value
