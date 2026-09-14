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
