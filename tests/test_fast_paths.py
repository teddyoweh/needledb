"""Binary vectors and the query fast path: same answers, same checks, same errors."""
from __future__ import annotations

import base64

import numpy as np
from fastapi.testclient import TestClient


def b64(values) -> str:
    return base64.b64encode(np.asarray(values, dtype="<f4").tobytes()).decode()


def test_binary_vectors_give_the_same_answers(client):
    client.post("/indexes", json={"name": "bin", "dimension": 4})
    vectors = {"a": [1, 0, 0, 0], "b": [0, 1, 0, 0], "c": [0.9, 0.1, 0, 0]}
    upserted = client.post("/indexes/bin/vectors/upsert",
                           json={"vectors": [{"id": k, "values": b64(v)} for k, v in vectors.items()]})
    assert upserted.json() == {"upsertedCount": 3}

    as_json = client.post("/indexes/bin/query", json={"vector": [1, 0, 0, 0], "topK": 3}).json()
    as_binary = client.post("/indexes/bin/query", json={"vector": b64([1, 0, 0, 0]), "topK": 3}).json()
    assert [m["id"] for m in as_json["matches"]] == [m["id"] for m in as_binary["matches"]] == ["a", "c", "b"]

    values = client.post("/indexes/bin/vectors/fetch", json={"ids": ["c"]}).json()["vectors"]["c"]["values"]
    assert np.allclose(values, [0.9, 0.1, 0, 0])

    wrong_size = client.post("/indexes/bin/query", json={"vector": b64([1, 0, 0]), "topK": 1})
    assert wrong_size.status_code == 400 and "float32" in wrong_size.json()["error"]["message"]
    assert client.post("/indexes/bin/query", json={"vector": "not base64!", "topK": 1}).status_code == 400


def test_query_fast_path_keeps_access_checks_errors_headers_and_metrics(app, client):
    client.post("/indexes", json={"name": "fast", "dimension": 2})
    client.post("/indexes", json={"name": "other", "dimension": 2})
    client.post("/indexes/fast/vectors/upsert", json={"vectors": [{"id": "x", "values": [1, 0]}]})

    assert TestClient(app).post("/indexes/fast/query", json={"vector": [1, 0]}).status_code == 401

    scoped = client.post("/keys", json={"name": "scoped", "role": "read", "indexes": ["fast"]}).json()["key"]
    limited = TestClient(app, headers={"Api-Key": scoped})
    assert limited.post("/indexes/fast/query", json={"vector": [1, 0], "topK": 1}).json()["matches"][0]["id"] == "x"
    hidden = limited.post("/indexes/other/query", json={"vector": [1, 0]})
    assert hidden.status_code == 404 and hidden.json()["error"]["code"] == "NOT_FOUND"

    assert client.post("/indexes/missing/query", json={"vector": [1, 0]}).status_code == 404
    malformed = client.post("/indexes/fast/query", content=b"{not json", headers={"Content-Type": "application/json"})
    assert malformed.status_code == 400 and malformed.json()["error"]["code"] == "INVALID_ARGUMENT"

    fast = client.post("/indexes/fast/query", json={"vector": [1, 0]})
    routed = client.post("/indexes/fast/describe_index_stats", json={})
    assert set(fast.headers) == set(routed.headers)          # same security headers as framework routes
    assert "/indexes/{name}/query" in app.state.metrics.live()["routes"]
    assert "fast" in app.state.metrics.live()["indexes"]


def test_sdk_sends_binary_vectors_and_can_fall_back(app, monkeypatch):
    from needledb import NeedleDB

    from .conftest import API_KEY

    http = TestClient(app, headers={"Api-Key": API_KEY})
    for binary in (True, False):
        db = NeedleDB("http://testserver", api_key=API_KEY, client=http, binary_vectors=binary)
        name = f"sdk-{int(binary)}"
        db.create_index(name, dimension=3)
        index = db.Index(name)
        index.upsert([("p", [1.0, 0.0, 0.0]), {"id": "q", "values": np.array([0.0, 1.0, 0.0])}])
        index.update("q", values=[0.0, 0.0, 1.0])
        assert index.query(vector=np.array([0.1, 0.0, 1.0]), top_k=1).matches[0].id == "q"
