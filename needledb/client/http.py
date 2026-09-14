"""NeedleDB — the client for a running NeedleDB server."""
from __future__ import annotations

import os
import time

import httpx
import orjson

from .. import __version__
from ..errors import BY_CODE, NeedleError
from .index import BaseIndex, Obj, wrap

_TRANSIENT = {502, 503, 504}


class NeedleDB:
    """
        db = NeedleDB("http://localhost:8080", api_key="...")
        db.create_index("products", dimension=1536)
        index = db.Index("products")
        index.upsert([("sku-1", embedding, {"brand": "acme"})])
        index.query(vector=embedding, top_k=10, filter={"brand": "acme"})

    `url` and `api_key` default to NEEDLEDB_URL and NEEDLEDB_API_KEY.
    """

    def __init__(self, url: str | None = None, api_key: str | None = None, *,
                 timeout: float = 30.0, retries: int = 3, client: httpx.Client | None = None):
        url = url or os.environ.get("NEEDLEDB_URL", "http://localhost:8080")
        api_key = api_key or os.environ.get("NEEDLEDB_API_KEY")
        self._http = client or httpx.Client(base_url=url, timeout=timeout,
                                            limits=httpx.Limits(max_keepalive_connections=32))
        self._http.headers["User-Agent"] = f"needledb-python/{__version__}"
        if api_key:
            self._http.headers["Api-Key"] = api_key
        self._retries = retries

    def request(self, method: str, path: str, body=None, params=None):
        content = orjson.dumps(body, option=orjson.OPT_SERIALIZE_NUMPY) if body is not None else None
        headers = {"Content-Type": "application/json"} if content is not None else None
        for attempt in range(self._retries + 1):
            try:
                resp = self._http.request(method, path, content=content, params=params, headers=headers)
            except httpx.TransportError:
                if attempt == self._retries:
                    raise
            else:
                if resp.status_code not in _TRANSIENT or attempt == self._retries:
                    break
            time.sleep(min(0.25 * 2 ** attempt, 4.0))
        if resp.status_code >= 400:
            try:
                err = orjson.loads(resp.content)["error"]
                raise BY_CODE.get(err["code"], NeedleError)(err["message"])
            except (orjson.JSONDecodeError, KeyError, TypeError):
                raise NeedleError(f"HTTP {resp.status_code}: {resp.text[:200]}") from None
        return orjson.loads(resp.content) if resp.content else {}

    # ---- control plane ---------------------------------------------------------------

    def create_index(self, name: str, dimension: int, metric: str = "cosine",
                     index_type: str = "auto", hnsw: dict | None = None) -> Obj:
        body = {"name": name, "dimension": dimension, "metric": metric, "index_type": index_type}
        if hnsw:
            body["hnsw"] = hnsw
        return wrap(self.request("POST", "/indexes", body))

    def list_indexes(self) -> list[Obj]:
        return wrap(self.request("GET", "/indexes")["indexes"])

    def describe_index(self, name: str) -> Obj:
        return wrap(self.request("GET", f"/indexes/{name}"))

    def has_index(self, name: str) -> bool:
        return any(i["name"] == name for i in self.request("GET", "/indexes")["indexes"])

    def configure_index(self, name: str, ef_search: int) -> Obj:
        return wrap(self.request("PATCH", f"/indexes/{name}", {"hnsw": {"ef_search": ef_search}}))

    def delete_index(self, name: str) -> None:
        self.request("DELETE", f"/indexes/{name}")

    def Index(self, name: str) -> "RemoteIndex":  # noqa: N802 — matches Pinecone's SDK
        return RemoteIndex(self, name)

    index = Index

    def health(self) -> Obj:
        return wrap(self.request("GET", "/health"))

    def stats(self) -> Obj:
        return wrap(self.request("GET", "/stats"))

    def close(self) -> None:
        self._http.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


class RemoteIndex(BaseIndex):
    default_batch_size = 500

    def __init__(self, db: NeedleDB, name: str):
        self._db = db
        self.name = name
        self._base = f"/indexes/{name}"

    def _upsert(self, vectors, namespace):
        body = {"vectors": vectors}
        if namespace:
            body["namespace"] = namespace
        return self._db.request("POST", f"{self._base}/vectors/upsert", body)["upsertedCount"]

    def _query(self, *, vector, id, top_k, namespace, filter, include_values, include_metadata, ef_search):
        body = {"topK": top_k, "includeValues": include_values, "includeMetadata": include_metadata}
        for key, value in (("vector", vector), ("id", id), ("namespace", namespace),
                           ("filter", filter), ("efSearch", ef_search)):
            if value is not None:
                body[key] = value
        return self._db.request("POST", f"{self._base}/query", body)

    def _fetch(self, ids, namespace):
        return self._db.request("POST", f"{self._base}/vectors/fetch", {"ids": ids, "namespace": namespace})

    def _update(self, id, values, set_metadata, namespace):
        body = {"id": id, "namespace": namespace}
        if values is not None:
            body["values"] = values
        if set_metadata is not None:
            body["setMetadata"] = set_metadata
        self._db.request("POST", f"{self._base}/vectors/update", body)

    def _delete(self, ids, delete_all, filter, namespace):
        body = {"namespace": namespace}
        if ids is not None:
            body["ids"] = ids
        if delete_all:
            body["deleteAll"] = True
        if filter is not None:
            body["filter"] = filter
        return self._db.request("POST", f"{self._base}/vectors/delete", body).get("deletedCount", 0)

    def _list(self, prefix, limit, pagination_token, namespace):
        params = {"limit": limit}
        for key, value in (("prefix", prefix), ("paginationToken", pagination_token),
                           ("namespace", namespace)):
            if value is not None:
                params[key] = value
        return self._db.request("GET", f"{self._base}/vectors/list", params=params)

    def _stats(self, filter):
        return self._db.request("POST", f"{self._base}/describe_index_stats",
                                {"filter": filter} if filter else {})
