"""Built-in embedding: provider requests, text upserts and queries, the catalog, persistence."""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os

import httpx
import numpy as np
import pytest

from needledb import embed
from needledb.core import IndexConfig, InvalidArgument, Registry
from needledb.errors import FailedPrecondition, ResourceExhausted

DOCS = [
    ("boots", "waterproof hiking boots for muddy mountain trails", {"category": "outdoor"}),
    ("skillet", "cast iron skillet for searing steak", {"category": "kitchen"}),
    ("tent", "lightweight tent for mountain camping trips", {"category": "outdoor"}),
]
SMALL = {"provider": "openai", "model": "text-embedding-3-small"}


def bag_of_words(text: str, dimension: int) -> list[float]:
    vec = np.zeros(dimension, dtype=np.float32)
    for word in text.lower().split():
        vec[int(hashlib.sha1(word.encode()).hexdigest(), 16) % dimension] += 1.0
    return vec.tolist()


@pytest.fixture
def fake_openai(monkeypatch):
    calls = []

    def caller(model, texts, kind, dimension):
        calls.append({"model": model.id, "texts": list(texts), "kind": kind, "dimension": dimension})
        return [bag_of_words(t, dimension) for t in texts]

    monkeypatch.setitem(embed.CALLERS, "openai", caller)
    return calls


def test_dimension_comes_from_the_model():
    assert IndexConfig.from_dict({"name": "a", "embed": SMALL}).validate().dimension == 1536
    assert IndexConfig.from_dict({"name": "a", "dimension": 512, "embed": SMALL}).validate().dimension == 512
    with pytest.raises(InvalidArgument, match="1024, 1536"):
        IndexConfig.from_dict({"name": "a", "dimension": 100, "embed": SMALL}).validate()
    with pytest.raises(InvalidArgument, match="unknown OpenAI model"):
        IndexConfig.from_dict({"name": "a", "embed": {"provider": "openai", "model": "nope"}}).validate()
    with pytest.raises(InvalidArgument, match="provider"):
        IndexConfig.from_dict({"name": "a", "dimension": 8, "embed": {"provider": "acme", "model": "x"}}).validate()


def test_text_upsert_and_search(registry, fake_openai):
    index = registry.create_index(IndexConfig.from_dict({"name": "shop", "dimension": 512, "embed": SMALL}))
    records = [{"id": rid, "text": text, **meta} for rid, text, meta in DOCS]  # flat fields become metadata
    assert index.upsert(records) == 3
    assert fake_openai[0]["kind"] == "document" and fake_openai[0]["dimension"] == 512

    res = index.query(text="hiking boots trails", top_k=2, include_metadata=True)
    assert res["matches"][0]["id"] == "boots"
    assert res["matches"][0]["metadata"] == {"category": "outdoor", "text": DOCS[0][1]}
    assert res["usage"]["embedMs"] >= 0
    assert fake_openai[-1]["kind"] == "query"

    # Records with their own values still work on an embedding index.
    index.upsert([{"id": "manual", "values": bag_of_words("steak searing", 512)}])
    assert index.query(text="searing steak", top_k=1, filter={"category": "kitchen"})["matches"][0]["id"] == "skillet"


def test_text_needs_an_embedding_model(registry):
    index = registry.create_index(IndexConfig(name="plain", dimension=4))
    with pytest.raises(InvalidArgument, match="no embedding model"):
        index.query(text="hello")
    with pytest.raises(InvalidArgument, match="exactly one"):
        index.query(text="hello", id="a")


def test_embed_config_survives_restart(tmp_path, fake_openai):
    registry = Registry(tmp_path)
    registry.create_index(IndexConfig.from_dict({"name": "shop", "dimension": 512, "embed": SMALL}))
    registry.get("shop").upsert([{"id": rid, "text": text} for rid, text, _ in DOCS])
    registry.close()

    reopened = Registry(tmp_path)
    index = reopened.get("shop")
    assert index.summary()["embed"] == {"provider": "openai", "model": "text-embedding-3-small", "field": "text"}
    assert index.query(text="camping tent", top_k=1)["matches"][0]["id"] == "tent"
    reopened.close()


