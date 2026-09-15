"""Both SDK clients expose the same Index surface and results."""
from __future__ import annotations

import socket
import threading
import time

import numpy as np
import pytest
import uvicorn

from needledb import NeedleDB, NeedleDBLocal
from needledb.errors import AlreadyExists, InvalidArgument, NotFound, Unauthenticated
from needledb.server.app import create_app

from .conftest import API_KEY


@pytest.fixture(params=["remote", "local"])
def db(request, client, tmp_path):
    if request.param == "remote":
        yield NeedleDB(api_key=API_KEY, client=client)
    else:
        local = NeedleDBLocal(tmp_path / "local")
        yield local
        local.close()


def test_round_trip(db):
    info = db.create_index("docs", dimension=8, metric="cosine")
    assert info.dimension == 8 and info.status.ready
    with pytest.raises(AlreadyExists):
        db.create_index("docs", dimension=8)
    assert db.has_index("docs") and [i.name for i in db.list_indexes()] == ["docs"]

    index = db.Index("docs")
    rng = np.random.default_rng(0)
    vectors = rng.normal(size=(2_500, 8)).astype(np.float32)
    ids = [f"doc-{i}" for i in range(2_500)]
    metadata = [{"lang": "en" if i % 4 else "fr", "rank": i} for i in range(2_500)]
    assert index.upsert_arrays(ids, vectors, metadata, batch_size=700).upserted_count == 2_500

    res = index.query(vectors[10], top_k=3, include_metadata=True, include_values=True)
    assert res.matches[0].id == "doc-10"
    assert res.matches[0].metadata.rank == 10
    assert np.allclose(res.matches[0]["values"], vectors[10], atol=1e-5)

    fr = index.query(vector=vectors[10].tolist(), top_k=50, filter={"lang": "fr"}, include_metadata=True)
    assert len(fr.matches) == 50 and all(m.metadata.lang == "fr" for m in fr.matches)

    index.upsert([("extra", vectors[0], {"lang": "de"})], namespace="side")
    assert index.describe_index_stats().total_vector_count == 2_501
    assert index.describe_index_stats(filter={"lang": "de"}).namespaces["side"].vector_count == 1

    index.update("doc-1", set_metadata={"lang": "es"})
    assert index.fetch(["doc-1"]).vectors["doc-1"].metadata == {"lang": "es", "rank": 1}
    with pytest.raises(NotFound):
        index.update("nope", set_metadata={"a": 1})
    with pytest.raises(InvalidArgument):
        index.query(vector=[1.0, 2.0], top_k=1)

    pages = list(index.list(prefix="doc-1", limit=100))
    assert sum(len(p) for p in pages) == len([i for i in ids if i.startswith("doc-1")])

    assert index.delete(filter={"lang": "fr"}).deleted_count == 625
    assert index.delete(delete_all=True, namespace="side").deleted_count == 1
    db.configure_index("docs", ef_search=64)
    assert db.describe_index("docs").hnsw.ef_search == 64
    db.delete_index("docs")
    assert not db.has_index("docs")


def test_remote_auth_error(client):
    bad = NeedleDB(api_key="wrong", client=client)
    with pytest.raises(Unauthenticated):
        bad.list_indexes()


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def test_official_pinecone_client_works(tmp_path):
    """The Pinecone Python SDK can talk to a NeedleDB index host unchanged."""
    pinecone = pytest.importorskip("pinecone")
    app = create_app(tmp_path / "pc", api_keys=[API_KEY])
    port = _free_port()
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="error"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    try:
        for _ in range(100):
            if server.started:
                break
            time.sleep(0.05)
        NeedleDB(f"http://127.0.0.1:{port}", api_key=API_KEY).create_index("pc", dimension=3)
        pc = pinecone.Pinecone(api_key=API_KEY)
        index = pc.Index(host=f"http://127.0.0.1:{port}/indexes/pc")
        index.upsert(vectors=[{"id": "a", "values": [1, 0, 0], "metadata": {"genre": "drama"}},
                              {"id": "b", "values": [0, 1, 0], "metadata": {"genre": "comedy"}}],
                     namespace="films")
        res = index.query(vector=[1, 0.1, 0], top_k=2, namespace="films",
                          filter={"genre": {"$eq": "drama"}}, include_metadata=True)
        assert res.matches[0].id == "a" and res.matches[0].metadata == {"genre": "drama"}
        assert index.fetch(ids=["b"], namespace="films").vectors["b"].values == [0, 1, 0]
        assert index.describe_index_stats().total_vector_count == 2
        index.delete(ids=["a"], namespace="films")
        assert index.describe_index_stats().namespaces["films"].vector_count == 1
    finally:
        server.should_exit = True
        thread.join(5)
        app.state.registry.close()


