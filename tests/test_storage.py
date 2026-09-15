"""Graph indexes serve from fp16 vectors: half the memory, the same results."""
from __future__ import annotations

import numpy as np
import pytest

from needledb.core import IndexConfig, Registry

from .conftest import brute_force, clustered

N, D = 6_000, 64


@pytest.fixture
def loaded(registry):
    """An HNSW index past the compaction threshold, with its vectors."""
    def build(**cfg):
        index = registry.create_index(IndexConfig.from_dict(
            {"name": cfg.pop("name", "docs"), "dimension": D, "index_type": "hnsw", **cfg}))
        vectors = clustered(N, D, seed=3)
        index.upsert([{"id": str(i), "values": v, "metadata": {"half": i % 2 == 0}}
                      for i, v in enumerate(vectors)])
        return index, vectors
    return build


def test_fp16_is_the_default_and_keeps_results(loaded):
    index, vectors = loaded()
    assert index.summary()["storage"] == "float32"          # still on the build-time storage
    float32_memory = index.summary()["memoryBytes"]
    top = [m["id"] for m in index.query(vector=vectors[7], top_k=10)["matches"]]

    index.snapshot()                                        # settles: graph moves onto fp16
    assert index.summary()["storage"] == "fp16"
    assert float32_memory - index.summary()["memoryBytes"] == pytest.approx(N * D * 2, rel=0.01)

    assert [m["id"] for m in index.query(vector=vectors[7], top_k=10)["matches"]] == top
    exact = brute_force(vectors, vectors[11], "cosine", 10)
    found = [int(m["id"]) for m in index.query(vector=vectors[11], top_k=10)["matches"]]
    assert len(set(found) & set(exact)) >= 9

    fetched = index.fetch(["11"])["vectors"]["11"]["values"]
    assert np.allclose(fetched, vectors[11], rtol=2e-3, atol=2e-3)   # fp16 rounding, nothing more


def test_filters_and_writes_survive_the_switch(loaded):
    index, vectors = loaded()
    index.snapshot()
    assert index.summary()["storage"] == "fp16"

    narrow = index.query(vector=vectors[3], top_k=5, filter={"half": True}, include_metadata=True)
    assert narrow["usage"]["plan"].startswith("filtered") and len(narrow["matches"]) == 5
    assert all(m["metadata"]["half"] is True for m in narrow["matches"])

    index.upsert([{"id": "new", "values": vectors[0], "metadata": {"half": True}}])
    assert index.query(vector=vectors[0], top_k=1)["matches"][0]["id"] in ("0", "new")
    assert index.delete(ids=["0"]) == 1
    assert index.fetch(["0"])["vectors"] == {}

    big = clustered(2_500, D, seed=4)                        # a big load links on float32 again
    index.upsert([{"id": f"b{i}", "values": v} for i, v in enumerate(big)])
    assert index.summary()["storage"] == "float32"
    index.snapshot()
    assert index.summary()["storage"] == "fp16"
    assert index.query(vector=big[9], top_k=1)["matches"][0]["id"] == "b9"


def test_snapshots_reload_as_fp16(tmp_path, registry, loaded):
    index, vectors = loaded()
    index.snapshot()
    expected = [m["id"] for m in index.query(vector=vectors[5], top_k=10)["matches"]]
    registry.close()

    reopened = Registry(tmp_path / "data")
    try:
        back = reopened.get("docs")
        assert back.summary()["storage"] == "fp16"
        assert [m["id"] for m in back.query(vector=vectors[5], top_k=10)["matches"]] == expected
    finally:
        reopened.close()


def test_float32_storage_can_be_asked_for(loaded):
    index, vectors = loaded(name="exact-values", storage="float32")
    index.snapshot()
    assert index.summary()["storage"] == "float32"
    assert index.fetch(["11"])["vectors"]["11"]["values"] == pytest.approx(vectors[11].tolist(), rel=1e-6)
