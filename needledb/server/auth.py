"""Who is calling, and what they may do.

API keys
    `ndb_…` secrets. Only a SHA-256 digest is stored; the key itself is shown once, at
    creation. Keys listed in NEEDLEDB_API_KEY are admin keys managed outside the app.

Roles
    read  — query, fetch, list, stats
    write — read, plus upsert, update, delete
    admin — write, plus create and delete indexes and manage keys
    Read and write keys can be limited to named indexes; other indexes look absent to them.

Dashboard sessions
    Signing in with a key sets an HttpOnly, SameSite=Strict cookie holding an HMAC-signed
    token that names the key (never the key itself). Revoking the key ends its sessions,
    signing out ends that session, and rotating the signing secret ends every session.

Lockout
    Too many failed attempts from one client are refused for a while, so keys can't be
    brute-forced through the API or the sign-in page.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import threading
import time
from collections import deque
from dataclasses import dataclass
from pathlib import Path

from ..errors import InvalidArgument, NotFound

ROLES = ("read", "write", "admin")
_RANK = {role: i for i, role in enumerate(ROLES)}
KEY_PREFIX = "ndb_"
SESSION_COOKIE = "needledb_session"
SESSION_TTL_S = 12 * 3600
_CACHE_S = 5.0
_INDEX_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,43}[a-z0-9])?$")

_SCHEMA = """
create table if not exists api_keys (
    id           text primary key,
    name         text not null,
    prefix       text not null,
    hash         text not null unique,
    role         text not null,
    indexes      text,
    created_at   real not null,
    last_used_at real,
    revoked_at   real
);
"""


@dataclass(frozen=True)
class Principal:
    id: str
    name: str
    role: str
    indexes: tuple[str, ...] | None = None      # None: every index
    source: str = "key"                          # key · environment · local

    def allows(self, role: str) -> bool:
        return _RANK[self.role] >= _RANK[role]

    def can_access(self, index: str) -> bool:
        return self.indexes is None or index in self.indexes

    def to_dict(self) -> dict:
        return {"id": self.id, "name": self.name, "role": self.role, "source": self.source,
                "indexes": list(self.indexes) if self.indexes is not None else None}


LOCAL = Principal(id="local", name="Local access", role="admin", source="local")


def _digest(key: str) -> str:
    return hashlib.sha256(key.encode()).hexdigest()


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


class KeyStore:
    def __init__(self, directory: Path, environment_keys: list[str]):
        directory.mkdir(parents=True, exist_ok=True)
        try:
            os.chmod(directory, 0o700)
        except OSError:
            pass
        self._dir = directory
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(directory / "auth.sqlite", check_same_thread=False, isolation_level=None)
        self._conn.execute("pragma journal_mode = wal")
        self._conn.executescript(_SCHEMA)
        self._environment = {_digest(k): i for i, k in enumerate(environment_keys)}
        self._secret = self._load_secret()
        self._by_digest: dict[str, tuple[float, Principal | None]] = {}
        self._by_id: dict[str, tuple[float, Principal | None]] = {}
        self._touched: dict[str, float] = {}
        self._ended: dict[str, float] = {}          # signed-out session nonce → expiry

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    @property
    def environment_key_count(self) -> int:
        return len(self._environment)

    # ---- keys ------------------------------------------------------------------------

    def authenticate(self, key: str) -> Principal | None:
        if not isinstance(key, str) or not key:
            return None
        digest = _digest(key)
        ordinal = self._environment.get(digest)
        if ordinal is not None:
            return self._environment_principal(ordinal)
        now = time.monotonic()
        hit = self._by_digest.get(digest)
        if hit and hit[0] > now:
            principal = hit[1]
        else:
            principal = self._load("hash", digest)
            self._remember(self._by_digest, digest, principal, now)
        if principal is not None:
            self._touch(principal.id)
        return principal

    def create_key(self, name: str, role: str, indexes: list[str] | None = None) -> tuple[dict, str]:
        if not isinstance(name, str) or not name.strip() or len(name.strip()) > 64:
            raise InvalidArgument("name must be 1–64 characters")
        if role not in ROLES:
            raise InvalidArgument("role must be read, write or admin")
        if indexes is not None:
            if role == "admin":
                raise InvalidArgument("admin keys always cover every index")
            if (not isinstance(indexes, list) or not indexes
                    or not all(isinstance(i, str) and _INDEX_RE.match(i) for i in indexes)):
                raise InvalidArgument("indexes must be a non-empty list of index names")
            indexes = sorted(set(indexes))
        key = KEY_PREFIX + secrets.token_urlsafe(32)
        key_id = "key_" + secrets.token_hex(6)
        with self._lock:
            self._conn.execute(
                "insert into api_keys (id, name, prefix, hash, role, indexes, created_at) values (?, ?, ?, ?, ?, ?, ?)",
                (key_id, name.strip(), key[:10], _digest(key), role,
                 json.dumps(indexes) if indexes is not None else None, time.time()))
        return self.get_key(key_id), key

    def get_key(self, key_id: str) -> dict:
        with self._lock:
            row = self._conn.execute(
                "select id, name, prefix, role, indexes, created_at, last_used_at from api_keys "
                "where id = ? and revoked_at is null", (key_id,)).fetchone()
        if row is None:
            raise NotFound(f"key {key_id!r} not found")
        return self._key_dict(row)

    def list_keys(self) -> list[dict]:
        with self._lock:
            rows = self._conn.execute(
                "select id, name, prefix, role, indexes, created_at, last_used_at from api_keys "
                "where revoked_at is null order by created_at desc").fetchall()
        environment = [{"id": f"env-{i + 1}", "name": self._environment_name(i), "prefix": None, "role": "admin",
                        "indexes": None, "createdAt": None, "lastUsedAt": None, "managed": False}
                       for i in range(len(self._environment))]
        return environment + [self._key_dict(r) for r in rows]

    def count_active(self) -> int:
        with self._lock:
            return self._conn.execute("select count(*) from api_keys where revoked_at is null").fetchone()[0]

    def revoke_key(self, key_id: str) -> None:
        if key_id.startswith("env-"):
            raise InvalidArgument("environment keys come from NEEDLEDB_API_KEY; remove them there and restart")
        with self._lock:
            cur = self._conn.execute("update api_keys set revoked_at = ? where id = ? and revoked_at is null",
                                     (time.time(), key_id))
        if cur.rowcount == 0:
            raise NotFound(f"key {key_id!r} not found")
        self._by_digest.clear()
        self._by_id.clear()

    # ---- sessions --------------------------------------------------------------------

    def issue_session(self, principal: Principal) -> tuple[str, int]:
        expires = int(time.time()) + SESSION_TTL_S
        claims = {"sub": principal.id, "exp": expires, "n": secrets.token_hex(8)}
        if principal.source == "environment":
            ordinal = int(principal.id.split("-")[1]) - 1
            claims["kh"] = next(d for d, i in self._environment.items() if i == ordinal)[:16]
        body = _b64(json.dumps(claims, separators=(",", ":")).encode())
        return f"{body}.{self._sign(body)}", expires

    def verify_session(self, token: str) -> tuple[Principal, dict] | None:
        body, _, signature = token.partition(".")
        if not body or not signature or not hmac.compare_digest(signature, self._sign(body)):
            return None
        try:
            claims = json.loads(_unb64(body))
        except ValueError:
            return None
        if not isinstance(claims, dict) or claims.get("exp", 0) < time.time() or claims.get("n") in self._ended:
            return None
        subject = str(claims.get("sub", ""))
        if subject.startswith("env-"):
            ordinal = next((i for d, i in self._environment.items() if d[:16] == claims.get("kh")), None)
            return (self._environment_principal(ordinal), claims) if ordinal is not None else None
        now = time.monotonic()
        hit = self._by_id.get(subject)
        if hit and hit[0] > now:
            principal = hit[1]
        else:
            principal = self._load("id", subject)
            self._remember(self._by_id, subject, principal, now)
        return (principal, claims) if principal is not None else None

    def end_session(self, claims: dict) -> None:
        now = time.time()
        self._ended = {n: exp for n, exp in self._ended.items() if exp > now}
        self._ended[claims["n"]] = claims["exp"]

    def rotate_secret(self) -> None:
        if os.environ.get("NEEDLEDB_SESSION_SECRET"):
            raise InvalidArgument("the session secret comes from NEEDLEDB_SESSION_SECRET; change it there")
        self._secret = self._write_secret(self._dir / "session.key")

    # ---- internals -------------------------------------------------------------------

    def _sign(self, body: str) -> str:
        return _b64(hmac.new(self._secret, body.encode(), hashlib.sha256).digest())

    def _load_secret(self) -> bytes:
        configured = os.environ.get("NEEDLEDB_SESSION_SECRET")
        if configured:
            return hashlib.sha256(configured.encode()).digest()
        path = self._dir / "session.key"
        try:
            secret = path.read_bytes()
            if len(secret) == 32:
                return secret
        except FileNotFoundError:
            pass
        return self._write_secret(path)

    @staticmethod
    def _write_secret(path: Path) -> bytes:
        secret = secrets.token_bytes(32)
        tmp = path.with_suffix(".tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "wb") as f:
            f.write(secret)
        os.replace(tmp, path)
        return secret

    def _load(self, column: str, value: str) -> Principal | None:
        with self._lock:
            row = self._conn.execute(
                f"select id, name, role, indexes from api_keys where {column} = ? and revoked_at is null",
                (value,)).fetchone()
        if row is None:
            return None
        indexes = tuple(json.loads(row[3])) if row[3] else None
        return Principal(id=row[0], name=row[1], role=row[2], indexes=indexes)

    @staticmethod
    def _remember(cache: dict, key: str, principal: Principal | None, now: float) -> None:
        if len(cache) > 10_000:
            cache.clear()
        cache[key] = (now + _CACHE_S, principal)

    def _touch(self, key_id: str) -> None:
        now = time.time()
        if now - self._touched.get(key_id, 0) < 60:
            return
        self._touched[key_id] = now
        with self._lock:
            self._conn.execute("update api_keys set last_used_at = ? where id = ?", (now, key_id))

    def _environment_name(self, ordinal: int) -> str:
        return "Environment key" if len(self._environment) == 1 else f"Environment key {ordinal + 1}"

    def _environment_principal(self, ordinal: int) -> Principal:
        return Principal(id=f"env-{ordinal + 1}", name=self._environment_name(ordinal), role="admin",
                         source="environment")

    @staticmethod
    def _key_dict(row) -> dict:
        return {"id": row[0], "name": row[1], "prefix": row[2], "role": row[3],
                "indexes": json.loads(row[4]) if row[4] else None,
                "createdAt": row[5], "lastUsedAt": row[6], "managed": True}


class Lockout:
    """Refuse a client after too many failed authentication attempts."""

    def __init__(self, max_failures: int = 10, window_s: float = 300, block_s: float = 300):
        self.max_failures, self.window_s, self.block_s = max_failures, window_s, block_s
        self._failures: dict[str, deque[float]] = {}
        self._blocked: dict[str, float] = {}

    def retry_after(self, client: str) -> int:
        until = self._blocked.get(client)
        if until is None:
            return 0
        remaining = until - time.monotonic()
        if remaining <= 0:
            del self._blocked[client]
            return 0
        return int(remaining) + 1

    def failed(self, client: str) -> None:
        now = time.monotonic()
        if len(self._failures) > 50_000:
            self._failures.clear()
        attempts = self._failures.setdefault(client, deque())
        attempts.append(now)
        while attempts and attempts[0] < now - self.window_s:
            attempts.popleft()
        if len(attempts) >= self.max_failures:
            self._blocked[client] = now + self.block_s
            attempts.clear()

    def succeeded(self, client: str) -> None:
        self._failures.pop(client, None)
