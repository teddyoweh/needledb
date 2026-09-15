"""NeedleDBLocal — the same engine and Index API, inside your process, no server."""
from __future__ import annotations

from pathlib import Path

from .index import BaseIndex, Obj, wrap


class NeedleDBLocal:
    """
        with NeedleDBLocal("./vectors") as db:
            db.create_index("products", dimension=1536)
            index = db.Index("products")
            index.upsert([("sku-1", embedding, {"brand": "acme"})])

    Data persists in `path`; open the same path later (or point a server at it).
    Only one process may open a data directory at a time.
    """

    def __init__(self, path: str | Path = "./needledb-data"):
        from ..core import IndexConfig, Registry  # the engine (and FAISS) load only here

        self._config = IndexConfig
        self._registry = Registry(path)

    def create_index(self, name: str, dimension: int | None = None, metric: str = "cosine",
                     index_type: str = "auto", hnsw: dict | None = None, embed: dict | None = None) -> Obj:
        cfg = self._config.from_dict({"name": name, "dimension": dimension, "metric": metric,
                                      "index_type": index_type, "hnsw": hnsw, "embed": embed})
        return wrap(self._registry.create_index(cfg).summary())

    def list_indexes(self) -> list[Obj]:
        return [wrap(i.summary()) for i in self._registry.list()]

    def describe_index(self, name: str) -> Obj:
        return wrap(self._registry.get(name).summary())

    def has_index(self, name: str) -> bool:
        return any(i.cfg.name == name for i in self._registry.list())

    def configure_index(self, name: str, ef_search: int) -> Obj:
        index = self._registry.get(name)
        index.configure(ef_search)
        return wrap(index.summary())

    def delete_index(self, name: str) -> None:
        self._registry.delete_index(name)

    def Index(self, name: str) -> "LocalIndex":  # noqa: N802 — matches Pinecone's SDK
        return LocalIndex(self._registry.get(name))

    index = Index

    def close(self) -> None:
        """Snapshot every index and release the data directory."""
        self._registry.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


class LocalIndex(BaseIndex):
    default_batch_size = 10_000

    def __init__(self, engine):
        self._engine = engine
        self.name = engine.cfg.name

    def _upsert(self, vectors, namespace):
        return self._engine.upsert(vectors, namespace)

    def _query(self, **kwargs):
        return self._engine.query(**kwargs)

    def _fetch(self, ids, namespace):
        return self._engine.fetch(ids, namespace)

    def _update(self, id, values, set_metadata, namespace):
        self._engine.update(id, values, set_metadata, namespace)

    def _delete(self, ids, delete_all, filter, namespace):
        return self._engine.delete(ids, delete_all, filter, namespace)

    def _list(self, prefix, limit, pagination_token, namespace):
        return self._engine.list_ids(prefix, limit, pagination_token, namespace)

    def _stats(self, filter):
        return self._engine.describe_stats(filter)

    def wait_for_index(self, timeout: float | None = None) -> None:
        """Block until any background HNSW build or compaction has been swapped in."""
        self._engine.wait_for_index(timeout)