def test_missing_key_is_a_clear_error(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    with pytest.raises(FailedPrecondition, match="OPENAI_API_KEY"):
        embed.embed_texts("openai", "text-embedding-3-small", 1536, ["hi"], "query")


def _mock(handler):
    embed.set_http_client(httpx.Client(transport=httpx.MockTransport(handler)))


@pytest.fixture(autouse=True)
def _reset_http():
    embed.clear_cache()
    embed.set_key_resolver(None)
    yield
    embed.set_http_client(None)
    embed.set_key_resolver(None)


PROVIDER_CASES = [
    ("openai", "OPENAI_API_KEY", "text-embedding-3-small", 512, "https://api.openai.com/v1/embeddings",
     lambda b: b["input"] == ["a", "b"] and b["dimensions"] == 512 and b["model"] == "text-embedding-3-small"),
    ("cohere", "COHERE_API_KEY", "embed-v4.0", 1536, "https://api.cohere.com/v2/embed",
     lambda b: b["texts"] == ["a", "b"] and b["input_type"] == "search_query" and "output_dimension" not in b),
    ("voyage", "VOYAGE_API_KEY", "voyage-3.5", 512, "https://api.voyageai.com/v1/embeddings",
     lambda b: b["input_type"] == "query" and b["output_dimension"] == 512),
    ("google", "GEMINI_API_KEY", "gemini-embedding-001", 768,
     "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents",
     lambda b: b["requests"][1]["content"]["parts"][0]["text"] == "b"
     and b["requests"][0]["taskType"] == "RETRIEVAL_QUERY" and b["requests"][0]["outputDimensionality"] == 768),
    ("mistral", "MISTRAL_API_KEY", "mistral-embed", 1024, "https://api.mistral.ai/v1/embeddings",
     lambda b: b == {"model": "mistral-embed", "input": ["a", "b"]}),
    ("jina", "JINA_API_KEY", "jina-embeddings-v3", 256, "https://api.jina.ai/v1/embeddings",
     lambda b: b["task"] == "retrieval.query" and b["dimensions"] == 256),
]


@pytest.mark.parametrize("provider,env,model,dimension,url,check", PROVIDER_CASES, ids=[c[0] for c in PROVIDER_CASES])
def test_provider_requests(monkeypatch, provider, env, model, dimension, url, check):
    monkeypatch.setenv(env, "secret-key")
    seen = {}

    def handler(request: httpx.Request):
        seen["url"], seen["headers"], seen["body"] = str(request.url), request.headers, json.loads(request.content)
        first, second = [0.1] * dimension, [0.2] * dimension
        if provider == "cohere":
            return httpx.Response(200, json={"embeddings": {"float": [first, second]}})
        if provider == "google":
            return httpx.Response(200, json={"embeddings": [{"values": first}, {"values": second}]})
        # Out of order on purpose: results are matched to inputs by index.
        return httpx.Response(200, json={"data": [{"index": 1, "embedding": second}, {"index": 0, "embedding": first}]})

    _mock(handler)
    out = embed.embed_texts(provider, model, dimension, ["a", "b"], "query")
    assert out.shape == (2, dimension) and out[0][0] == pytest.approx(0.1) and out[1][0] == pytest.approx(0.2)
    assert seen["url"] == url
    auth = seen["headers"].get("x-goog-api-key") if provider == "google" else seen["headers"]["authorization"]
    assert auth in ("secret-key", "Bearer secret-key")
    assert check(seen["body"]), seen["body"]


def test_provider_errors(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "k")
    monkeypatch.setattr(embed.time, "sleep", lambda _s: None)
    for status, error in ((401, FailedPrecondition), (400, InvalidArgument), (429, ResourceExhausted)):
        _mock(lambda _r, status=status: httpx.Response(status, json={"error": {"message": "nope"}}))
        with pytest.raises(error):
            embed.embed_texts("openai", "text-embedding-3-small", 1536, ["hi"], "document")


def test_catalog_route_and_text_search(client, fake_openai, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-do-not-leak")
    monkeypatch.delenv("COHERE_API_KEY", raising=False)
    monkeypatch.delenv("CO_API_KEY", raising=False)
    resp = client.get("/embeddings/models")
    assert resp.status_code == 200 and "sk-test-do-not-leak" not in resp.text
    providers = {p["id"]: p for p in resp.json()["providers"]}
    assert providers["openai"]["available"] is True and providers["cohere"]["available"] is False
    assert any(m["id"] == "voyage-3.5" and 2048 in m["dimensions"] for m in resp.json()["models"])

    created = client.post("/indexes", json={"name": "shop", "embed": SMALL})
    assert created.status_code == 201, created.text
    assert created.json()["dimension"] == 1536 and created.json()["embed"]["model"] == "text-embedding-3-small"

    upserted = client.post("/indexes/shop/vectors/upsert", json={"vectors": [{"id": r, "text": t, "metadata": m} for r, t, m in DOCS]})
    assert upserted.json() == {"upsertedCount": 3}
    found = client.post("/indexes/shop/query", json={"text": "cast iron steak", "topK": 1, "includeMetadata": True}).json()
    assert found["matches"][0]["id"] == "skillet" and "embedMs" in found["usage"]

    bad = client.post("/indexes", json={"name": "bad", "embed": {"provider": "openai", "model": "text-embedding-3-small"}, "dimension": 7})
    assert bad.status_code == 400 and bad.json()["error"]["code"] == "INVALID_ARGUMENT"


def test_local_sdk_search(tmp_path, fake_openai):
    from needledb import NeedleDBLocal

    with NeedleDBLocal(tmp_path) as db:
        db.create_index("shop", embed=SMALL)
        index = db.Index("shop")
        index.upsert([{"id": r, "text": t, "metadata": m} for r, t, m in DOCS])
        assert index.search("searing steak").matches[0].id == "skillet"
        assert db.describe_index("shop").embed.model == "text-embedding-3-small"


@pytest.mark.skipif(importlib.util.find_spec("fastembed") is None or not os.environ.get("NEEDLEDB_TEST_LOCAL_EMBED"),
                    reason="set NEEDLEDB_TEST_LOCAL_EMBED=1 with fastembed installed (downloads a 67 MB model)")
def test_real_local_model_searches_by_meaning(registry):
    index = registry.create_index(IndexConfig.from_dict({"name": "local", "embed": {"provider": "local", "model": "BAAI/bge-small-en-v1.5"}}))
    index.upsert([{"id": r, "text": t, "metadata": m} for r, t, m in DOCS])
    assert index.query(text="a pan to cook dinner", top_k=1)["matches"][0]["id"] == "skillet"
    assert index.query(text="shoes for walking in the rain", top_k=1)["matches"][0]["id"] == "boots"


def test_playground_compares_models(client, fake_openai, monkeypatch):
    monkeypatch.delenv("COHERE_API_KEY", raising=False)
    monkeypatch.delenv("CO_API_KEY", raising=False)
    body = {"query": "hiking boots trails", "documents": [t for _, t, _ in DOCS], "topK": 2,
            "models": [SMALL, {"provider": "cohere", "model": "embed-english-v3.0"}]}
    resp = client.post("/playground/compare", json=body)
    assert resp.status_code == 200, resp.text
    first, second = resp.json()["results"]
    assert first["matches"][0]["index"] == 0 and len(first["matches"]) == 2 and first["dimension"] == 1536
    assert second["error"]["code"] == "FAILED_PRECONDITION"   # one model failing doesn't fail the rest

    calls = len(fake_openai)
    assert client.post("/playground/compare", json=body).status_code == 200
    assert len(fake_openai) == calls                          # documents and query came from the cache

    assert client.post("/playground/compare", json={**body, "documents": []}).status_code == 400
    assert client.post("/playground/compare", json={**body, "models": []}).status_code == 400


def test_text_queries_are_cached(registry, fake_openai):
    index = registry.create_index(IndexConfig.from_dict({"name": "shop", "dimension": 512, "embed": SMALL}))
    index.upsert([{"id": r, "text": t} for r, t, _ in DOCS])
    index.query(text="camping tent", top_k=1)
    calls = len(fake_openai)
    assert index.query(text="camping tent", top_k=1)["matches"][0]["id"] == "tent"
    assert len(fake_openai) == calls


def test_connect_a_model_to_an_existing_index(client, fake_openai):
    assert client.post("/indexes", json={"name": "legacy", "dimension": 1536}).status_code == 201
    vectors = [
        {"id": "boots", "values": bag_of_words(DOCS[0][1], 1536), "metadata": {"title": "Boots", "summary": DOCS[0][1]}},
        {"id": "skillet", "values": bag_of_words(DOCS[1][1], 1536), "metadata": {"title": "Skillet", "summary": DOCS[1][1]}},
    ]
    client.post("/indexes/legacy/vectors/upsert", json={"vectors": vectors})
    assert client.post("/indexes/legacy/query", json={"text": "boots"}).status_code == 400

    wrong_size = client.patch("/indexes/legacy", json={"embed": {"provider": "local", "model": "BAAI/bge-small-en-v1.5"}})
    assert wrong_size.status_code == 400 and "384" in wrong_size.json()["error"]["message"]

    connected = client.patch("/indexes/legacy", json={"embed": {**SMALL, "field": "summary"}})
    assert connected.status_code == 200 and connected.json()["embed"] == {**SMALL, "field": "summary"}
    found = client.post("/indexes/legacy/query", json={"text": "hiking boots trails", "topK": 1}).json()
    assert found["matches"][0]["id"] == "boots"

    assert client.patch("/indexes/legacy", json={"hnsw": {"ef_search": 64}}).json()["embed"]["field"] == "summary"
    assert client.patch("/indexes/legacy", json={"embed": None}).json()["embed"] is None
