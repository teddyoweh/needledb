"""NeedleDB — the client for a running NeedleDB server."""
from __future__ import annotations

import base64
import os
import time

import httpx
import numpy as np
import orjson

from .. import __version__
from ..errors import BY_CODE, NeedleError
from .index import BaseIndex, Obj, wrap

_TRANSIENT = {502, 503, 504}


def _pack(values) -> str:
    """A vector as base64 little-endian float32: a quarter of the JSON size, and no float parsing."""
    return base64.b64encode(np.asarray(values, dtype="<f4").tobytes()).decode("ascii")
_KEEP = object()


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
        url = url or os.environ.get("NEEDLEDB_URL", "http://localhost:8080")
        api_key = api_key or os.environ.get("NEEDLEDB_API_KEY")
        self._http = client or httpx.Client(base_url=url, timeout=timeout,
                                            limits=httpx.Limits(max_keepalive_connections=32))
        self._http.headers["User-Agent"] = f"needledb-python/{__version__}"
        if api_key:
            self._http.headers["Api-Key"] = api_key
        self._retries = retries
        # Base64 float32 needs NeedleDB 0.2+; pass binary_vectors=False for older servers.
        self.binary_vectors = binary_vectors

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

    def create_index(self, name: str, dimension: int | None = None, metric: str = "cosine",
                     index_type: str = "auto", hnsw: dict | None = None, embed: dict | None = None) -> Obj:
        """Create an index. With `embed={"provider": ..., "model": ...}` the server embeds text
        for you, and `dimension` defaults to the model's."""
        body: dict = {"name": name, "metric": metric, "index_type": index_type}
        if dimension is not None:
            body["dimension"] = dimension
        if hnsw:
            body["hnsw"] = hnsw
        if embed:
            body["embed"] = embed
        return wrap(self.request("POST", "/indexes", body))

    def list_indexes(self) -> list[Obj]:
        return wrap(self.request("GET", "/indexes")["indexes"])

    def describe_index(self, name: str) -> Obj:
        return wrap(self.request("GET", f"/indexes/{name}"))

    def has_index(self, name: str) -> bool:
        return any(i["name"] == name for i in self.request("GET", "/indexes")["indexes"])

    def configure_index(self, name: str, ef_search: int | None = None, *, embed=_KEEP) -> Obj:
        """Change the search width, or connect an embedding model to an existing index with
        `embed={"provider": ..., "model": ..., "field": ...}` (`embed=None` disconnects it)."""
        body: dict = {}
        if ef_search is not None:
            body["hnsw"] = {"ef_search": ef_search}
        if embed is not _KEEP:
            body["embed"] = embed
        if not body:
            raise ValueError("pass ef_search, embed, or both")
        return wrap(self.request("PATCH", f"/indexes/{name}", body))

    def delete_index(self, name: str) -> None:
        self.request("DELETE", f"/indexes/{name}")

    def Index(self, name: str) -> "RemoteIndex":  # noqa: N802 — matches Pinecone's SDK
        return RemoteIndex(self, name)

    index = Index

    # ---- API keys (admin) ------------------------------------------------------------

    def create_key(self, name: str, role: str = "read", indexes: list[str] | None = None,
                   expires_in_days: int | None = None) -> Obj:
        """Create a key. The returned `key` is the only time the secret is available."""
        body = {"name": name, "role": role}
        if indexes is not None:
            body["indexes"] = indexes
        if expires_in_days is not None:
            body["expiresInDays"] = expires_in_days
        return wrap(self.request("POST", "/keys", body))

    def list_keys(self) -> list[Obj]:
        return wrap(self.request("GET", "/keys")["keys"])

    def revoke_key(self, key_id: str) -> None:
        self.request("DELETE", f"/keys/{key_id}")

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


class RemoteIndex(BaseIndex):
    default_batch_size = 500

    def __init__(self, db: NeedleDB, name: str):
        self._db = db
        self.name = name
        self._base = f"/indexes/{name}"

    def _upsert(self, vectors, namespace):
        if self._db.binary_vectors:
            vectors = [self._packed(v) for v in vectors]
        body = {"vectors": vectors}
        if namespace:
            body["namespace"] = namespace
        return self._db.request("POST", f"{self._base}/vectors/upsert", body)["upsertedCount"]

    def _packed(self, record):
        if isinstance(record, dict):
            if record.get("values") is None:
                return record
            return {**record, "values": _pack(record["values"])}
        if isinstance(record, (tuple, list)) and len(record) in (2, 3):
            packed = {"id": record[0], "values": _pack(record[1])}
            if len(record) == 3 and record[2] is not None:
                packed["metadata"] = record[2]
            return packed
        return record

    def _query(self, *, vector, id, text, top_k, namespace, filter, include_values, include_metadata, ef_search):
        if vector is not None and self._db.binary_vectors:
            vector = _pack(vector)
        body = {"topK": top_k, "includeValues": include_values, "includeMetadata": include_metadata}
        for key, value in (("vector", vector), ("id", id), ("text", text), ("namespace", namespace),
                           ("filter", filter), ("efSearch", ef_search)):
            if value is not None:
                body[key] = value
        return self._db.request("POST", f"{self._base}/query", body)

    def _fetch(self, ids, namespace):
        return self._db.request("POST", f"{self._base}/vectors/fetch", {"ids": ids, "namespace": namespace})

    def _update(self, id, values, set_metadata, namespace):
        body = {"id": id, "namespace": namespace}
        if values is not None:
            body["values"] = _pack(values) if self._db.binary_vectors else values
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
