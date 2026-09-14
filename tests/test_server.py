"""The HTTP API: routes, auth, error shapes, ops endpoints."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from needledb.server.app import create_app

from .conftest import API_KEY


def make_index(client, name="products", dimension=3, **extra):
    resp = client.post("/indexes", json={"name": name, "dimension": dimension, **extra})
    assert resp.status_code == 201, resp.text
    return resp.json()


def test_auth(app):
    with TestClient(app) as anon:
        assert anon.get("/health").status_code == 200
        resp = anon.get("/indexes")
        assert resp.status_code == 401
        assert resp.json()["error"]["code"] == "UNAUTHENTICATED"
        assert anon.get("/indexes", headers={"Api-Key": "wrong"}).status_code == 401
        assert anon.get("/indexes", headers={"Authorization": f"Bearer {API_KEY}"}).status_code == 200


def test_no_key_refuses_to_start(tmp_path, monkeypatch):
    monkeypatch.delenv("NEEDLEDB_API_KEY", raising=False)
    monkeypatch.delenv("NEEDLEDB_ALLOW_NO_AUTH", raising=False)
    with pytest.raises(RuntimeError):
        create_app(tmp_path, api_keys=[])


def test_control_plane(client):
    created = make_index(client, index_type="hnsw", hnsw={"m": 16, "ef_search": 64}, metric="dotproduct")
    assert created["host"].endswith("/indexes/products")
    assert created["hnsw"] == {"m": 16, "ef_construction": 200, "ef_search": 64}
    assert client.post("/indexes", json={"name": "products", "dimension": 3}).status_code == 409
    assert [i["name"] for i in client.get("/indexes").json()["indexes"]] == ["products"]

    patched = client.patch("/indexes/products", json={"hnsw": {"ef_search": 300}})
    assert patched.json()["hnsw"]["ef_search"] == 300
    assert client.patch("/indexes/products", json={"dimension": 5}).status_code == 400

    assert client.delete("/indexes/products").status_code == 202
    missing = client.get("/indexes/products")
    assert missing.status_code == 404 and missing.json()["error"]["code"] == "NOT_FOUND"


@pytest.mark.parametrize("body", [
    {"name": "x", "dimension": "3"}, {"name": "UPPER", "dimension": 3},
    {"name": "x", "dimension": 3, "hnsw": {"bogus": 1}}, {"dimension": 3},
])
def test_create_index_validation(client, body):
    resp = client.post("/indexes", json=body)
    assert resp.status_code == 400 and resp.json()["error"]["code"] == "INVALID_ARGUMENT"


def test_data_plane(client):
    make_index(client)
    base = "/indexes/products"
    up = client.post(f"{base}/vectors/upsert", json={"vectors": [
        {"id": "a", "values": [1, 0, 0], "metadata": {"brand": "acme", "price": 10}},
        {"id": "b", "values": [0.9, 0.1, 0], "metadata": {"brand": "zenith", "price": 30}},
        {"id": "c", "values": [0, 0, 1], "metadata": {"brand": "acme", "price": 50}},
    ]})
    assert up.json() == {"upsertedCount": 3}

    q = client.post(f"{base}/query", json={"vector": [1, 0, 0], "topK": 2, "includeMetadata": True}).json()
    assert [m["id"] for m in q["matches"]] == ["a", "b"]
    assert q["matches"][0]["metadata"]["brand"] == "acme" and "values" not in q["matches"][0]
    assert q["usage"]["plan"] == "exact" and q["usage"]["latencyMs"] >= 0

    filtered = client.post(f"{base}/query", json={
        "vector": [1, 0, 0], "top_k": 5, "filter": {"$and": [{"brand": "acme"}, {"price": {"$gte": 20}}]}})
    assert [m["id"] for m in filtered.json()["matches"]] == ["c"]

    by_id = client.post(f"{base}/query", json={"id": "a", "topK": 1, "includeValues": True}).json()
    assert by_id["matches"][0]["values"] == [1, 0, 0]

    fetched = client.get(f"{base}/vectors/fetch", params=[("ids", "a"), ("ids", "zzz")]).json()
    assert list(fetched["vectors"]) == ["a"]
    assert client.post(f"{base}/vectors/fetch", json={"ids": ["b"]}).json()["vectors"]["b"]["metadata"]["price"] == 30

    assert client.post(f"{base}/vectors/update", json={"id": "b", "setMetadata": {"price": 35}}).status_code == 200
    stats = client.post(f"{base}/describe_index_stats", json={"filter": {"price": {"$gt": 32}}}).json()
    assert stats["totalVectorCount"] == 2 and stats["dimension"] == 3

    listing = client.get(f"{base}/vectors/list", params={"limit": 2}).json()
    assert [v["id"] for v in listing["vectors"]] == ["a", "b"] and listing["pagination"]["next"] == "b"

    assert client.post(f"{base}/vectors/delete", json={"ids": ["a"]}).json() == {"deletedCount": 1}
    assert client.post(f"{base}/vectors/delete", json={"deleteAll": True}).json() == {"deletedCount": 2}
    assert client.get(f"{base}/describe_index_stats").json()["totalVectorCount"] == 0


@pytest.mark.parametrize("path,body,code", [
    ("/query", {"vector": [1, 0], "topK": 1}, "INVALID_ARGUMENT"),
    ("/query", {"topK": 1}, "INVALID_ARGUMENT"),
    ("/query", {"vector": [1, 0, 0], "topK": 1, "filter": {"a": {"$regex": "x"}}}, "INVALID_ARGUMENT"),
    ("/vectors/upsert", {"vectors": [{"id": "a", "values": [1, 2]}]}, "INVALID_ARGUMENT"),
    ("/vectors/update", {"id": "missing", "setMetadata": {"a": 1}}, "NOT_FOUND"),
    ("/vectors/delete", {}, "INVALID_ARGUMENT"),
])
def test_data_plane_errors(client, path, body, code):
    make_index(client)
    client.post("/indexes/products/vectors/upsert", json={"vectors": [{"id": "x", "values": [1, 1, 1]}]})
    resp = client.post(f"/indexes/products{path}", json=body)
    assert resp.json()["error"]["code"] == code
    assert resp.status_code == {"INVALID_ARGUMENT": 400, "NOT_FOUND": 404}[code]


def test_malformed_json_and_unknown_routes(client):
    make_index(client)
    resp = client.post("/indexes/products/query", content=b"{not json", headers={"Content-Type": "application/json"})
    assert resp.status_code == 400
    assert client.post("/indexes/nope/query", json={"vector": [1], "topK": 1}).status_code == 404
    assert client.get("/nowhere").json()["error"]["code"] == "NOT_FOUND"


def test_stats_and_metrics(client):
    make_index(client)
    client.post("/indexes/products/vectors/upsert", json={"vectors": [{"id": "a", "values": [1, 2, 3]}]})
    for _ in range(5):
        client.post("/indexes/products/query", json={"vector": [1, 2, 3], "topK": 1})
    stats = client.get("/stats").json()
    assert stats["totals"] == {**stats["totals"], "indexes": 1, "vectors": 1}
    assert stats["requests"]["routes"]["/indexes/{name}/query"]["count"] == 5
    assert stats["requests"]["indexes"]["products"]["count"] >= 6
    text = client.get("/metrics").text
    assert 'needledb_vectors{index="products",namespace=""} 1' in text
    assert 'route="/indexes/{name}/query"' in text
