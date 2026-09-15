"""A load bigger than memory keeps going in fp16 instead of doubling for the float32 link."""
from __future__ import annotations

import numpy as np

from needledb.core import IndexConfig
from needledb.core import collection as collection_module

from .conftest import clustered

D = 64


def test_a_load_past_the_memory_budget_links_in_fp16(registry, monkeypatch):
    # The budget is 40% of the limit — 1 MB here. 2,000 x 64 float32 vectors fit in it; 5,000 don't.
    monkeypatch.setattr(collection_module, "memory_limit", lambda: 2_500_000)
    index = registry.create_index(IndexConfig.from_dict(
        {"name": "big", "dimension": D, "index_type": "hnsw"}))
    vectors = clustered(5_000, D, seed=8)

    index.upsert([{"id": str(i), "values": v} for i, v in enumerate(vectors[:2_000])])
    assert index.summary()["storage"] == "float32"          # still inside the budget

    index.upsert([{"id": str(i + 2_000), "values": v} for i, v in enumerate(vectors[2_000:])])
    assert index.summary()["storage"] == "fp16"             # switched mid-load, and kept going

    found = [int(m["id"]) for m in index.query(vector=vectors[4_100], top_k=5)["matches"]]
    assert 4_100 in found
    assert index.describe_stats()["totalVectorCount"] == 5_000
    assert np.allclose(index.fetch(["4100"])["vectors"]["4100"]["values"], vectors[4_100],
                       rtol=3e-3, atol=3e-3)


def test_a_top_up_after_the_switch_stays_in_fp16(registry, monkeypatch):
    monkeypatch.setattr(collection_module, "memory_limit", lambda: 1_000_000)
    index = registry.create_index(IndexConfig.from_dict(
        {"name": "topped", "dimension": D, "index_type": "hnsw"}))
    vectors = clustered(6_000, D, seed=9)
    index.upsert([{"id": str(i), "values": v} for i, v in enumerate(vectors)])
    assert index.summary()["storage"] == "fp16"

    more = clustered(3_000, D, seed=10)
    index.upsert([{"id": f"m{i}", "values": v} for i, v in enumerate(more)])
    assert index.summary()["storage"] == "fp16"             # never widens past the budget
    assert index.query(vector=more[7], top_k=1)["matches"][0]["id"] == "m7"
