"""The HTTP API: control plane, data plane, ops endpoints and the dashboard.

Handlers read the raw body on the event loop, then parse, run the engine and
serialize in a worker thread — FAISS releases the GIL while it searches, so
concurrent queries use every core and the loop never blocks on a large payload.
"""
from __future__ import annotations

import hmac
import os
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
from ..core.metrics import Metrics
from ..errors import InvalidArgument, NeedleError

STATIC_DIR = Path(__file__).parent / "static"
_PUBLIC = ("/health", "/ui", "/docs", "/openapi.json")
_UNTRACKED = ("/health", "/metrics", "/stats", "/ui", "/docs", "/openapi.json")


def _json(content, status: int = 200) -> Response:
    return Response(orjson.dumps(content), status_code=status, media_type="application/json")


def _error(status: int, code: str, message: str) -> Response:
    return _json({"error": {"code": code, "message": message}}, status)


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


class _Gate:
    """ASGI middleware: Api-Key auth, then per-route request metrics."""

    def __init__(self, app, keys: list[str], metrics: Metrics):
        self.app = app
        self.keys = [k.encode() for k in keys]
        self.metrics = metrics

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        path = scope["path"]
        if self.keys and path != "/" and not path.startswith(_PUBLIC):
            supplied = b""
            for name, value in scope["headers"]:
                if name == b"api-key":
                    supplied = value
                    break
                if name == b"authorization" and value[:7].lower() == b"bearer ":
                    supplied = value[7:]
            if not any(hmac.compare_digest(supplied, key) for key in self.keys):
                response = _error(401, "UNAUTHENTICATED", "missing or invalid Api-Key header")
                return await response(scope, receive, send)
        if path == "/" or path.startswith(_UNTRACKED):
            return await self.app(scope, receive, send)

        started, status = perf_counter(), 500

        async def send_with_status(message):
            nonlocal status
            if message["type"] == "http.response.start":
                status = message["status"]
            await send(message)

        try:
            await self.app(scope, receive, send_with_status)
        finally:
            route = scope.get("route")
            self.metrics.observe(getattr(route, "path", "unmatched"), scope["method"], status,
                                 (perf_counter() - started) * 1000,
                                 (scope.get("path_params") or {}).get("name"))


