"""The HTTP API: auth, control plane, data plane, ops endpoints and the web app.

Handlers read the raw body on the event loop, then parse, run the engine and
serialize in a worker thread — FAISS releases the GIL while it searches, so
concurrent queries use every core and the loop never blocks on a large payload.

Every request passes one gate that sets security headers, caps the body size,
authenticates (an `Api-Key` header, or the web app's session cookie), refuses
cross-site cookie writes, and records metrics. Each route then checks the caller's
role and index access.
"""
from __future__ import annotations

import os
import re
import threading
from contextlib import asynccontextmanager
from pathlib import Path
from time import perf_counter

import orjson
from anyio import to_thread
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import RedirectResponse, Response
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.staticfiles import StaticFiles

from .. import __version__
from ..core import IndexConfig, Registry
from ..core.cpu import tune_threads
from ..core.metrics import Metrics
from ..embed import catalog as embed_catalog
from ..embed import PROVIDERS as EMBED_PROVIDERS
from ..embed import available as provider_available
from ..embed import check_provider, key_source, set_key_resolver
from ..embed import compare as embed_compare
from ..errors import (
    FailedPrecondition,
    InvalidArgument,
    NeedleError,
    NotFound,
    PayloadTooLarge,
    PermissionDenied,
    Unauthenticated,
)
from .audit import AuditLog
from .providers import ProviderKeys
from .auth import LOCAL, SESSION_COOKIE, SESSION_TTL_S, KeyStore, Lockout, Principal

STATIC_DIR = Path(__file__).parent / "static"
_PUBLIC = {"/", "/health", "/auth/login", "/auth/logout", "/auth/me", "/app", "/ui"}
_PUBLIC_PREFIXES = ("/app/", "/ui/")
_UNTRACKED = ("/health", "/metrics", "/stats", "/app", "/ui", "/auth", "/keys", "/docs", "/openapi.json")
_SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}
_APP_CSP = (b"default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; "
            b"form-action 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; "
            b"font-src 'self' https://fonts.gstatic.com; "
            b"script-src 'self'; connect-src 'self'")


def _json(content, status: int = 200, headers: dict | None = None) -> Response:
    return Response(orjson.dumps(content), status_code=status, media_type="application/json", headers=headers)


def _error(status: int, code: str, message: str, headers: dict | None = None) -> Response:
    return _json({"error": {"code": code, "message": message}}, status, headers)


_QUERY_PATH = re.compile(r"^/indexes/([^/]+)/query$")


def _query_response(index, raw: bytes) -> bytes:
    """Parse a query body, search, and serialize — shared by the route and the fast path."""
    body = _parse(raw)
    return orjson.dumps(index.query(
        vector=body.get("vector"),
        id=body.get("id"),
        text=body.get("text"),
        top_k=_opt(body, "topK", "top_k", default=10),
        namespace=body.get("namespace"),
        filter=body.get("filter"),
        include_values=bool(_opt(body, "includeValues", "include_values", default=False)),
        include_metadata=bool(_opt(body, "includeMetadata", "include_metadata", default=False)),
        ef_search=_opt(body, "efSearch", "ef_search"),
    ))


class _Disconnected(Exception):
    pass


async def _read_body(receive) -> bytes:
    chunks = []
    while True:
        message = await receive()
        if message["type"] == "http.request":
            chunks.append(message.get("body", b""))
            if not message.get("more_body"):
                return b"".join(chunks)
        elif message["type"] == "http.disconnect":
            raise _Disconnected


