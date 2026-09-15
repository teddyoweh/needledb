"""The Index surface both clients share, and the result type they return."""
from __future__ import annotations

import re
from typing import Any, Iterable, Iterator

import numpy as np

_CAMEL = re.compile(r"_([a-z])")


class Obj(dict):
    """A dict whose keys also read as attributes, in either spelling:
    `res.matches[0].id`, `stats.total_vector_count` (== stats["totalVectorCount"])."""

    __slots__ = ()

    def __getattr__(self, name: str) -> Any:
        if name in self:
            return self[name]
        camel = _CAMEL.sub(lambda m: m.group(1).upper(), name)
        if camel in self:
            return self[camel]
        raise AttributeError(name)


def wrap(value: Any) -> Any:
    if isinstance(value, dict):
        return Obj({k: (v if k == "values" else wrap(v)) for k, v in value.items()})
    if isinstance(value, list):
        return [wrap(v) for v in value]
    return value


class BaseIndex:
    """Methods mirror Pinecone's Python SDK; results are `Obj`s."""

    name: str
    default_batch_size = 1000

    # Implemented by the remote and local clients.
    def _upsert(self, vectors: list, namespace: str | None) -> int: ...
    def _query(self, **kwargs) -> dict: ...
    def _fetch(self, ids: list[str], namespace: str | None) -> dict: ...
    def _update(self, id: str, values, set_metadata, namespace) -> None: ...
    def _delete(self, ids, delete_all, filter, namespace) -> int: ...
    def _list(self, prefix, limit, pagination_token, namespace) -> dict: ...
    def _stats(self, filter) -> dict: ...

    def upsert(self, vectors: Iterable, namespace: str | None = None,
               batch_size: int | None = None) -> Obj:
        """Insert or overwrite vectors: dicts `{id, values, metadata?}` or tuples
        `(id, values[, metadata])`. On an index with an embedding model, a dict can carry
        `text` instead of `values`. Large inputs are sent in batches."""
        vectors = vectors if isinstance(vectors, list) else list(vectors)
        size = batch_size or self.default_batch_size
        total = 0
        for start in range(0, len(vectors), size):
            total += self._upsert(vectors[start:start + size], namespace)
        return Obj(upsertedCount=total)

    def upsert_arrays(self, ids: list[str], values, metadata: list[dict | None] | None = None,
                      namespace: str | None = None, batch_size: int | None = None) -> Obj:
        """Upsert from an (n x d) array — the fast path for bulk loads."""
        values = np.asarray(values, dtype=np.float32)
        if values.ndim != 2 or len(values) != len(ids):
            raise ValueError("values must be an (n x d) array with one row per id")
        if metadata is not None and len(metadata) != len(ids):
            raise ValueError("metadata must have one entry per id")
        records = []
        for i, rid in enumerate(ids):
            rec = {"id": rid, "values": values[i]}
            if metadata is not None and metadata[i]:
                rec["metadata"] = metadata[i]
            records.append(rec)
        return self.upsert(records, namespace, batch_size)

    def query(self, vector=None, *, id: str | None = None, text: str | None = None, top_k: int = 10,
              namespace: str | None = None, filter: dict | None = None,
              include_values: bool = False, include_metadata: bool = False,
              ef_search: int | None = None) -> Obj:
        """Nearest neighbours of a vector, a stored record (`id`), or `text` on an index
        with an embedding model."""
        return wrap(self._query(vector=vector, id=id, text=text, top_k=top_k, namespace=namespace,
                                filter=filter, include_values=include_values,
                                include_metadata=include_metadata, ef_search=ef_search))

    def search(self, text: str, top_k: int = 10, *, namespace: str | None = None,
               filter: dict | None = None, include_metadata: bool = True) -> Obj:
        """Search by meaning: `index.search("waterproof hiking boots")`."""
        return self.query(text=text, top_k=top_k, namespace=namespace, filter=filter,
                          include_metadata=include_metadata)

    def fetch(self, ids: list[str], namespace: str | None = None) -> Obj:
        return wrap(self._fetch(list(ids), namespace))

    def update(self, id: str, values=None, set_metadata: dict | None = None,
               namespace: str | None = None) -> Obj:
        self._update(id, values, set_metadata, namespace)
        return Obj()

    def delete(self, ids: list[str] | None = None, delete_all: bool = False,
               filter: dict | None = None, namespace: str | None = None) -> Obj:
        return Obj(deletedCount=self._delete(list(ids) if ids is not None else None,
                                             delete_all, filter, namespace))

    def list_paginated(self, prefix: str | None = None, limit: int = 100,
                       pagination_token: str | None = None, namespace: str | None = None) -> Obj:
        return wrap(self._list(prefix, limit, pagination_token, namespace))

    def list(self, prefix: str | None = None, limit: int = 100,
             namespace: str | None = None) -> Iterator[list[str]]:
        """Yield pages of ids, like Pinecone's `index.list()`."""
        token = None
        while True:
            page = self._list(prefix, limit, token, namespace)
            ids = [v["id"] for v in page["vectors"]]
            if ids:
                yield ids
            token = page.get("pagination", {}).get("next")
            if not token:
                return

    def describe_index_stats(self, filter: dict | None = None) -> Obj:
        return wrap(self._stats(filter))

    def __repr__(self) -> str:
        return f"<{type(self).__name__} {self.name!r}>"