def create_app(data_dir: str | Path | None = None, api_keys: list[str] | None = None,
               allow_no_auth: bool | None = None) -> FastAPI:
    data_dir = Path(data_dir or os.environ.get("NEEDLEDB_DATA", "./data"))
    if api_keys is None:
        api_keys = [k.strip() for k in os.environ.get("NEEDLEDB_API_KEY", "").split(",") if k.strip()]
    if allow_no_auth is None:
        allow_no_auth = os.environ.get("NEEDLEDB_ALLOW_NO_AUTH") == "1"
    if not api_keys and not allow_no_auth:
        raise RuntimeError("no API key configured: set NEEDLEDB_API_KEY, or "
                           "NEEDLEDB_ALLOW_NO_AUTH=1 for local development")

    registry = Registry(data_dir)
    metrics = Metrics()
    run = to_thread.run_sync

    @asynccontextmanager
    async def lifespan(_app):
        yield
        await run(registry.close)

    app = FastAPI(title="NeedleDB", version=__version__, lifespan=lifespan, redoc_url=None)
    app.state.registry = registry
    app.state.metrics = metrics
    app.add_middleware(_Gate, keys=api_keys, metrics=metrics)

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

    def describe(index, request: Request) -> dict:
        out = index.summary()
        out["host"] = f"{str(request.base_url).rstrip('/')}/indexes/{index.cfg.name}"
        return out

    # ---- ops -------------------------------------------------------------------------

    @app.get("/health")
    async def health():
        return _json({"status": "ok", "version": __version__})

    @app.get("/stats")
    async def stats(request: Request):
        indexes = [describe(i, request) for i in registry.list()]
        return _json({
            "version": __version__,
            "dataDir": str(data_dir.resolve()),
            "authEnabled": bool(api_keys),
            "totals": {
                "indexes": len(indexes),
                "vectors": sum(i["vectorCount"] for i in indexes),
                "memoryBytes": sum(i["memoryBytes"] for i in indexes),
                "storageBytes": sum(i["storageBytes"] for i in indexes),
            },
            "process": {"rssBytes": _rss_bytes(), "cpuCount": os.cpu_count(),
                        "threads": threading.active_count(), "pid": os.getpid()},
            "requests": metrics.live(),
            "indexes": indexes,
        })

    @app.get("/metrics")
    async def prometheus():
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

    @app.get("/indexes")
    async def list_indexes(request: Request):
        return _json({"indexes": [describe(i, request) for i in registry.list()]})

    @app.post("/indexes")
    async def create_index(request: Request):
        body = _parse(await request.body())
        try:
            cfg = IndexConfig.from_dict({
                "name": body.get("name"),
                "dimension": body.get("dimension"),
                "metric": body.get("metric"),
                "index_type": _opt(body, "index_type", "indexType"),
                "hnsw": body.get("hnsw"),
            })
        except TypeError as exc:
            raise InvalidArgument(f"invalid index configuration: {exc}") from None
        index = await run(registry.create_index, cfg)
        return _json(describe(index, request), 201)

    @app.get("/indexes/{name}")
    async def describe_index(name: str, request: Request):
        return _json(describe(registry.get(name), request))

    @app.patch("/indexes/{name}")
    async def configure_index(name: str, request: Request):
        index = registry.get(name)
        body = _parse(await request.body())
        hnsw = body.get("hnsw") or {}
        if not isinstance(hnsw, dict) or set(body) - {"hnsw", "ef_search", "efSearch"} \
                or set(hnsw) - {"ef_search", "efSearch"}:
            raise InvalidArgument("only hnsw.ef_search can be changed on an existing index")
        ef = _opt(hnsw, "ef_search", "efSearch", default=_opt(body, "ef_search", "efSearch"))
        await run(index.configure, ef)
        return _json(describe(index, request))

    @app.delete("/indexes/{name}")
    async def delete_index(name: str):
        await run(registry.delete_index, name)
        return _json({}, 202)

    # ---- data plane ------------------------------------------------------------------

    @app.post("/indexes/{name}/vectors/upsert")
    async def upsert(name: str, request: Request):
        index, raw = registry.get(name), await request.body()

        def work():
            body = _parse(raw)
            return orjson.dumps({"upsertedCount": index.upsert(body.get("vectors"), body.get("namespace"))})

        return Response(await run(work), media_type="application/json")

    @app.post("/indexes/{name}/query")
    async def query(name: str, request: Request):
        index, raw = registry.get(name), await request.body()

        def work():
            body = _parse(raw)
            return orjson.dumps(index.query(
                vector=body.get("vector"),
                id=body.get("id"),
                top_k=_opt(body, "topK", "top_k", default=10),
                namespace=body.get("namespace"),
                filter=body.get("filter"),
                include_values=bool(_opt(body, "includeValues", "include_values", default=False)),
                include_metadata=bool(_opt(body, "includeMetadata", "include_metadata", default=False)),
                ef_search=_opt(body, "efSearch", "ef_search"),
            ))

        return Response(await run(work), media_type="application/json")

    @app.get("/indexes/{name}/vectors/fetch")
    async def fetch_get(name: str, request: Request):
        index = registry.get(name)
        ids = request.query_params.getlist("ids")
        namespace = request.query_params.get("namespace")
        result = await run(lambda: orjson.dumps(index.fetch(ids, namespace)))
        return Response(result, media_type="application/json")

    @app.post("/indexes/{name}/vectors/fetch")
    async def fetch_post(name: str, request: Request):
        index, raw = registry.get(name), await request.body()

        def work():
            body = _parse(raw)
            return orjson.dumps(index.fetch(body.get("ids"), body.get("namespace")))

        return Response(await run(work), media_type="application/json")

    @app.post("/indexes/{name}/vectors/update")
    async def update(name: str, request: Request):
        index, raw = registry.get(name), await request.body()

        def work():
            body = _parse(raw)
            index.update(body.get("id"), body.get("values"),
                         _opt(body, "setMetadata", "set_metadata"), body.get("namespace"))

        await run(work)
        return _json({})

    @app.post("/indexes/{name}/vectors/delete")
    async def delete(name: str, request: Request):
        index, raw = registry.get(name), await request.body()

        def work():
            body = _parse(raw)
            return index.delete(body.get("ids"), bool(_opt(body, "deleteAll", "delete_all", default=False)),
                                body.get("filter"), body.get("namespace"))

        return _json({"deletedCount": await run(work)})

    @app.get("/indexes/{name}/vectors/list")
    async def list_vectors(name: str, request: Request, prefix: str | None = None, limit: int = 100,
                           paginationToken: str | None = None, namespace: str | None = None):
        index = registry.get(name)
        return _json(await run(index.list_ids, prefix, limit, paginationToken, namespace))

    @app.post("/indexes/{name}/describe_index_stats")
    async def describe_stats_post(name: str, request: Request):
        index = registry.get(name)
        body = _parse(await request.body())
        return _json(await run(index.describe_stats, body.get("filter")))

    @app.get("/indexes/{name}/describe_index_stats")
    async def describe_stats_get(name: str):
        return _json(await run(registry.get(name).describe_stats))

    # ---- dashboard -------------------------------------------------------------------

    @app.get("/", include_in_schema=False)
    async def root():
        return RedirectResponse("/ui/")

    if (STATIC_DIR / "index.html").exists():
        app.mount("/ui", StaticFiles(directory=STATIC_DIR, html=True), name="ui")
    else:
        @app.get("/ui", include_in_schema=False)
        @app.get("/ui/", include_in_schema=False)
        async def ui_missing():
            return Response("<p>The dashboard is not built. Run <code>npm --prefix ui install "
                            "&amp;&amp; npm --prefix ui run build</code>, then restart.</p>",
                            media_type="text/html")

    return app