async def _send_json(send, status: int, body: bytes) -> None:
    await send({"type": "http.response.start", "status": status,
                "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]})
    await send({"type": "http.response.body", "body": body})


def _parse(raw: bytes) -> dict:
    if not raw:
        return {}
    try:
        data = orjson.loads(raw)
    except orjson.JSONDecodeError:
        raise InvalidArgument("request body must be valid JSON") from None
    if not isinstance(data, dict):
        raise InvalidArgument("request body must be a JSON object")
    return data


def _opt(body: dict, *names: str, default=None):
    """First present key among camelCase / snake_case spellings."""
    for name in names:
        if body.get(name) is not None:
            return body[name]
    return default


def _rss_bytes() -> int | None:
    try:
        import psutil
        return psutil.Process().memory_info().rss
    except Exception:  # noqa: BLE001 — psutil is optional
        return None


def _cookie(headers: dict[bytes, bytes], name: str) -> str | None:
    raw = headers.get(b"cookie")
    if not raw:
        return None
    for part in raw.decode("latin-1").split(";"):
        key, _, value = part.strip().partition("=")
        if key == name and value:
            return value
    return None


class _Gate:
    """ASGI middleware: security headers, body cap, authentication, CSRF, metrics."""

    def __init__(self, app, *, store: KeyStore, lockout: Lockout, audit: AuditLog, auth_enabled: bool,
                 metrics: Metrics, max_body: int, trust_proxy: bool, registry=None):
        self.app, self.store, self.lockout, self.metrics, self.audit = app, store, lockout, metrics, audit
        self.auth_enabled, self.max_body, self.trust_proxy = auth_enabled, max_body, trust_proxy
        self.registry = registry

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        headers = dict(scope["headers"])
        path, method = scope["path"], scope["method"]
        https = scope.get("scheme") == "https" or (
            self.trust_proxy and headers.get(b"x-forwarded-proto", b"").split(b",")[0].strip() == b"https")
        client = scope.get("client")
        ip = client[0] if client else "unknown"
        if self.trust_proxy and headers.get(b"x-forwarded-for"):
            ip = headers[b"x-forwarded-for"].split(b",")[0].strip().decode("latin-1")
        state = scope.setdefault("state", {})
        state.update(https=https, client_ip=ip, principal=None, auth_via=None, session=None)
        send = self._secure(send, path, https)

        length = headers.get(b"content-length", b"")
        if length.isdigit() and int(length) > self.max_body:
            return await self._refuse(scope, receive, send, 413, "PAYLOAD_TOO_LARGE",
                                      f"request body exceeds {self.max_body // 2**20} MB")
        receive = self._capped(receive)

        if not self.auth_enabled:
            state.update(principal=LOCAL, auth_via="local")
        else:
            key = headers.get(b"api-key")
            if key is None and headers.get(b"authorization", b"")[:7].lower() == b"bearer ":
                key = headers[b"authorization"][7:]
            if key is not None:
                wait = self.lockout.retry_after(ip)
                if wait:
                    return await self._refuse(scope, receive, send, 429, "RESOURCE_EXHAUSTED",
                                              f"too many failed attempts; try again in {wait} s",
                                              {"Retry-After": str(wait)})
                principal = self.store.authenticate(key.decode("latin-1").strip())
                if principal is None:
                    blocked = self.lockout.failed(ip)
                    self.audit.record("auth.key_rejected", ip=ip, ok=False, detail={"path": path})
                    if blocked:
                        self.audit.record("auth.blocked", ip=ip, ok=False,
                                          detail={"blockSeconds": int(self.lockout.block_s)})
                    return await self._refuse(scope, receive, send, 401, "UNAUTHENTICATED", "invalid API key")
                self.lockout.succeeded(ip)
                state.update(principal=principal, auth_via="key")
            elif (token := _cookie(headers, SESSION_COOKIE)) and (verified := self.store.verify_session(token)):
                if method not in _SAFE_METHODS and not self._same_origin(headers, https):
                    return await self._refuse(scope, receive, send, 403, "PERMISSION_DENIED",
                                              "cross-site request refused")
                state.update(principal=verified[0], auth_via="session", session=verified[1])

        public = path in _PUBLIC or path.startswith(_PUBLIC_PREFIXES)
        if state["principal"] is None and not public:
            return await self._refuse(scope, receive, send, 401, "UNAUTHENTICATED",
                                      "sign in, or send an Api-Key header")

        if path == "/" or path.startswith(_UNTRACKED):
            return await self.app(scope, receive, send)
        started, status = perf_counter(), 500

        async def send_with_status(message):
            nonlocal status
            if message["type"] == "http.response.start":
                status = message["status"]
            await send(message)

        fast = _QUERY_PATH.match(path) if method == "POST" and self.registry is not None else None
        try:
            if fast:
                await self._query(fast.group(1), state, receive, send_with_status)
            else:
                await self.app(scope, receive, send_with_status)
        finally:
            route = "/indexes/{name}/query" if fast else getattr(scope.get("route"), "path", "unmatched")
            name = fast.group(1) if fast else (scope.get("path_params") or {}).get("name")
            self.metrics.observe(route, method, status, (perf_counter() - started) * 1000, name)

    async def _query(self, name: str, state: dict, receive, send) -> None:
        """Queries skip the framework's routing and dependency layers: the same access checks,
        errors, headers and metrics as the route, with parsing, search and serialization done in
        one worker-thread hop. This is the request NeedleDB serves most."""
        try:
            principal = state["principal"]
            if principal is None:
                raise Unauthenticated("sign in, or send an Api-Key header")
            if not principal.can_access(name):
                raise NotFound(f"index {name!r} not found")
            if not principal.allows("read"):
                raise PermissionDenied(f"this key has {principal.role} access; read access is required")
            index = self.registry.get(name)
            raw = await _read_body(receive)
            await _send_json(send, 200, await to_thread.run_sync(_query_response, index, raw))
        except _Disconnected:
            return
        except NeedleError as exc:
            await _send_json(send, exc.status, orjson.dumps({"error": {"code": exc.code, "message": exc.message}}))
        except Exception:  # noqa: BLE001 — same contract as the app's internal-error handler
            await _send_json(send, 500, orjson.dumps({"error": {"code": "INTERNAL", "message": "internal error"}}))

    @staticmethod
    async def _refuse(scope, receive, send, status, code, message, headers=None):
        await _error(status, code, message, headers)(scope, receive, send)

    def _capped(self, receive):
        seen = 0

        async def wrapped():
            nonlocal seen
            message = await receive()
            if message["type"] == "http.request":
                seen += len(message.get("body", b""))
                if seen > self.max_body:
                    raise PayloadTooLarge(f"request body exceeds {self.max_body // 2**20} MB")
            return message

        return wrapped

    def _same_origin(self, headers, https: bool) -> bool:
        origin = headers.get(b"origin")
        if origin is None:
            return headers.get(b"sec-fetch-site", b"same-origin") in (b"same-origin", b"none")
        host = headers.get(b"x-forwarded-host") if self.trust_proxy and headers.get(b"x-forwarded-host") \
            else headers.get(b"host", b"")
        return origin == (b"https://" if https else b"http://") + host

    @staticmethod
    def _secure(send, path: str, https: bool):
        async def wrapped(message):
            if message["type"] == "http.response.start":
                out = list(message.get("headers", []))
                present = {k.lower() for k, _ in out}

                def add(name: bytes, value: bytes):
                    if name not in present:
                        out.append((name, value))

                add(b"x-content-type-options", b"nosniff")
                add(b"referrer-policy", b"no-referrer")
                add(b"x-frame-options", b"DENY")
                add(b"cross-origin-opener-policy", b"same-origin")
                if path.startswith("/app"):
                    add(b"content-security-policy", _APP_CSP)
                elif not path.startswith(("/docs", "/openapi.json")):
                    add(b"content-security-policy", b"default-src 'none'; frame-ancestors 'none'")
                if not path.startswith("/app/assets/"):
                    add(b"cache-control", b"no-store")
                if https:
                    add(b"strict-transport-security", b"max-age=31536000; includeSubDomains")
                message["headers"] = out
            await send(message)

        return wrapped


def create_app(data_dir: str | Path | None = None, api_keys: list[str] | None = None,
               allow_no_auth: bool | None = None, trust_proxy: bool | None = None,
               max_body_mb: int | None = None) -> FastAPI:
    data_dir = Path(data_dir or os.environ.get("NEEDLEDB_DATA", "./data"))
    if api_keys is None:
        api_keys = [k.strip() for k in os.environ.get("NEEDLEDB_API_KEY", "").split(",") if k.strip()]
    if allow_no_auth is None:
        allow_no_auth = os.environ.get("NEEDLEDB_ALLOW_NO_AUTH") == "1"
    if trust_proxy is None:
        trust_proxy = os.environ.get("NEEDLEDB_TRUST_PROXY") == "1"
    if max_body_mb is None:
        max_body_mb = int(os.environ.get("NEEDLEDB_MAX_BODY_MB", "64"))
    auth_enabled = not allow_no_auth
    store = KeyStore(data_dir / "_system", api_keys)
    if auth_enabled and not api_keys and store.count_active() == 0:
        store.close()
        raise RuntimeError("no API key configured: set NEEDLEDB_API_KEY (or create one with "
                           "`needledb keys create`), or use --no-auth on localhost for development")

    audit = AuditLog(data_dir / "_system")
    provider_keys = ProviderKeys(data_dir / "_system")
    set_key_resolver(provider_keys.get)
    registry = Registry(data_dir)
    metrics = Metrics()
    lockout = Lockout()
    max_body = max_body_mb * 2**20
    run = to_thread.run_sync
    cpus = tune_threads()

    @asynccontextmanager
    async def lifespan(_app):
        # One worker thread per core the process may actually use: searches are CPU-bound,
        # so more runnable threads than cores only adds context switches and tail latency.
        to_thread.current_default_thread_limiter().total_tokens = max(4, cpus + 2)
        yield
        await run(registry.close)
        store.close()
        audit.close()

    app = FastAPI(title="NeedleDB", version=__version__, lifespan=lifespan, redoc_url=None)
    app.state.registry = registry
    app.state.metrics = metrics
    app.state.keys = store
    app.state.audit = audit
    app.state.provider_keys = provider_keys
    app.add_middleware(_Gate, store=store, lockout=lockout, audit=audit, auth_enabled=auth_enabled,
                       metrics=metrics, max_body=max_body, trust_proxy=trust_proxy, registry=registry)

    def record(request: Request, action: str, target: str | None = None, detail: dict | None = None) -> None:
        audit.record(action, actor=request.state.principal, ip=request.state.client_ip, target=target, detail=detail)

    # ---- errors ----------------------------------------------------------------------

    @app.exception_handler(NeedleError)
    async def _needle_error(_request, exc: NeedleError):
        return _error(exc.status, exc.code, exc.message)

    @app.exception_handler(RequestValidationError)
    async def _validation_error(_request, exc: RequestValidationError):
        first = exc.errors()[0] if exc.errors() else {}
        where = ".".join(str(p) for p in first.get("loc", ()) if p not in ("query", "body"))
        return _error(400, "INVALID_ARGUMENT", f"{where}: {first.get('msg', 'invalid request')}")

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(_request, exc: StarletteHTTPException):
        code = {401: "UNAUTHENTICATED", 404: "NOT_FOUND", 405: "METHOD_NOT_ALLOWED"}.get(
            exc.status_code, "INVALID_ARGUMENT" if exc.status_code < 500 else "INTERNAL")
        return _error(exc.status_code, code, str(exc.detail))

    @app.exception_handler(Exception)
    async def _internal_error(_request, _exc: Exception):
        return _error(500, "INTERNAL", "internal error")

    # ---- authorization helpers -------------------------------------------------------

    def need(request: Request, role: str, index: str | None = None) -> Principal:
        principal: Principal = request.state.principal
        if principal is None:
            raise Unauthenticated("sign in, or send an Api-Key header")
        if index is not None and not principal.can_access(index):
            raise NotFound(f"index {index!r} not found")        # other indexes look absent
        if not principal.allows(role):
            raise PermissionDenied(f"this key has {principal.role} access; {role} access is required")
        return principal

    def index_for(request: Request, name: str, role: str):
        need(request, role, name)
        return registry.get(name)

    def visible(request: Request):
        principal: Principal = request.state.principal
        return [i for i in registry.list() if principal.can_access(i.cfg.name)]

    def describe(index, request: Request) -> dict:
        out = index.summary()
        out["host"] = f"{str(request.base_url).rstrip('/')}/indexes/{index.cfg.name}"
        return out

    def me(request: Request, principal: Principal | None, expires: int | None = None) -> dict:
        out = {"authRequired": auth_enabled, "authenticated": principal is not None}
        if principal is None:
            return out
        session = request.state.session
        return {
            **out,
            "version": __version__,
            "principal": principal.to_dict(),
            "via": request.state.auth_via,
            "sessionExpiresAt": expires or (session or {}).get("exp"),
            "security": {
                "https": request.state.https,
                "secureCookies": request.state.https,
                "sessionHours": SESSION_TTL_S // 3600,
                "lockout": {"maxFailures": lockout.max_failures, "windowSeconds": int(lockout.window_s),
                            "blockSeconds": int(lockout.block_s)},
                "maxBodyBytes": max_body,
                "trustProxy": trust_proxy,
                "environmentKeys": store.environment_key_count,
                "managedKeys": store.count_active(),
            },
        }

    def session_cookie(response: Response, request: Request, token: str) -> None:
        response.set_cookie(SESSION_COOKIE, token, max_age=SESSION_TTL_S, httponly=True, samesite="strict",
                            secure=request.state.https, path="/")

    # ---- auth ------------------------------------------------------------------------

    @app.get("/health")
    async def health():
        return _json({"status": "ok"})

    @app.get("/auth/me")
    async def auth_me(request: Request):
        return _json(me(request, request.state.principal))

    @app.post("/auth/login")
    async def auth_login(request: Request):
        if not auth_enabled:
            return _json(me(request, LOCAL))
        body = _parse(await request.body())
        ip = request.state.client_ip
        wait = lockout.retry_after(ip)
        if wait:
            return _error(429, "RESOURCE_EXHAUSTED", f"too many failed attempts; try again in {wait} s",
                          {"Retry-After": str(wait)})
        key = body.get("apiKey", body.get("api_key"))
        principal = store.authenticate(key.strip()) if isinstance(key, str) else None
        if principal is None:
            blocked = lockout.failed(ip)
            audit.record("auth.sign_in_failed", ip=ip, ok=False)
            if blocked:
                audit.record("auth.blocked", ip=ip, ok=False, detail={"blockSeconds": int(lockout.block_s)})
            raise Unauthenticated("that API key isn't valid")
        lockout.succeeded(ip)
        audit.record("auth.signed_in", actor=principal, ip=ip)
        token, expires = store.issue_session(principal)
        request.state.auth_via = "session"
        response = _json(me(request, principal, expires))
        session_cookie(response, request, token)
        return response

    @app.post("/auth/logout")
    async def auth_logout(request: Request):
        if request.state.session:
            store.end_session(request.state.session)
            record(request, "auth.signed_out")
        response = _json({})
        response.delete_cookie(SESSION_COOKIE, path="/")
        return response

    @app.post("/auth/sessions/revoke-all")
    async def revoke_sessions(request: Request):
        need(request, "admin")
        store.rotate_secret()
        record(request, "auth.sessions_revoked")
        response = _json({})
        response.delete_cookie(SESSION_COOKIE, path="/")
        return response

    @app.get("/keys")
    async def list_keys(request: Request):
        need(request, "admin")
        return _json({"keys": store.list_keys()})

    @app.post("/keys")
    async def create_key(request: Request):
        need(request, "admin")
        body = _parse(await request.body())
        info, key = store.create_key(body.get("name"), body.get("role", "read"), body.get("indexes"),
                                     body.get("expiresInDays"))
        record(request, "key.created", info["name"], {"id": info["id"], "role": info["role"], "indexes": info["indexes"],
                                                      "expiresInDays": body.get("expiresInDays")})
        return _json({**info, "key": key}, 201)

    @app.delete("/keys/{key_id}")
    async def revoke_key(key_id: str, request: Request):
        need(request, "admin")
        name = next((k["name"] for k in store.list_keys() if k["id"] == key_id), key_id)
        store.revoke_key(key_id)
        record(request, "key.revoked", name, {"id": key_id})
        return _json({})

    @app.get("/events")
    async def events(request: Request, limit: int = 50, before: int | None = None):
        need(request, "admin")
        if not 1 <= limit <= 500:
            raise InvalidArgument("limit must be from 1 to 500")
        return _json({"events": await run(audit.recent, limit, before)})

    # ---- ops -------------------------------------------------------------------------

    @app.get("/stats")
    async def stats(request: Request):
        principal = need(request, "read")
        indexes = [describe(i, request) for i in visible(request)]
        live = metrics.live()
        if principal.indexes is not None:
            live["routes"] = {}
            live["indexes"] = {k: v for k, v in live["indexes"].items() if principal.can_access(k)}
        return _json({
            "version": __version__,
            "dataDir": str(data_dir.resolve()) if principal.allows("admin") else None,
            "authEnabled": auth_enabled,
            "totals": {
                "indexes": len(indexes),
                "vectors": sum(i["vectorCount"] for i in indexes),
                "memoryBytes": sum(i["memoryBytes"] for i in indexes),
                "storageBytes": sum(i["storageBytes"] for i in indexes),
            },
            "process": {"rssBytes": _rss_bytes(), "cpuCount": os.cpu_count(),
                        "threads": threading.active_count(), "pid": os.getpid()},
            "requests": live,
            "indexes": indexes,
        })

    @app.get("/metrics")
    async def prometheus(request: Request):
        principal = need(request, "read")
        if principal.indexes is not None:
            raise PermissionDenied("metrics cover every index; use a key without an index restriction")
        vectors, memory, storage = {}, {}, {}
        for index in registry.list():
            for ns, coll in list(index.collections.items()):
                vectors[(("index", index.cfg.name), ("namespace", ns))] = coll.live
            summary = index.summary()
            memory[(("index", index.cfg.name),)] = summary["memoryBytes"]
            storage[(("index", index.cfg.name),)] = summary["storageBytes"]
        text = metrics.prometheus({"needledb_vectors": vectors,
                                   "needledb_index_memory_bytes_estimate": memory,
                                   "needledb_index_storage_bytes": storage})
        return Response(text, media_type="text/plain; version=0.0.4")

    # ---- control plane ---------------------------------------------------------------

    @app.get("/embeddings/models")
    async def embedding_models(request: Request):
        need(request, "read")
        return _json(embed_catalog())

    # ---- settings: embedding provider keys --------------------------------------------

    def provider_row(provider) -> dict:
        return {"id": provider.id, "name": provider.name, "local": provider.local, "env": list(provider.env),
                "available": provider_available(provider), "source": key_source(provider),
                "saved": provider_keys.describe(provider.id)}

    def hosted_provider(provider_id: str):
        provider = EMBED_PROVIDERS.get(provider_id)
        if provider is None:
            raise NotFound(f"no embedding provider named {provider_id!r}")
        if provider.local:
            raise InvalidArgument("local models run on this server and don't use a key")
        return provider

    @app.get("/settings/providers")
    async def provider_settings(request: Request):
        need(request, "admin")
        return _json({"providers": [provider_row(p) for p in EMBED_PROVIDERS.values()]})

    @app.post("/settings/providers/{provider_id}")
    async def save_provider_key(provider_id: str, request: Request):
        principal = need(request, "admin")
        provider = hosted_provider(provider_id)
        key = _parse(await request.body()).get("apiKey")
        if not isinstance(key, str) or not key.strip() or len(key.strip()) > 1024 or any(c.isspace() for c in key.strip()):
            raise InvalidArgument("apiKey must be the provider's API key, with no spaces")
        if key_source(provider) == "environment":
            raise FailedPrecondition(f"{provider.name}'s key is set in the server's environment, which takes precedence; change it there")
        await run(provider_keys.set, provider.id, key.strip(), principal.name)
        record(request, "provider.key_set", provider.name, {"provider": provider.id, "hint": key.strip()[-4:]})
        return _json(provider_row(provider))

    @app.delete("/settings/providers/{provider_id}")
    async def remove_provider_key(provider_id: str, request: Request):
        need(request, "admin")
        provider = hosted_provider(provider_id)
        if await run(provider_keys.remove, provider.id):
            record(request, "provider.key_removed", provider.name, {"provider": provider.id})
        return _json(provider_row(provider))

    @app.post("/settings/providers/{provider_id}/test")
    async def test_provider_key(provider_id: str, request: Request):
        need(request, "admin")
        if provider_id not in EMBED_PROVIDERS:
            raise NotFound(f"no embedding provider named {provider_id!r}")
        key = _parse(await request.body()).get("apiKey")
        if key is not None and (not isinstance(key, str) or not key.strip()):
            raise InvalidArgument("apiKey must be a non-empty string when given")
        result = await run(lambda: check_provider(provider_id, key.strip() if key else None))
        return _json(result)

    @app.post("/playground/compare")
    async def playground_compare(request: Request):
        # Write access: comparing spends embedding-provider credits.
        need(request, "write")
        raw = await request.body()
        return Response(await run(lambda: orjson.dumps(embed_compare(_parse(raw)))), media_type="application/json")

    @app.get("/indexes")
    async def list_indexes(request: Request):
        need(request, "read")
        return _json({"indexes": [describe(i, request) for i in visible(request)]})

    @app.post("/indexes")
    async def create_index(request: Request):
        need(request, "admin")
        body = _parse(await request.body())
        try:
            cfg = IndexConfig.from_dict({
                "name": body.get("name"),
                "dimension": body.get("dimension"),
                "metric": body.get("metric"),
                "index_type": _opt(body, "index_type", "indexType"),
                "storage": body.get("storage"),
                "hnsw": body.get("hnsw"),
                "embed": body.get("embed"),
            })
        except TypeError as exc:
            raise InvalidArgument(f"invalid index configuration: {exc}") from None
        index = await run(registry.create_index, cfg)
        record(request, "index.created", cfg.name, {"dimension": cfg.dimension, "metric": cfg.metric,
                                                    **({"embed": f"{cfg.embed.provider}/{cfg.embed.model}"} if cfg.embed else {})})
        return _json(describe(index, request), 201)

    @app.get("/indexes/{name}")
    async def describe_index(name: str, request: Request):
        return _json(describe(index_for(request, name, "read"), request))

    @app.patch("/indexes/{name}")
    async def configure_index(name: str, request: Request):
        index = index_for(request, name, "admin")
        body = _parse(await request.body())
        hnsw = body.get("hnsw") or {}
        if not isinstance(hnsw, dict) or set(body) - {"hnsw", "ef_search", "efSearch", "embed"} \
                or set(hnsw) - {"ef_search", "efSearch"}:
            raise InvalidArgument("only hnsw.ef_search and embed can be changed on an existing index")
        ef = _opt(hnsw, "ef_search", "efSearch", default=_opt(body, "ef_search", "efSearch"))
        changes = {"embed": body["embed"]} if "embed" in body else {}
        await run(lambda: index.configure(ef, **changes))
        detail = {"ef_search": ef} if ef is not None else {}
        if "embed" in body:
            detail["embed"] = f"{index.cfg.embed.provider}/{index.cfg.embed.model}" if index.cfg.embed else None
        record(request, "index.configured", name, detail)
        return _json(describe(index, request))

    @app.delete("/indexes/{name}")
    async def delete_index(name: str, request: Request):
        need(request, "admin", name)
        await run(registry.delete_index, name)
        record(request, "index.deleted", name)
        return _json({}, 202)

    # ---- data plane ------------------------------------------------------------------

    @app.post("/indexes/{name}/vectors/upsert")
    async def upsert(name: str, request: Request):
        index = index_for(request, name, "write")
        raw = await request.body()

        def work():
            body = _parse(raw)
            return orjson.dumps({"upsertedCount": index.upsert(body.get("vectors"), body.get("namespace"))})

        return Response(await run(work), media_type="application/json")

    @app.post("/indexes/{name}/query")
    async def query(name: str, request: Request):
        # Normally answered by the gate's fast path; kept so the route exists in the OpenAPI schema.
        index = index_for(request, name, "read")
        raw = await request.body()
        return Response(await run(_query_response, index, raw), media_type="application/json")

    @app.get("/indexes/{name}/vectors/fetch")
    async def fetch_get(name: str, request: Request):
        index = index_for(request, name, "read")
        ids = request.query_params.getlist("ids")
        namespace = request.query_params.get("namespace")
        result = await run(lambda: orjson.dumps(index.fetch(ids, namespace)))
        return Response(result, media_type="application/json")

    @app.post("/indexes/{name}/vectors/fetch")
    async def fetch_post(name: str, request: Request):
        index = index_for(request, name, "read")
        raw = await request.body()

        def work():
            body = _parse(raw)
            return orjson.dumps(index.fetch(body.get("ids"), body.get("namespace"),
                                            include_values=bool(_opt(body, "includeValues", "include_values",
                                                                     default=True))))

        return Response(await run(work), media_type="application/json")

    @app.post("/indexes/{name}/vectors/update")
    async def update(name: str, request: Request):
        index = index_for(request, name, "write")
        raw = await request.body()

        def work():
            body = _parse(raw)
            index.update(body.get("id"), body.get("values"),
                         _opt(body, "setMetadata", "set_metadata"), body.get("namespace"))

        await run(work)
        return _json({})

    @app.post("/indexes/{name}/vectors/delete")
    async def delete(name: str, request: Request):
        index = index_for(request, name, "write")
        raw = await request.body()

        def work():
            body = _parse(raw)
            return index.delete(body.get("ids"), bool(_opt(body, "deleteAll", "delete_all", default=False)),
                                body.get("filter"), body.get("namespace"))

        return _json({"deletedCount": await run(work)})

    @app.get("/indexes/{name}/vectors/list")
    async def list_vectors(name: str, request: Request, prefix: str | None = None, limit: int = 100,
                           paginationToken: str | None = None, namespace: str | None = None):
        index = index_for(request, name, "read")
        return _json(await run(index.list_ids, prefix, limit, paginationToken, namespace))

    @app.get("/indexes/{name}/map")
    async def vector_map(name: str, request: Request, namespace: str | None = None, limit: int = 1500,
                         color_by: str | None = None):
        index = index_for(request, name, "read")
        result = await run(lambda: orjson.dumps(index.vector_map(namespace, limit, color_by or None)))
        return Response(result, media_type="application/json")

    @app.post("/indexes/{name}/describe_index_stats")
    async def describe_stats_post(name: str, request: Request):
        index = index_for(request, name, "read")
        body = _parse(await request.body())
        return _json(await run(index.describe_stats, body.get("filter")))

    @app.get("/indexes/{name}/describe_index_stats")
    async def describe_stats_get(name: str, request: Request):
        index = index_for(request, name, "read")
        return _json(await run(index.describe_stats))

    # ---- web app ---------------------------------------------------------------------

    @app.get("/", include_in_schema=False)
    async def root():
        return RedirectResponse("/app/")

    @app.get("/ui", include_in_schema=False)
    @app.get("/ui/{rest:path}", include_in_schema=False)
    async def legacy_ui(rest: str = ""):
        return RedirectResponse("/app/", status_code=308)

    if (STATIC_DIR / "index.html").exists():
        app.mount("/app", StaticFiles(directory=STATIC_DIR, html=True), name="app")
    else:
        @app.get("/app", include_in_schema=False)
        @app.get("/app/", include_in_schema=False)
        async def app_missing():
            return Response("<p>The web app is not built. Run <code>npm --prefix ui install "
                            "&amp;&amp; npm --prefix ui run build</code>, then restart.</p>",
                            media_type="text/html")

    return app
