"""AsyncNeedleDB — the server client for asyncio code, with the same methods as NeedleDB."""
from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Iterable, Mapping

import httpx

from ..errors import AlreadyExists
from .common import (KEEP, TEXT_BATCH, TRANSIENT, array_records, backoff, batches, check_existing,
                     configure_body, count_in, decode, delete_body, encode, index_body, key_body,
                     list_params, query_body, scan_size, scanned, search_args, text_records, update_body,
                     upsert_body)
from .http import settings
from .index import Obj, wrap


class AsyncNeedleDB:
    """
        async with AsyncNeedleDB("http://localhost:8080", api_key="...") as db:
            index = db.Index("products")
            res = await index.search("waterproof hiking boots", top_k=5)

    Every method of `NeedleDB` and its indexes, awaited. `url` and `api_key` default to
    NEEDLEDB_URL and NEEDLEDB_API_KEY.
    """

    def __init__(self, url: str | None = None, api_key: str | None = None, *,
                 timeout: float = 30.0, retries: int = 3, client: httpx.AsyncClient | None = None,
                 binary_vectors: bool = True):
        url, headers = settings(url, api_key)
        self._http = client or httpx.AsyncClient(base_url=url, timeout=timeout,
                                                 limits=httpx.Limits(max_keepalive_connections=32))
        self._http.headers.update(headers)
        self._retries = retries
        self.binary_vectors = binary_vectors

    async def request(self, method: str, path: str, body=None, params=None):
        content = encode(body)
        headers = {"Content-Type": "application/json"} if content is not None else None
        for attempt in range(self._retries + 1):
            try:
                resp = await self._http.request(method, path, content=content, params=params, headers=headers)
            except httpx.TransportError:
                if attempt == self._retries:
                    raise
            else:
                if resp.status_code not in TRANSIENT or attempt == self._retries:
                    break
            await asyncio.sleep(backoff(attempt))
        return decode(resp.status_code, resp.content, resp.text)

    # ---- indexes -----------------------------------------------------------------------

    async def create_index(self, name: str, dimension: int | None = None, metric: str = "cosine",
                           index_type: str = "auto", hnsw: dict | None = None, embed: dict | None = None,
                           *, exist_ok: bool = False) -> Obj:
        try:
            return wrap(await self.request("POST", "/indexes", index_body(name, dimension, metric, index_type, hnsw, embed)))
        except AlreadyExists:
            if not exist_ok:
                raise
        info = await self.describe_index(name)
        check_existing(info, dimension, metric)
        return info

    async def list_indexes(self) -> list[Obj]:
        return wrap((await self.request("GET", "/indexes"))["indexes"])

    async def describe_index(self, name: str) -> Obj:
        return wrap(await self.request("GET", f"/indexes/{name}"))

    async def has_index(self, name: str) -> bool:
        return any(i["name"] == name for i in (await self.request("GET", "/indexes"))["indexes"])

    async def configure_index(self, name: str, ef_search: int | None = None, *, embed=KEEP) -> Obj:
        return wrap(await self.request("PATCH", f"/indexes/{name}", configure_body(ef_search, embed)))

    async def delete_index(self, name: str) -> None:
        await self.request("DELETE", f"/indexes/{name}")

    def Index(self, name: str) -> AsyncIndex:  # noqa: N802 — matches Pinecone's SDK
        return AsyncIndex(self, name)

    index = Index

    # ---- API keys (admin) --------------------------------------------------------------

    async def create_key(self, name: str, role: str = "read", indexes: list[str] | None = None,
                         expires_in_days: int | None = None) -> Obj:
        return wrap(await self.request("POST", "/keys", key_body(name, role, indexes, expires_in_days)))

    async def list_keys(self) -> list[Obj]:
        return wrap((await self.request("GET", "/keys"))["keys"])

    async def revoke_key(self, key_id: str) -> None:
        await self.request("DELETE", f"/keys/{key_id}")

    # ---- server ------------------------------------------------------------------------

    async def list_embedding_models(self) -> Obj:
        return wrap(await self.request("GET", "/embeddings/models"))

    async def health(self) -> Obj:
        return wrap(await self.request("GET", "/health"))

    async def stats(self) -> Obj:
        return wrap(await self.request("GET", "/stats"))

    async def close(self) -> None:
        await self._http.aclose()

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        await self.close()

    def __repr__(self) -> str:
        return f"<AsyncNeedleDB {self._http.base_url}>"


