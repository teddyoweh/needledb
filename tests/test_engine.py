"""The engine: exactness, recall, any dimension, writes, rebuilds and durability."""
from __future__ import annotations

import threading

import numpy as np
import pytest

import needledb.core.collection as collection_module
from needledb.core import IndexConfig, InvalidArgument, NotFound, Registry
from needledb.errors import AlreadyExists

from .conftest import brute_force, clustered

METRICS = ["cosine", "dotproduct", "euclidean"]


def load(index, x, metas=None, namespace=None, batch=2_000):
    for start in range(0, len(x), batch):
        stop = min(len(x), start + batch)
        index.upsert([{"id": f"v{i}", "values": x[i], "metadata": metas[i] if metas else None}
                      for i in range(start, stop)], namespace)


@pytest.mark.parametrize("metric", METRICS)
def test_flat_is_exact(registry, metric):
    x, q = clustered(3_000, 48, seed=1), clustered(20, 48, seed=2)
    index = registry.create_index(IndexConfig(name="flat", dimension=48, metric=metric, index_type="flat"))
    load(index, x)
    for vec in q:
        res = index.query(vector=vec, top_k=10)
        assert res["usage"]["plan"] == "exact"
        assert [m["id"] for m in res["matches"]] == [f"v{i}" for i in brute_force(x, vec, metric, 10)]
    scores = [m["score"] for m in res["matches"]]
    assert scores == sorted(scores, reverse=metric != "euclidean")


@pytest.mark.parametrize("metric", ["cosine", "euclidean"])
def test_hnsw_recall(registry, metric):
    x, q = clustered(8_000, 32, seed=3), clustered(50, 32, seed=4)
    index = registry.create_index(IndexConfig(name="graph", dimension=32, metric=metric, index_type="hnsw"))
    load(index, x)
    hits = 0
    for vec in q:
        res = index.query(vector=vec, top_k=10, ef_search=256)
        assert res["usage"]["plan"] == "hnsw"
        hits += len({m["id"] for m in res["matches"]} & {f"v{i}" for i in brute_force(x, vec, metric, 10)})
    assert hits / 500 >= 0.95


@pytest.mark.parametrize("selectivity", [0.5, 0.05, 0.001])
def test_filtered_queries_keep_recall(registry, selectivity, monkeypatch):
    monkeypatch.setattr(collection_module, "AUTO_HNSW_THRESHOLD", 1_000)
    monkeypatch.setattr(collection_module, "BRUTE_FORCE_LIMIT", 200)
    n = 10_000
    x, q = clustered(n, 32, seed=5), clustered(30, 32, seed=6)
    rng = np.random.default_rng(0)
    keep = rng.random(n) < selectivity
    metas = [{"bucket": "in" if k else "out"} for k in keep]
    index = registry.create_index(IndexConfig(name="filtered", dimension=32))
    load(index, x, metas)
    index.wait_for_index()
    hits = total = 0
    for vec in q:
        truth = {f"v{i}" for i in brute_force(x, vec, "cosine", 10, keep)}
        res = index.query(vector=vec, top_k=10, filter={"bucket": "in"}, include_metadata=True)
        assert all(m["metadata"]["bucket"] == "in" for m in res["matches"])
        hits += len({m["id"] for m in res["matches"]} & truth)
        total += len(truth)
    assert hits / total >= 0.95


@pytest.mark.parametrize("dimension", [1, 2, 3, 257, 4_096])
def test_any_dimension(registry, dimension):
    x = clustered(300, dimension, seed=dimension)
    index = registry.create_index(IndexConfig(name=f"dim-{dimension}", dimension=dimension, metric="euclidean"))
    load(index, x)
    res = index.query(vector=x[42], top_k=1)
    assert res["matches"][0]["id"] == "v42"
    assert np.allclose(index.fetch(["v7"])["vectors"]["v7"]["values"], x[7], atol=1e-5)


