"""The filter engine against a straightforward reference implementation."""
from __future__ import annotations

import random

import numpy as np
import pytest

from needledb.core.filters import MetadataIndex, validate_metadata
from needledb.errors import InvalidArgument


def _is_num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _same(a, b):
    if isinstance(a, bool) or isinstance(b, bool):
        return isinstance(a, bool) and isinstance(b, bool) and a == b
    if _is_num(a) and _is_num(b):
        return float(a) == float(b)
    return isinstance(a, str) and isinstance(b, str) and a == b


def ref_match(meta, flt) -> bool:
    for key, value in flt.items():
        if key == "$and":
            if not all(ref_match(meta, f) for f in value):
                return False
        elif key == "$or":
            if not any(ref_match(meta, f) for f in value):
                return False
        elif not ref_field(meta, key, value):
            return False
    return True


def ref_field(meta, field, cond) -> bool:
    if not isinstance(cond, dict):
        cond = {"$eq": cond}
    has = bool(meta) and field in meta
    val = meta.get(field) if has else None
    vals = val if isinstance(val, list) else [val]

    def eq(x):
        return has and any(_same(v, x) for v in vals)

    for op, arg in cond.items():
        if op == "$eq" and not eq(arg):
            return False
        if op == "$ne" and eq(arg):
            return False
        if op == "$in" and not any(eq(x) for x in arg):
            return False
        if op == "$nin" and any(eq(x) for x in arg):
            return False
        if op == "$exists" and has != arg:
            return False
        if op in ("$gt", "$gte", "$lt", "$lte"):
            if not (has and _is_num(val)):
                return False
            ok = {"$gt": val > arg, "$gte": val >= arg, "$lt": val < arg, "$lte": val <= arg}[op]
            if not ok:
                return False
    return True


COLORS = ["red", "green", "blue", "black"]
TAGS = ["new", "sale", "eco", "limited"]


def random_meta(rng: random.Random):
    if rng.random() < 0.05:
        return None
    meta = {}
    if rng.random() < 0.9:
        meta["color"] = rng.choice(COLORS)
    if rng.random() < 0.8:
        meta["size"] = rng.randint(0, 9)
    if rng.random() < 0.8:
        meta["price"] = round(rng.uniform(0, 200), 2)
    if rng.random() < 0.6:
        meta["tags"] = rng.sample(TAGS, rng.randint(0, 3))
    if rng.random() < 0.5:
        meta["flag"] = rng.random() < 0.5
    return meta


def random_condition(rng: random.Random):
    field = rng.choice(["color", "size", "price", "tags", "flag", "missing"])
    op = rng.choice(["shorthand", "$eq", "$ne", "$in", "$nin", "$exists", "$gt", "$gte", "$lt", "$lte"])
    scalar = {
        "color": lambda: rng.choice(COLORS), "tags": lambda: rng.choice(TAGS),
        "size": lambda: rng.randint(0, 9), "price": lambda: rng.uniform(0, 200),
        "flag": lambda: rng.random() < 0.5, "missing": lambda: "x",
    }[field]
    if op == "$exists":
        return {field: {"$exists": rng.random() < 0.5}}
    if op in ("$gt", "$gte", "$lt", "$lte"):
        return {field: {op: rng.uniform(0, 200) if field == "price" else rng.randint(0, 9)}}
    if op in ("$in", "$nin"):
        return {field: {op: [scalar() for _ in range(rng.randint(1, 3))]}}
    if op == "shorthand":
        return {field: scalar()}
    return {field: {op: scalar()}}


def random_filter(rng: random.Random, depth: int = 0):
    roll = rng.random()
    if depth < 2 and roll < 0.2:
        return {"$and": [random_filter(rng, depth + 1) for _ in range(rng.randint(1, 3))]}
    if depth < 2 and roll < 0.4:
        return {"$or": [random_filter(rng, depth + 1) for _ in range(rng.randint(1, 3))]}
    flt = random_condition(rng)
    if rng.random() < 0.3:
        flt.update(random_condition(rng))
    return flt


def test_random_filters_match_reference():
    rng = random.Random(7)
    metas = [random_meta(rng) for _ in range(600)]
    index = MetadataIndex()
    for slot, meta in enumerate(metas):
        index.add(slot, meta)
    removed = set(rng.sample(range(600), 60))
    for slot in removed:                       # removal must fully unindex a slot
        index.remove(slot)
        metas[slot] = None
    for _ in range(600):
        flt = random_filter(rng)
        got = index.evaluate(flt, len(metas))
        want = np.array([ref_match(m, flt) for m in metas])
        assert np.array_equal(got, want), flt


def test_numbers_and_booleans_do_not_mix():
    index = MetadataIndex()
    index.add(0, {"v": 1})
    index.add(1, {"v": True})
    index.add(2, {"v": 1.0})
    assert index.evaluate({"v": 1}, 3).tolist() == [True, False, True]
    assert index.evaluate({"v": True}, 3).tolist() == [False, True, False]


def test_cache_invalidates_on_change():
    index = MetadataIndex()
    index.add(0, {"color": "red"})
    assert index.evaluate({"color": "red"}, 2).tolist() == [True, False]
    index.add(1, {"color": "red"})
    assert index.evaluate({"color": "red"}, 2).tolist() == [True, True]
    index.remove(0)
    assert index.evaluate({"color": "red"}, 2).tolist() == [False, True]


@pytest.mark.parametrize("flt", [
    {"$foo": 1}, {"a": {"$bar": 1}}, {"a": {"$gt": "x"}}, {"a": {"$in": "x"}},
    {"$and": []}, {"$or": {"a": 1}}, {"a": {}}, {"a": {"$exists": 1}}, {"a": {"$eq": [1]}},
])
def test_invalid_filters(flt):
    index = MetadataIndex()
    index.add(0, {"a": 1})
    with pytest.raises(InvalidArgument):
        index.evaluate(flt, 1)


@pytest.mark.parametrize("meta", [
    "x", {"a": {"nested": 1}}, {"a": [1, 2]}, {"$a": 1}, {"a": float("nan")}, {"": 1},
])
def test_invalid_metadata(meta):
    with pytest.raises(InvalidArgument):
        validate_metadata(meta)