class AsyncIndex:
    """The Index methods, awaited. Batched upserts can send several batches at once."""

    default_batch_size = 500

    def __init__(self, db: AsyncNeedleDB, name: str):
        self._db = db
        self.name = name
        self._base = f"/indexes/{name}"

    async def _post(self, path: str, body: dict):
        return await self._db.request("POST", f"{self._base}{path}", body)

    # ---- write -------------------------------------------------------------------------

    async def upsert(self, vectors: Iterable, namespace: str | None = None, batch_size: int | None = None,
                     max_concurrency: int = 1) -> Obj:
        """Insert or overwrite vectors, in batches. With `max_concurrency` above 1, batches are sent
        in parallel and may land in any order, so don't repeat an id across the input."""
        vectors = vectors if isinstance(vectors, list) else list(vectors)
        gate = asyncio.Semaphore(max(1, max_concurrency))

        async def send(chunk):
            async with gate:
                body = upsert_body(chunk, namespace, self._db.binary_vectors)
                return (await self._post("/vectors/upsert", body))["upsertedCount"]

        chunks = list(batches(vectors, batch_size or self.default_batch_size))
        if max_concurrency <= 1:
            total = 0
            for chunk in chunks:
                total += await send(chunk)
        else:
            total = sum(await asyncio.gather(*(send(c) for c in chunks)))
        return Obj(upsertedCount=total)

    async def upsert_texts(self, texts: str | Iterable[str], ids: Iterable[str] | None = None,
                           metadata: Mapping | Iterable[Mapping | None] | None = None,
                           namespace: str | None = None, batch_size: int | None = None,
                           max_concurrency: int = 1) -> Obj:
        records = text_records(texts, ids, metadata)
        await self.upsert(records, namespace, batch_size or TEXT_BATCH, max_concurrency)
        return Obj(upsertedCount=len(records), ids=[r["id"] for r in records])

    async def upsert_arrays(self, ids: list[str], values, metadata: list[dict | None] | None = None,
                            namespace: str | None = None, batch_size: int | None = None,
                            max_concurrency: int = 1) -> Obj:
        return await self.upsert(array_records(ids, values, metadata), namespace, batch_size, max_concurrency)

    # ---- search ------------------------------------------------------------------------

    async def query(self, vector=None, *, id: str | None = None, text: str | None = None, top_k: int = 10,
                    namespace: str | None = None, filter: dict | None = None,
                    include_values: bool = False, include_metadata: bool = False,
                    ef_search: int | None = None) -> Obj:
        body = query_body(self._db.binary_vectors, vector=vector, id=id, text=text, top_k=top_k,
                          namespace=namespace, filter=filter, include_values=include_values,
                          include_metadata=include_metadata, ef_search=ef_search)
        return wrap(await self._post("/query", body))

    async def search(self, query=None, top_k: int = 10, *, text: str | None = None,
                     namespace: str | None = None, filter: dict | None = None,
                     include_metadata: bool = True, include_values: bool = False,
                     ef_search: int | None = None) -> Obj:
        args = search_args(query, text)
        return await self.query(top_k=top_k, namespace=namespace, filter=filter, include_metadata=include_metadata,
                                include_values=include_values, ef_search=ef_search, **args)

    # ---- read --------------------------------------------------------------------------

    async def fetch(self, ids: list[str], namespace: str | None = None) -> Obj:
        return wrap(await self._post("/vectors/fetch", {"ids": list(ids), "namespace": namespace}))

    async def get(self, id: str, namespace: str | None = None) -> Obj | None:
        found = await self._post("/vectors/fetch", {"ids": [id], "namespace": namespace})
        return wrap(found["vectors"].get(id))

    async def list_paginated(self, prefix: str | None = None, limit: int = 100,
                             pagination_token: str | None = None, namespace: str | None = None) -> Obj:
        params = list_params(prefix, limit, pagination_token, namespace)
        return wrap(await self._db.request("GET", f"{self._base}/vectors/list", params=params))

    async def list(self, prefix: str | None = None, limit: int = 100,
                   namespace: str | None = None) -> AsyncIterator[list[str]]:
        """`async for ids in index.list(prefix="doc-")`: pages of ids."""
        token = None
        while True:
            page = await self._db.request("GET", f"{self._base}/vectors/list",
                                          params=list_params(prefix, limit, token, namespace))
            ids = [v["id"] for v in page["vectors"]]
            if ids:
                yield ids
            token = page.get("pagination", {}).get("next")
            if not token:
                return

    async def scan(self, prefix: str | None = None, namespace: str | None = None,
                   batch_size: int = 100, include_values: bool = False) -> AsyncIterator[Obj]:
        async for ids in self.list(prefix=prefix, limit=scan_size(batch_size), namespace=namespace):
            found = await self._post("/vectors/fetch", {"ids": ids, "namespace": namespace})
            for record in scanned(ids, found["vectors"], include_values):
                yield wrap(record)

    # ---- change ------------------------------------------------------------------------

    async def update(self, id: str, values=None, set_metadata: dict | None = None,
                     namespace: str | None = None) -> Obj:
        await self._post("/vectors/update", update_body(self._db.binary_vectors, id, values, set_metadata, namespace))
        return Obj()

    async def delete(self, ids: list[str] | None = None, delete_all: bool = False,
                     filter: dict | None = None, namespace: str | None = None) -> Obj:
        res = await self._post("/vectors/delete", delete_body(ids, delete_all, filter, namespace))
        return Obj(deletedCount=res.get("deletedCount", 0))

    # ---- inspect -----------------------------------------------------------------------

    async def describe_index_stats(self, filter: dict | None = None) -> Obj:
        return wrap(await self._post("/describe_index_stats", {"filter": filter} if filter else {}))

    async def count(self, namespace: str | None = None, filter: dict | None = None) -> int:
        return count_in(await self._post("/describe_index_stats", {"filter": filter} if filter else {}), namespace)

    async def describe(self) -> Obj:
        return wrap(await self._db.request("GET", self._base))

    def __repr__(self) -> str:
        return f"<AsyncIndex {self.name!r}>"