def test_writes_overwrite_update_delete(registry):
    index = registry.create_index(IndexConfig(name="writes", dimension=4))
    index.upsert([("a", [1, 0, 0, 0], {"color": "red"}), ("b", [0, 1, 0, 0])])
    index.upsert([("a", [0, 0, 1, 0], {"color": "blue"})])                 # overwrite
    assert index.describe_stats()["totalVectorCount"] == 2
    assert index.query(vector=[0, 0, 1, 0], top_k=1)["matches"][0]["id"] == "a"
    assert index.query(vector=[1, 0, 0, 0], top_k=2, filter={"color": "red"})["matches"] == []

    index.update("b", set_metadata={"color": "red", "size": 3})
    index.update("b", set_metadata={"size": 4})
    assert index.fetch(["b"])["vectors"]["b"]["metadata"] == {"color": "red", "size": 4}
    index.update("b", values=[0, 0, 0, 5])
    fetched = index.fetch(["b"])["vectors"]["b"]
    assert fetched["values"] == [0, 0, 0, 5] and fetched["metadata"]["size"] == 4
    with pytest.raises(NotFound):
        index.update("nope", set_metadata={"x": 1})

    assert index.delete(filter={"color": "red"}) == 1
    assert index.delete(ids=["a", "a", "missing"]) == 1
    assert index.describe_stats()["totalVectorCount"] == 0


def test_namespaces_are_isolated(registry):
    index = registry.create_index(IndexConfig(name="ns", dimension=2))
    index.upsert([("x", [1, 0])], namespace="one")
    index.upsert([("x", [0, 1])], namespace="two")
    assert index.fetch(["x"], "one")["vectors"]["x"]["values"] == [1, 0]
    assert index.query(vector=[1, 0], top_k=5, namespace="two")["matches"][0]["score"] == pytest.approx(0)
    assert index.query(vector=[1, 0], top_k=5)["matches"] == []
    assert index.delete(delete_all=True, namespace="one") == 1
    assert set(index.describe_stats()["namespaces"]) == {"two"}


def test_list_pagination(registry):
    index = registry.create_index(IndexConfig(name="listing", dimension=2))
    index.upsert([(f"doc#{i:03d}", [1, i]) for i in range(1, 26)] + [("other", [1, 1])])
    seen, token = [], None
    while True:
        page = index.list_ids(prefix="doc#", limit=10, pagination_token=token)
        seen += [v["id"] for v in page["vectors"]]
        token = page["pagination"].get("next")
        if not token:
            break
    assert seen == [f"doc#{i:03d}" for i in range(1, 26)]


def test_query_by_id_and_include_values(registry):
    index = registry.create_index(IndexConfig(name="byid", dimension=3))
    index.upsert([("a", [3, 4, 0]), ("b", [0, 1, 0])])
    res = index.query(id="a", top_k=2, include_values=True)
    assert res["matches"][0]["id"] == "a"
    assert res["matches"][0]["values"] == pytest.approx([3, 4, 0])       # original, not normalized
    with pytest.raises(NotFound):
        index.query(id="zzz", top_k=1)


@pytest.mark.parametrize("bad", [
    dict(name="Bad_Name", dimension=3), dict(name="ok", dimension=0),
    dict(name="ok", dimension=70_000), dict(name="ok", dimension=3, metric="manhattan"),
    dict(name="ok", dimension=3, index_type="ivf"),
])
def test_config_validation(registry, bad):
    with pytest.raises(InvalidArgument):
        registry.create_index(IndexConfig(**bad))


def test_write_validation(registry):
    index = registry.create_index(IndexConfig(name="valid", dimension=3))
    for records in ([("a", [1, 2])], [("a", [1, 2, float("nan")])], [("a", [0, 0, 0])],
                    [("", [1, 2, 3])], [("a", [1, 2, 3], {"n": {"x": 1}})], [], "nope"):
        with pytest.raises(InvalidArgument):
            index.upsert(records)
    for kwargs in (dict(vector=[1, 2]), dict(vector=[1, 2, 3], top_k=0), dict(),
                   dict(vector=[1, 2, 3], id="a"), dict(vector=[1, 2, 3], filter={"$x": 1})):
        with pytest.raises((InvalidArgument, NotFound)):
            index.upsert([("a", [1, 2, 3])])
            index.query(**{"top_k": 3, **kwargs})
    with pytest.raises(AlreadyExists):
        registry.create_index(IndexConfig(name="valid", dimension=3))


