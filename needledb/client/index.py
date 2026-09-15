"""The Index surface the sync clients share, and the result type every client returns."""
from __future__ import annotations

import re
from collections.abc import Iterable, Iterator, Mapping
from typing import Any

from .common import (TEXT_BATCH, array_records, batches, count_in, scan_size, scanned, search_args,
                     text_records)

_CAMEL = re.compile(r"_([a-z])")


class _Key:
    """An attribute that reads a key when the dict has it, and the dict method otherwise,
    so `record.values` is the vector while `obj.values()` still works."""

    def __init__(self, key: str, method):
        self.key = key
        self.method = method

    def __get__(self, obj, owner=None):
        if obj is not None and self.key in obj:
            return obj[self.key]
        return self.method.__get__(obj, owner)


class Obj(dict):
    """A dict whose keys also read as attributes, in either spelling:
    `res.matches[0].id`, `stats.total_vector_count` (== stats["totalVectorCount"])."""

    __slots__ = ()
    values = _Key("values", dict.values)

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
    """Methods mirror Pinecone's Python SDK, plus text and convenience helpers; results are `Obj`s."""

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
    def _describe(self) -> dict: ...

    # ---- write -------------------------------------------------------------------------

    def upsert(self, vectors: Iterable, namespace: str | None = None,
               batch_size: int | None = None) -> Obj:
        """Insert or overwrite vectors: dicts `{id, values, metadata?}` or tuples
        `(id, values[, metadata])`. On an index with an embedding model, a dict can carry
        `text` instead of `values`. Large inputs are sent in batches."""
        vectors = vectors if isinstance(vectors, list) else list(vectors)
        total = sum(self._upsert(chunk, namespace) for chunk in batches(vectors, batch_size or self.default_batch_size))
        return Obj(upsertedCount=total)

    def upsert_texts(self, texts: str | Iterable[str], ids: Iterable[str] | None = None,
                     metadata: Mapping | Iterable[Mapping | None] | None = None,
                     namespace: str | None = None, batch_size: int | None = None) -> Obj:
        """Embed and store text, on an index with an embedding model.

        Without `ids`, each record's id is a hash of its text, so loading the same text twice
        overwrites rather than duplicates. `metadata` is one dict for every text, or one per text.
        Returns `upsertedCount` and the `ids` used."""
        records = text_records(texts, ids, metadata)
        self.upsert(records, namespace, batch_size or TEXT_BATCH)
        return Obj(upsertedCount=len(records), ids=[r["id"] for r in records])

    def upsert_arrays(self, ids: list[str], values, metadata: list[dict | None] | None = None,
                      namespace: str | None = None, batch_size: int | None = None) -> Obj:
        """Upsert from an (n x d) array — the fast path for bulk loads."""
        return self.upsert(array_records(ids, values, metadata), namespace, batch_size)

    # ---- search ------------------------------------------------------------------------

    def query(self, vector=None, *, id: str | None = None, text: str | None = None, top_k: int = 10,
              namespace: str | None = None, filter: dict | None = None,
              include_values: bool = False, include_metadata: bool = False,
              ef_search: int | None = None) -> Obj:
        """Nearest neighbours of a vector, a stored record (`id`), or `text` on an index
        with an embedding model."""
        return wrap(self._query(vector=vector, id=id, text=text, top_k=top_k, namespace=namespace,
                                filter=filter, include_values=include_values,
                                include_metadata=include_metadata, ef_search=ef_search))

    def search(self, query=None, top_k: int = 10, *, text: str | None = None,
               namespace: str | None = None, filter: dict | None = None,
               include_metadata: bool = True, include_values: bool = False,
               ef_search: int | None = None) -> Obj:
        """Search by meaning with a string, or by a vector: `index.search("waterproof boots")`.
        Metadata is included by default."""
        args = search_args(query, text)
        return self.query(top_k=top_k, namespace=namespace, filter=filter, include_metadata=include_metadata,
                          include_values=include_values, ef_search=ef_search, **args)

    # ---- read --------------------------------------------------------------------------

    def fetch(self, ids: list[str], namespace: str | None = None) -> Obj:
        return wrap(self._fetch(list(ids), namespace))

    def get(self, id: str, namespace: str | None = None) -> Obj | None:
        """One record with its values and metadata, or None if it doesn't exist."""
        return wrap(self._fetch([id], namespace)["vectors"].get(id))

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

    def scan(self, prefix: str | None = None, namespace: str | None = None,
             batch_size: int = 100, include_values: bool = False) -> Iterator[Obj]:
        """Yield every record (optionally only ids starting with `prefix`), fetched a page at a time.
        Metadata is always included; values only with `include_values`."""
        for ids in self.list(prefix=prefix, limit=scan_size(batch_size), namespace=namespace):
            for record in scanned(ids, self._fetch(ids, namespace)["vectors"], include_values):
                yield wrap(record)

    # ---- change ------------------------------------------------------------------------

    def update(self, id: str, values=None, set_metadata: dict | None = None,
               namespace: str | None = None) -> Obj:
        self._update(id, values, set_metadata, namespace)
        return Obj()

    def delete(self, ids: list[str] | None = None, delete_all: bool = False,
               filter: dict | None = None, namespace: str | None = None) -> Obj:
        return Obj(deletedCount=self._delete(list(ids) if ids is not None else None,
                                             delete_all, filter, namespace))

    # ---- inspect -----------------------------------------------------------------------

    def describe_index_stats(self, filter: dict | None = None) -> Obj:
        return wrap(self._stats(filter))

    def count(self, namespace: str | None = None, filter: dict | None = None) -> int:
        """Records in a namespace (the default one unless given), optionally only those matching `filter`."""
        return count_in(self._stats(filter), namespace)

    def describe(self) -> Obj:
        """This index's settings: dimension, metric, embedding model, record count and status."""
        return wrap(self._describe())

    def __repr__(self) -> str:
        return f"<{type(self).__name__} {self.name!r}>"
