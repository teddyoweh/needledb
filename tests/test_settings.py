"""Embedding-provider keys saved from the web app: stored privately, used, never returned."""
from __future__ import annotations

import httpx
import pytest
from fastapi.testclient import TestClient

from needledb import embed
from needledb.server.app import create_app

from .conftest import API_KEY

SECRET = "sk-test-0123456789abcdWXYZ"


@pytest.fixture(autouse=True)
def _isolate(monkeypatch):
    for name in ("OPENAI_API_KEY", "COHERE_API_KEY", "CO_API_KEY"):
        monkeypatch.delenv(name, raising=False)
    yield
    embed.set_key_resolver(None)
    embed.set_http_client(None)


def _row(client, provider):
    return next(p for p in client.get("/settings/providers").json()["providers"] if p["id"] == provider)


def _openai_answers(seen: dict):
    def handler(request: httpx.Request):
        seen["auth"] = request.headers["authorization"]
        return httpx.Response(200, json={"data": [{"index": 0, "embedding": [0.1] * 1536}]})
    embed.set_http_client(httpx.Client(transport=httpx.MockTransport(handler)))


def test_saved_keys_are_used_and_never_returned(client, tmp_path):
    assert _row(client, "openai")["available"] is False

    saved = client.post("/settings/providers/openai", json={"apiKey": SECRET})
    assert saved.status_code == 200, saved.text
    assert SECRET not in saved.text
    assert saved.json()["source"] == "app" and saved.json()["saved"]["hint"] == "WXYZ"

    models = client.get("/embeddings/models")
    assert SECRET not in models.text
    assert next(p for p in models.json()["providers"] if p["id"] == "openai")["keySource"] == "app"

    seen: dict = {}
    _openai_answers(seen)
    check = client.post("/settings/providers/openai/test", json={}).json()
    assert check["ok"] is True and seen["auth"] == f"Bearer {SECRET}"

    path = tmp_path / "server-data" / "_system" / "providers.json"
    assert path.stat().st_mode & 0o777 == 0o600

    events = client.get("/events").text
    assert "provider.key_set" in events and SECRET not in events

    assert client.delete("/settings/providers/openai").status_code == 200
    assert _row(client, "openai")["available"] is False and _row(client, "openai")["saved"] is None


def test_trying_a_key_before_saving_it(client):
    seen: dict = {}
    _openai_answers(seen)
    result = client.post("/settings/providers/openai/test", json={"apiKey": "sk-trial"}).json()
    assert result["ok"] is True and seen["auth"] == "Bearer sk-trial"
    assert _row(client, "openai")["saved"] is None

    embed.set_http_client(httpx.Client(transport=httpx.MockTransport(
        lambda _r: httpx.Response(401, json={"error": {"message": "Incorrect API key provided"}}))))
    failed = client.post("/settings/providers/openai/test", json={"apiKey": "sk-wrong"}).json()
    assert failed["ok"] is False and failed["code"] == "FAILED_PRECONDITION" and "rejected" in failed["message"]


def test_environment_keys_take_precedence(client, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-from-env")
    assert _row(client, "openai")["source"] == "environment"
    refused = client.post("/settings/providers/openai", json={"apiKey": SECRET})
    assert refused.status_code == 400 and refused.json()["error"]["code"] == "FAILED_PRECONDITION"


def test_validation_and_admin_only(client, app):
    assert client.post("/settings/providers/openai", json={"apiKey": "has spaces in it"}).status_code == 400
    assert client.post("/settings/providers/local", json={"apiKey": SECRET}).status_code == 400
    assert client.post("/settings/providers/acme", json={"apiKey": SECRET}).status_code == 404

    reader = client.post("/keys", json={"name": "reader", "role": "read"}).json()["key"]
    with TestClient(app, headers={"Api-Key": reader}) as limited:
        assert limited.get("/settings/providers").status_code == 403
        assert limited.post("/settings/providers/openai", json={"apiKey": SECRET}).status_code == 403


def test_saved_keys_survive_a_restart(client, tmp_path):
    client.post("/settings/providers/cohere", json={"apiKey": SECRET})
    restarted = create_app(tmp_path / "server-data", api_keys=[API_KEY])
    try:
        assert embed.available(embed.PROVIDERS["cohere"]) is True
        assert embed.key_source(embed.PROVIDERS["cohere"]) == "app"
    finally:
        restarted.state.registry.close()
