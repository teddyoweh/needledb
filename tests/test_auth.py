"""Authentication, roles, index scoping, sessions, lockout and hardening."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from needledb.server.app import create_app

from .conftest import API_KEY

ORIGIN = {"Origin": "http://testserver"}


@pytest.fixture
def anon(app):
    with TestClient(app) as c:
        yield c


def seed(client):
    for name in ("alpha", "beta"):
        assert client.post("/indexes", json={"name": name, "dimension": 2}).status_code == 201
        client.post(f"/indexes/{name}/vectors/upsert", json={"vectors": [{"id": "a", "values": [1, 0]}]})


def key(client, **body) -> str:
    resp = client.post("/keys", json=body)
    assert resp.status_code == 201, resp.text
    return resp.json()["key"]


def test_everything_but_the_front_door_needs_auth(anon):
    assert anon.get("/health").json() == {"status": "ok"}
    assert anon.get("/app/").status_code in (200, 404)
    for path in ("/indexes", "/stats", "/metrics", "/keys", "/docs", "/openapi.json"):
        assert anon.get(path).status_code == 401, path
    assert anon.get("/auth/me").json() == {"authRequired": True, "authenticated": False}


def test_roles_and_index_scope(client, anon):
    seed(client)
    reader = key(client, name="reader", role="read")
    writer = key(client, name="writer", role="write", indexes=["alpha"])
    assert reader.startswith("ndb_")

    r = {"Api-Key": reader}
    assert anon.post("/indexes/alpha/query", json={"id": "a", "topK": 1}, headers=r).status_code == 200
    denied = anon.post("/indexes/alpha/vectors/upsert", json={"vectors": [{"id": "b", "values": [0, 1]}]}, headers=r)
    assert denied.status_code == 403 and denied.json()["error"]["code"] == "PERMISSION_DENIED"
    assert anon.post("/indexes", json={"name": "gamma", "dimension": 2}, headers=r).status_code == 403
    assert anon.get("/keys", headers=r).status_code == 403

    w = {"Api-Key": writer}
    ok = anon.post("/indexes/alpha/vectors/upsert", json={"vectors": [{"id": "b", "values": [0, 1]}]}, headers=w)
    assert ok.status_code == 200
    assert anon.post("/indexes/beta/query", json={"id": "a", "topK": 1}, headers=w).status_code == 404
    assert [i["name"] for i in anon.get("/indexes", headers=w).json()["indexes"]] == ["alpha"]
    assert [i["name"] for i in anon.get("/stats", headers=w).json()["indexes"]] == ["alpha"]
    assert anon.get("/metrics", headers=w).status_code == 403

    with pytest.raises(AssertionError):
        key(client, name="bad", role="admin", indexes=["alpha"])


def test_keys_are_stored_hashed_and_revocable(client, anon, app, tmp_path):
    info = client.post("/keys", json={"name": "ci", "role": "read"}).json()
    secret = info.pop("key")
    listed = client.get("/keys").json()["keys"]
    assert {"id": "env-1", "managed": False}.items() <= listed[0].items()
    assert all("key" not in k and "hash" not in k for k in listed)
    for f in (tmp_path / "server-data" / "_system").iterdir():
        assert secret.encode() not in f.read_bytes()

    assert anon.get("/indexes", headers={"Api-Key": secret}).status_code == 200
    assert client.delete(f"/keys/{info['id']}").status_code == 200
    assert anon.get("/indexes", headers={"Api-Key": secret}).status_code == 401
    assert client.delete("/keys/env-1").status_code == 400


def test_session_login_logout_and_csrf(app):
    with TestClient(app) as browser:
        bad = browser.post("/auth/login", json={"apiKey": "nope"})
        assert bad.status_code == 401
        login = browser.post("/auth/login", json={"apiKey": API_KEY})
        assert login.status_code == 200
        cookie = login.headers["set-cookie"].lower()
        assert "httponly" in cookie and "samesite=strict" in cookie and API_KEY.lower() not in cookie
        assert login.json()["principal"]["role"] == "admin"

        assert browser.get("/indexes").status_code == 200
        me = browser.get("/auth/me").json()
        assert me["authenticated"] and me["via"] == "session"

        body = {"name": "fromapp", "dimension": 2}
        assert browser.post("/indexes", json=body, headers={"Origin": "https://evil.example"}).status_code == 403
        assert browser.post("/indexes", json=body, headers=ORIGIN).status_code == 201

        assert browser.post("/auth/logout", headers=ORIGIN).status_code == 200
        assert browser.get("/indexes").status_code == 401


def test_revoking_a_key_ends_its_sessions_and_rotation_ends_all(client, app):
    info = client.post("/keys", json={"name": "laptop", "role": "read"}).json()
    with TestClient(app) as browser, TestClient(app) as admin_browser:
        assert browser.post("/auth/login", json={"apiKey": info["key"]}).status_code == 200
        assert browser.get("/indexes").status_code == 200
        client.delete(f"/keys/{info['id']}")
        assert browser.get("/indexes").status_code == 401

        admin_browser.post("/auth/login", json={"apiKey": API_KEY})
        assert admin_browser.get("/indexes").status_code == 200
        assert admin_browser.post("/auth/sessions/revoke-all", headers=ORIGIN).status_code == 200
        assert admin_browser.get("/indexes").status_code == 401


def test_lockout_after_repeated_failures(anon):
    for _ in range(10):
        assert anon.get("/indexes", headers={"Api-Key": "wrong"}).status_code == 401
    blocked = anon.get("/indexes", headers={"Api-Key": API_KEY})
    assert blocked.status_code == 429 and int(blocked.headers["retry-after"]) > 0
    assert anon.post("/auth/login", json={"apiKey": API_KEY}).status_code == 429


def test_security_headers_and_body_limit(tmp_path):
    app = create_app(tmp_path / "small", api_keys=[API_KEY], max_body_mb=1)
    with TestClient(app, headers={"Api-Key": API_KEY}) as c:
        resp = c.get("/indexes")
        for header in ("x-content-type-options", "x-frame-options", "referrer-policy", "content-security-policy"):
            assert header in resp.headers
        assert resp.headers["cache-control"] == "no-store"
        big = c.post("/indexes", content=b"x" * (2 * 2**20), headers={"Content-Type": "application/json"})
        assert big.status_code == 413
        assert c.get("/ui/anything", follow_redirects=False).headers["location"] == "/app/"
    app.state.registry.close()


def test_audit_log_records_security_events(client, app, anon):
    anon.post("/auth/login", json={"apiKey": "wrong"})
    anon.get("/indexes", headers={"Api-Key": "also-wrong"})
    info = client.post("/keys", json={"name": "ci", "role": "read"}).json()
    client.delete(f"/keys/{info['id']}")
    client.post("/indexes", json={"name": "logged", "dimension": 2})
    TestClient(app).post("/auth/login", json={"apiKey": API_KEY})   # no lifespan: keeps the app open

    events = client.get("/events", params={"limit": 20}).json()["events"]
    actions = [e["action"] for e in events]
    for expected in ("auth.sign_in_failed", "auth.key_rejected", "key.created", "key.revoked",
                     "index.created", "auth.signed_in"):
        assert expected in actions
    assert actions.index("auth.signed_in") < actions.index("auth.sign_in_failed")   # newest first
    created = next(e for e in events if e["action"] == "key.created")
    assert created["target"] == "ci" and created["actorName"] == "Environment key" and created["ok"]
    assert next(e for e in events if e["action"] == "auth.key_rejected")["ok"] is False
    assert all("key" not in (e["detail"] or {}) for e in events)

    reader = client.post("/keys", json={"name": "r", "role": "read"}).json()["key"]
    assert anon.get("/events", headers={"Api-Key": reader}).status_code == 403


def test_local_mode_needs_no_key(tmp_path):
    app = create_app(tmp_path / "local", api_keys=[], allow_no_auth=True)
    with TestClient(app) as c:
        assert c.get("/indexes").status_code == 200
        assert c.get("/auth/me").json()["principal"]["source"] == "local"
    app.state.registry.close()


def test_cli_refuses_public_no_auth(tmp_path, capsys):
    from needledb.cli import main

    assert main(["serve", "--data", str(tmp_path), "--host", "0.0.0.0", "--no-auth"]) == 2
    assert "refusing" in capsys.readouterr().err
