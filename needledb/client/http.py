"""NeedleDB — the client for a running NeedleDB server."""
from __future__ import annotations

import os
import time

import httpx

from .. import __version__
from ..errors import AlreadyExists
from .common import (KEEP, TRANSIENT, backoff, check_existing, configure_body, decode, delete_body, encode,
                     index_body, key_body, list_params, query_body, update_body, upsert_body)
from .index import BaseIndex, Obj, wrap


def settings(url: str | None, api_key: str | None) -> tuple[str, dict]:
    url = url or os.environ.get("NEEDLEDB_URL", "http://localhost:8080")
    api_key = api_key or os.environ.get("NEEDLEDB_API_KEY")
    headers = {"User-Agent": f"needledb-python/{__version__}"}
    if api_key:
        headers["Api-Key"] = api_key
    return url, headers


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
                 timeout: float = 30.0, retries: int = 3, client: httpx.Client | None = None,
                 binary_vectors: bool = True):
        url, headers = settings(url, api_key)
        self._http = client or httpx.Client(base_url=url, timeout=timeout,
                                            limits=httpx.Limits(max_keepalive_connections=32))
        self._http.headers.update(headers)
        self._retries = retries
        # Base64 float32 needs NeedleDB 0.2+; pass binary_vectors=False for older servers.
        self.binary_vectors = binary_vectors

    def request(self, method: str, path: str, body=None, params=None):
        content = encode(body)
        headers = {"Content-Type": "application/json"} if content is not None else None
        for attempt in range(self._retries + 1):
            try:
                resp = self._http.request(method, path, content=content, params=params, headers=headers)
            except httpx.TransportError:
                if attempt == self._retries:
                    raise
            else:
                if resp.status_code not in TRANSIENT or attempt == self._retries:
                    break
            time.sleep(backoff(attempt))
        return decode(resp.status_code, resp.content, resp.text)

    # ---- indexes -----------------------------------------------------------------------

    def create_index(self, name: str, dimension: int | None = None, metric: str = "cosine",
                     index_type: str = "auto", hnsw: dict | None = None, embed: dict | None = None,
                     storage: str = "auto", *, exist_ok: bool = False) -> Obj:
        """Create an index. With `embed={"provider": ..., "model": ...}` the server embeds text
        for you, and `dimension` defaults to the model's. With `exist_ok`, an existing index of the
        same dimension and metric is returned instead of raising `AlreadyExists`."""
        try:
            return wrap(self.request("POST", "/indexes", index_body(name, dimension, metric, index_type, hnsw, embed, storage)))
        except AlreadyExists:
            if not exist_ok:
                raise
        info = self.describe_index(name)
        check_existing(info, dimension, metric)
        return info

    def list_indexes(self) -> list[Obj]:
        return wrap(self.request("GET", "/indexes")["indexes"])

    def describe_index(self, name: str) -> Obj:
        return wrap(self.request("GET", f"/indexes/{name}"))

    def has_index(self, name: str) -> bool:
        return any(i["name"] == name for i in self.request("GET", "/indexes")["indexes"])

    def configure_index(self, name: str, ef_search: int | None = None, *, embed=KEEP) -> Obj:
        """Change the search width, or connect an embedding model to an existing index with
        `embed={"provider": ..., "model": ..., "field": ...}` (`embed=None` disconnects it)."""
        return wrap(self.request("PATCH", f"/indexes/{name}", configure_body(ef_search, embed)))

    def delete_index(self, name: str) -> None:
        self.request("DELETE", f"/indexes/{name}")

    def Index(self, name: str) -> RemoteIndex:  # noqa: N802 — matches Pinecone's SDK
        return RemoteIndex(self, name)

    index = Index

    # ---- API keys (admin) --------------------------------------------------------------

    def create_key(self, name: str, role: str = "read", indexes: list[str] | None = None,
                   expires_in_days: int | None = None) -> Obj:
        """Create a key. The returned `key` is the only time the secret is available."""
        return wrap(self.request("POST", "/keys", key_body(name, role, indexes, expires_in_days)))

    def list_keys(self) -> list[Obj]:
        return wrap(self.request("GET", "/keys")["keys"])

    def revoke_key(self, key_id: str) -> None:
        self.request("DELETE", f"/keys/{key_id}")

    # ---- server ------------------------------------------------------------------------

    def list_embedding_models(self) -> Obj:
        """Embedding providers and models this server supports, and which have keys set."""
        return wrap(self.request("GET", "/embeddings/models"))

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

    def __repr__(self) -> str:
        return f"<NeedleDB {self._http.base_url}>"


class RemoteIndex(BaseIndex):
    default_batch_size = 500

    def __init__(self, db: NeedleDB, name: str):
        self._db = db
        self.name = name
        self._base = f"/indexes/{name}"

    def _upsert(self, vectors, namespace):
        body = upsert_body(vectors, namespace, self._db.binary_vectors)
        return self._db.request("POST", f"{self._base}/vectors/upsert", body)["upsertedCount"]

    def _query(self, **kwargs):
        return self._db.request("POST", f"{self._base}/query", query_body(self._db.binary_vectors, **kwargs))

    def _fetch(self, ids, namespace):
        return self._db.request("POST", f"{self._base}/vectors/fetch", {"ids": ids, "namespace": namespace})

    def _update(self, id, values, set_metadata, namespace):
        body = update_body(self._db.binary_vectors, id, values, set_metadata, namespace)
        self._db.request("POST", f"{self._base}/vectors/update", body)

    def _delete(self, ids, delete_all, filter, namespace):
        body = delete_body(ids, delete_all, filter, namespace)
        return self._db.request("POST", f"{self._base}/vectors/delete", body).get("deletedCount", 0)

    def _list(self, prefix, limit, pagination_token, namespace):
        params = list_params(prefix, limit, pagination_token, namespace)
        return self._db.request("GET", f"{self._base}/vectors/list", params=params)

    def _stats(self, filter):
        return self._db.request("POST", f"{self._base}/describe_index_stats", {"filter": filter} if filter else {})

    def _describe(self):
        return self._db.request("GET", self._base)