def test_vector_map_projects_a_sample(registry):
    rng = np.random.default_rng(3)
    centers = rng.normal(size=(3, 24)) * 6
    x = np.vstack([c + rng.normal(size=(200, 24)) for c in centers]).astype(np.float32)
    index = registry.create_index(IndexConfig(name="mapped", dimension=24, metric="euclidean"))
    kinds = ["alpha", "beta", "gamma"]
    index.upsert([{"id": f"p{i}", "values": x[i], "metadata": {"title": f"Point {i}", "kind": kinds[i // 200]}}
                  for i in range(600)])

    full = index.vector_map(limit=5000)
    assert full["total"] == 600 and full["sampled"] == 600 and len(full["points"]) == 600
    coords = np.array([[p["x"], p["y"]] for p in full["points"]])
    assert np.abs(coords).max() <= 1.0 + 1e-6
    assert full["points"][0]["label"].startswith("Point ")
    assert sum(full["explained"]) > 0.5                 # three tight clusters: two axes explain most variance
    # Up to six colours for three real clusters: a cluster may take two colours,
    # but a colour must never mix two real clusters.
    labels = np.array([p["cluster"] for p in sorted(full["points"], key=lambda p: int(p["id"][1:]))])
    truth = np.repeat(np.arange(3), 200)
    for label in np.unique(labels):
        members = truth[labels == label]
        assert np.bincount(members).max() >= 0.95 * len(members)

    assert full["colorFields"] == ["kind"]                  # "title" has 600 distinct values: not a colour
    coloured = index.vector_map(limit=5000, color_by="kind")
    assert {p["group"] for p in coloured["points"]} == set(kinds)

    sample = index.vector_map(limit=100)
    assert sample["sampled"] == 100 and sample["total"] == 600
    assert index.vector_map(namespace="nowhere")["points"] == []
    with pytest.raises(InvalidArgument):
        index.vector_map(limit=0)
    tiny = registry.create_index(IndexConfig(name="tiny", dimension=1))
    tiny.upsert([("a", [1.0]), ("b", [2.0])])
    assert tiny.vector_map()["sampled"] == 2


def test_rebuild_replays_concurrent_writes(registry, monkeypatch):
    monkeypatch.setattr(collection_module, "AUTO_HNSW_THRESHOLD", 2_000)
    monkeypatch.setattr(collection_module, "COMPACT_MIN_DEAD", 100)
    x = clustered(6_000, 32, seed=8)
    index = registry.create_index(IndexConfig(name="rebuild", dimension=32))
    load(index, x[:2_000], [{"i": i} for i in range(2_000)])    # crosses the threshold
    load_rest = [{"id": f"v{i}", "values": x[i], "metadata": {"i": i}} for i in range(2_000, 6_000)]
    for start in range(0, 4_000, 250):                             # lands during the build
        index.upsert(load_rest[start:start + 250])
    index.delete(ids=[f"v{i}" for i in range(0, 6_000, 3)])       # also triggers compaction
    index.update("v1", set_metadata={"touched": True})
    index.wait_for_index()

    coll = index.collections[""]
    assert coll.ann_kind == "hnsw" and not coll.building
    live = [i for i in range(6_000) if i % 3]
    assert index.describe_stats()["totalVectorCount"] == len(live)
    assert coll.tombstones < 0.2 * coll.n or coll.tombstones < 100
    fetched = index.fetch([f"v{i}" for i in range(0, 60)])["vectors"]
    assert sorted(fetched) == sorted(f"v{i}" for i in range(60) if i % 3)
    assert fetched["v1"]["metadata"] == {"i": 1, "touched": True}
    for i in live[:50]:
        assert index.query(vector=x[i], top_k=1, ef_search=200)["matches"][0]["id"] == f"v{i}"


def test_concurrent_reads_and_writes(registry, monkeypatch):
    monkeypatch.setattr(collection_module, "AUTO_HNSW_THRESHOLD", 1_500)
    x = clustered(5_000, 16, seed=9)
    index = registry.create_index(IndexConfig(name="busy", dimension=16))
    load(index, x[:1_000])
    errors = []

    def reader():
        try:
            for i in range(300):
                index.query(vector=x[i], top_k=5, filter={"$or": [{"g": 1}, {"g": {"$exists": False}}]})
        except Exception as exc:  # noqa: BLE001
            errors.append(exc)

    def writer():
        try:
            for start in range(1_000, 5_000, 200):
                index.upsert([{"id": f"v{i}", "values": x[i], "metadata": {"g": i % 2}}
                              for i in range(start, start + 200)])
                index.delete(ids=[f"v{start - 100}"])
        except Exception as exc:  # noqa: BLE001
            errors.append(exc)

    threads = [threading.Thread(target=reader) for _ in range(4)] + [threading.Thread(target=writer)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    index.wait_for_index()
    assert not errors
    assert index.describe_stats()["totalVectorCount"] == 5_000 - 20


def test_restart_from_snapshot_and_log(tmp_path, monkeypatch):
    monkeypatch.setattr(collection_module, "AUTO_HNSW_THRESHOLD", 1_000)
    path = tmp_path / "durable"
    x = clustered(3_000, 24, seed=10)
    reg = Registry(path)
    index = reg.create_index(IndexConfig(name="durable", dimension=24, metric="euclidean"))
    load(index, x[:2_000], [{"i": i} for i in range(2_000)])
    index.upsert([("ns-vec", x[0])], namespace="side")
    index.wait_for_index()
    reg.close()                                                    # snapshot

    reg = Registry(path)
    index = reg.get("durable")
    assert index.collections[""].ann_kind == "hnsw"
    load(index, x[2_000:], None)                                   # ids v0.. again: overwrites
    index.delete(ids=["v5"])
    index.update("v6", set_metadata={"late": 1})
    index.storage.close()                                          # crash: no snapshot

    reg = Registry(path)
    index = reg.get("durable")
    assert index.describe_stats()["totalVectorCount"] == 2_000 - 1 + 1
    assert index.fetch(["v5"])["vectors"] == {}
    v6 = index.fetch(["v6"])["vectors"]["v6"]
    assert v6["metadata"] == {"late": 1}
    assert np.allclose(v6["values"], x[2_006])
    assert index.query(vector=x[2_010], top_k=1)["matches"][0]["id"] == "v10"
    reg.close()

    reg = Registry(path)                                           # and once more, from snapshot
    assert reg.get("durable").fetch(["v6"])["vectors"]["v6"]["metadata"] == {"late": 1}
    assert reg.get("durable").query(vector=x[0], top_k=1, namespace="side")["matches"][0]["id"] == "ns-vec"
    reg.delete_index("durable")
    assert not (path / "durable").exists()
    reg.close()


def test_a_mounted_volume_opens_despite_its_own_directories(tmp_path):
    """A data directory on a fresh ext4 volume holds a root-owned lost+found."""
    from needledb.core import IndexConfig, Registry

    data = tmp_path / "data"
    registry = Registry(data)
    registry.create_index(IndexConfig(name="docs", dimension=4))
    registry.close()

    (data / "lost+found").mkdir()
    (data / "lost+found" / "index.json").write_text("not an index")   # unreadable in the real case
    (data / "notes.txt").write_text("stray file")

    reopened = Registry(data)
    try:
        assert [i.cfg.name for i in reopened.list()] == ["docs"]
    finally:
        reopened.close()
