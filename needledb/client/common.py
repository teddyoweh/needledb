"""Request bodies, record helpers and error handling shared by every client."""
from __future__ import annotations

import base64
import hashlib
from collections.abc import Iterable, Mapping
from typing import Any

import numpy as np
import orjson

from ..errors import BY_CODE, AlreadyExists, NeedleError

TRANSIENT = {502, 503, 504}
TEXT_BATCH = 256  # records per request when the server embeds them
KEEP = object()  # "leave this setting as it is"


def backoff(attempt: int) -> float:
    return min(0.25 * 2 ** attempt, 4.0)


def pack(values) -> str:
    """A vector as base64 little-endian float32: a quarter of the JSON size, and no float parsing."""
    return base64.b64encode(np.asarray(values, dtype="<f4").tobytes()).decode("ascii")


def encode(body) -> bytes | None:
    return orjson.dumps(body, option=orjson.OPT_SERIALIZE_NUMPY) if body is not None else None


def decode(status: int, content: bytes, text: str) -> Any:
    """The JSON body of a response, or the typed exception its error describes."""
    if status >= 400:
        try:
            err = orjson.loads(content)["error"]
            raise BY_CODE.get(err["code"], NeedleError)(err["message"])
        except (orjson.JSONDecodeError, KeyError, TypeError):
            raise NeedleError(f"HTTP {status}: {text[:200]}") from None
    return orjson.loads(content) if content else {}


# ---- control plane ---------------------------------------------------------------------

def index_body(name, dimension, metric, index_type, hnsw, embed, storage=None) -> dict:
    body: dict = {"name": name, "metric": metric, "index_type": index_type}
    if storage:
        body["storage"] = storage
    if dimension is not None:
        body["dimension"] = dimension
    if hnsw:
        body["hnsw"] = hnsw
    if embed:
        body["embed"] = embed
    return body


def check_existing(info: Mapping, dimension: int | None, metric: str) -> None:
    """With `exist_ok`, an existing index is only reused if it's the one that was asked for."""
    if (dimension is not None and info["dimension"] != dimension) or info["metric"] != metric:
        raise AlreadyExists(f"index {info['name']!r} already exists with dimension {info['dimension']} "
                            f"and metric {info['metric']!r}")


def configure_body(ef_search, embed) -> dict:
    body: dict = {}
    if ef_search is not None:
        body["hnsw"] = {"ef_search": ef_search}
    if embed is not KEEP:
        body["embed"] = embed
    if not body:
        raise ValueError("pass ef_search, embed, or both")
    return body


def key_body(name, role, indexes, expires_in_days) -> dict:
    body: dict = {"name": name, "role": role}
    if indexes is not None:
        body["indexes"] = indexes
    if expires_in_days is not None:
        body["expiresInDays"] = expires_in_days
    return body


# ---- data plane ------------------------------------------------------------------------

def _packed(record):
    if isinstance(record, dict):
        if record.get("values") is None:
            return record
        return {**record, "values": pack(record["values"])}
    if isinstance(record, (tuple, list)) and len(record) in (2, 3):
        packed = {"id": record[0], "values": pack(record[1])}
        if len(record) == 3 and record[2] is not None:
            packed["metadata"] = record[2]
        return packed
    return record


def upsert_body(records: list, namespace, binary: bool) -> dict:
    body: dict = {"vectors": [_packed(r) for r in records] if binary else records}
    if namespace:
        body["namespace"] = namespace
    return body


def query_body(binary: bool, *, vector, id, text, top_k, namespace, filter, include_values,
               include_metadata, ef_search) -> dict:
    if vector is not None and binary:
        vector = pack(vector)
    body = {"topK": top_k, "includeValues": include_values, "includeMetadata": include_metadata}
    for key, value in (("vector", vector), ("id", id), ("text", text), ("namespace", namespace),
                       ("filter", filter), ("efSearch", ef_search)):
        if value is not None:
            body[key] = value
    return body


def update_body(binary: bool, id, values, set_metadata, namespace) -> dict:
    body = {"id": id, "namespace": namespace}
    if values is not None:
        body["values"] = pack(values) if binary else values
    if set_metadata is not None:
        body["setMetadata"] = set_metadata
    return body


def delete_body(ids, delete_all, filter, namespace) -> dict:
    body: dict = {"namespace": namespace}
    if ids is not None:
        body["ids"] = list(ids)
    if delete_all:
        body["deleteAll"] = True
    if filter is not None:
        body["filter"] = filter
    return body


def list_params(prefix, limit, pagination_token, namespace) -> dict:
    params: dict = {"limit": limit}
    for key, value in (("prefix", prefix), ("paginationToken", pagination_token), ("namespace", namespace)):
        if value is not None:
            params[key] = value
    return params


def search_args(query, text) -> dict:
    """`search("words")` searches by text; `search(vector)` by vector."""
    if text is not None:
        if query is not None:
            raise ValueError("pass the query positionally or as text=, not both")
        return {"text": text}
    if query is None:
        raise ValueError("search needs a query: a string or a vector")
    return {"text": query} if isinstance(query, str) else {"vector": query}


def text_id(text: str) -> str:
    """A stable id from the text itself, so loading the same text twice doesn't duplicate it."""
    return hashlib.sha1(text.encode()).hexdigest()[:24]


def text_records(texts, ids, metadata) -> list[dict]:
    texts = [texts] if isinstance(texts, str) else list(texts)
    if any(not isinstance(t, str) for t in texts):
        raise TypeError("texts must be strings")
    ids = [text_id(t) for t in texts] if ids is None else list(ids)
    if len(ids) != len(texts):
        raise ValueError("ids must have one entry per text")
    if metadata is None or isinstance(metadata, Mapping):
        metas = [metadata] * len(texts)
    else:
        metas = list(metadata)
        if len(metas) != len(texts):
            raise ValueError("metadata must be one dict for every text, or one entry per text")
    records: dict[str, dict] = {}
    for rid, text, meta in zip(ids, texts, metas):
        record = {"id": rid, "text": text}
        if meta:
            record["metadata"] = dict(meta)
        records[rid] = record  # a repeated id keeps its last text
    return list(records.values())


def array_records(ids, values, metadata) -> list[dict]:
    values = np.asarray(values, dtype=np.float32)
    ids = list(ids)
    if values.ndim != 2 or len(values) != len(ids):
        raise ValueError("values must be an (n x d) array with one row per id")
    if metadata is not None and len(metadata) != len(ids):
        raise ValueError("metadata must have one entry per id")
    records = []
    for i, rid in enumerate(ids):
        record = {"id": rid, "values": values[i]}
        if metadata is not None and metadata[i]:
            record["metadata"] = metadata[i]
        records.append(record)
    return records


def batches(items: list, size: int) -> Iterable[list]:
    for start in range(0, len(items), size):
        yield items[start:start + size]


def count_in(stats: Mapping, namespace: str | None) -> int:
    return stats["namespaces"].get(namespace or "", {}).get("vectorCount", 0)


def scan_size(batch_size: int) -> int:
    if not isinstance(batch_size, int) or not 1 <= batch_size <= 1000:
        raise ValueError("batch_size must be from 1 to 1000")
    return batch_size


def scanned(ids: list[str], found: Mapping, include_values: bool) -> list[dict]:
    """Fetched records in list order, skipping any deleted between the list and the fetch."""
    out = []
    for rid in ids:
        record = found.get(rid)
        if record is not None:
            out.append(record if include_values else {k: v for k, v in record.items() if k != "values"})
    return out