# ---- text, convenience helpers and the async client ---------------------------------------

from needledb import AsyncNeedleDB  # noqa: E402

from needledb.client.common import text_id  # noqa: E402

from .test_embed import DOCS, SMALL, fake_openai  # noqa: E402,F401 — the fixture, reused


@pytest.fixture
def openai_key(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")


def test_text_helpers(db, fake_openai, openai_key):
    assert db.create_index("shop", embed=SMALL).dimension == 1536
    assert db.create_index("shop", embed=SMALL, exist_ok=True).name == "shop"
    with pytest.raises(AlreadyExists, match="dimension 1536"):
        db.create_index("shop", dimension=8, exist_ok=True)

    index = db.Index("shop")
    loaded = index.upsert_texts([t for _, t, _ in DOCS], ids=[r for r, _, _ in DOCS],
                                metadata=[m for _, _, m in DOCS])
    assert loaded.upserted_count == 3 and loaded.ids == ["boots", "skillet", "tent"]

    hits = index.search("searing steak", top_k=2)
    assert hits.matches[0].id == "skillet" and hits.matches[0].metadata.text == DOCS[1][1]
    assert index.search(text="camping tent", top_k=1, filter={"category": "outdoor"}).matches[0].id == "tent"
    by_vector = index.search(index.get("tent").values, top_k=1)
    assert by_vector.matches[0].id == "tent"
    with pytest.raises(ValueError):
        index.search()

    auto = index.upsert_texts(["a note", "a note", "another note"], metadata={"kind": "note"})
    assert auto.upserted_count == 2 and auto.ids[0] == text_id("a note")
    assert index.count() == 5 and index.count(filter={"kind": "note"}) == 2 and index.count("elsewhere") == 0

    record = index.get("boots")
    assert record.metadata.category == "outdoor" and len(record.values) == 1536
    assert index.get("missing") is None
    assert index.describe().embed.model == "text-embedding-3-small"

    scanned = list(index.scan(batch_size=2))
    assert len(scanned) == 5 and all("values" not in r for r in scanned)
    assert [r.id for r in index.scan(prefix="bo", include_values=True)] == ["boots"]


def test_async_client(app, client, fake_openai, openai_key):
    import asyncio

    import httpx

    async def main():
        transport = httpx.ASGITransport(app=app)
        async with AsyncNeedleDB(api_key=API_KEY, client=httpx.AsyncClient(transport=transport, base_url="http://test")) as db:
            await db.create_index("docs", dimension=8)
            assert await db.has_index("docs")
            await db.create_index("shop", embed=SMALL, exist_ok=True)
            index = db.Index("docs")
            rng = np.random.default_rng(1)
            vectors = rng.normal(size=(1_000, 8)).astype(np.float32)
            ids = [f"doc-{i}" for i in range(1_000)]
            res = await index.upsert_arrays(ids, vectors, [{"even": i % 2 == 0} for i in range(1_000)],
                                            batch_size=128, max_concurrency=4)
            assert res.upserted_count == 1_000 and await index.count() == 1_000
            assert (await index.query(vectors[7], top_k=1)).matches[0].id == "doc-7"
            assert (await index.get("doc-7")).metadata == {"even": False}
            assert len([r async for r in index.scan(prefix="doc-9", batch_size=50)]) == 111
            assert (await index.delete(filter={"even": True})).deleted_count == 500

            shop = db.index("shop")
            await shop.upsert_texts([t for _, t, _ in DOCS], ids=[r for r, _, _ in DOCS])
            assert (await shop.search("searing steak", top_k=1)).matches[0].id == "skillet"
            with pytest.raises(NotFound):
                await db.describe_index("nope")

    asyncio.run(main())


def test_obj_values_reads_the_vector():
    from needledb.client.index import wrap

    record = wrap({"id": "a", "values": [1.0, 2.0], "metadata": {"k": 1}})
    assert record.values == [1.0, 2.0] and record.metadata.k == 1
    assert list(wrap({"x": 1}).values()) == [1]
