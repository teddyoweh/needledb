# NeedleDB

A self-hostable vector database with Pinecone's API, built on FAISS.

One process gives you a REST API, a dashboard, durable storage and metadata filtering.
Point the official Pinecone client at it, use the NeedleDB SDK, or embed the engine
directly in your Python process with no server at all.

- **Pinecone-shaped API**: upsert, query, fetch, update, delete, list, stats and namespaces,
  with the same JSON and filter grammar. The official `pinecone` Python client works against
  a NeedleDB index host unchanged (covered by a test).
- **Any dimension**, from 1 to 65,536, with cosine, dot product or euclidean distance.
- **FAISS underneath**:
  - exact flat search for small collections;
  - HNSW for large ones;
  - `auto` switches from flat to HNSW in the background at 20k vectors, without blocking reads.
- **Filters that keep their recall**: a selectivity-aware planner answers narrow filters with
  an exact scan of the matches and wide filters with filtered HNSW and a widened beam.
- **Durable**: every write commits to a SQLite WAL before it is acknowledged. Snapshots of the
  FAISS index make restarts fast, and a crash replays only the writes after the last snapshot.
- **Operable**:
  - a dashboard to create, query, browse and upsert, with live QPS and p50/p99;
  - Prometheus `/metrics`, API-key auth, OpenAPI docs at `/docs`;
  - a Docker image.
- **Benchmarked honestly** against raw FAISS, Qdrant and pgvector on real OpenAI embeddings.
  Recall is always reported next to speed. See [bench/REPORT.md](bench/REPORT.md).

## Quickstart

```bash
pip install -e .                      # Python 3.11–3.13
needledb serve --api-key "$(openssl rand -hex 24)"
# API http://127.0.0.1:8080 · dashboard http://127.0.0.1:8080/ui/ · docs /docs
```

Or with Docker:

```bash
export NEEDLEDB_API_KEY=$(openssl rand -hex 24)
docker compose -f deploy/docker-compose.yml up -d
```

For local experiments without a key: `needledb serve --no-auth` (binds to 127.0.0.1).

## Python SDK

```python
from needledb import NeedleDB

db = NeedleDB("http://localhost:8080", api_key="…")
db.create_index("products", dimension=3072, metric="cosine")
index = db.Index("products")

index.upsert([
    {"id": "sku-1", "values": embedding, "metadata": {"brand": "acme", "price": 49, "tags": ["new"]}},
    ("sku-2", other_embedding, {"brand": "zenith", "price": 120}),
])
index.upsert_arrays(ids, matrix, metadata)          # bulk load from an (n × d) array

res = index.query(vector=embedding, top_k=10, include_metadata=True,
                  filter={"brand": {"$in": ["acme", "zenith"]}, "price": {"$lte": 100}})
for m in res.matches:
    print(m.id, m.score, m.metadata)

index.query(id="sku-1", top_k=5)                    # neighbours of a stored record
index.fetch(["sku-1"]).vectors["sku-1"].metadata
index.update("sku-1", set_metadata={"price": 39})
index.delete(filter={"brand": "zenith"})
for page in index.list(prefix="sku-"):
    ...
index.describe_index_stats().total_vector_count
```

**Embedded mode** runs the same engine in your process, with no server, and persists to a directory:

```python
from needledb import NeedleDBLocal

with NeedleDBLocal("./vectors") as db:
    db.create_index("docs", dimension=1536)
    index = db.Index("docs")
    index.upsert_arrays(ids, embeddings)
    index.query(vector=q, top_k=10)
```

**Pinecone's client** only needs the NeedleDB index host:

```python
from pinecone import Pinecone

pc = Pinecone(api_key="…")                          # your NeedleDB key
index = pc.Index(host="http://localhost:8080/indexes/products")
index.query(vector=embedding, top_k=10, include_metadata=True)
```

## REST API

Every route except `/health` needs `Api-Key: <key>` (or `Authorization: Bearer <key>`).
Errors are `{"error": {"code": "INVALID_ARGUMENT" | "NOT_FOUND" | "ALREADY_EXISTS" | "UNAUTHENTICATED" | "INTERNAL", "message": "…"}}`.

| Method | Path | Body → result |
|---|---|---|
| `POST` | `/indexes` | `{name, dimension, metric?, index_type?, hnsw?: {m, ef_construction, ef_search}}` |
| `GET` | `/indexes` · `/indexes/{name}` | index descriptions (vectors, memory, disk, status, host) |
| `PATCH` | `/indexes/{name}` | `{hnsw: {ef_search}}` |
| `DELETE` | `/indexes/{name}` | |
| `POST` | `/indexes/{name}/vectors/upsert` | `{vectors: [{id, values, metadata?}], namespace?}` → `{upsertedCount}` |
| `POST` | `/indexes/{name}/query` | `{vector \| id, topK, namespace?, filter?, includeValues?, includeMetadata?, efSearch?}` → `{matches, namespace, usage: {latencyMs, plan}}` |
| `GET`/`POST` | `/indexes/{name}/vectors/fetch` | `ids` → `{vectors: {id: {id, values, metadata}}}` |
| `POST` | `/indexes/{name}/vectors/update` | `{id, values?, setMetadata?, namespace?}` |
| `POST` | `/indexes/{name}/vectors/delete` | `{ids \| deleteAll \| filter, namespace?}` → `{deletedCount}` |
| `GET` | `/indexes/{name}/vectors/list` | `?prefix&limit&paginationToken&namespace` |
| `POST` | `/indexes/{name}/describe_index_stats` | `{filter?}` |
| `GET` | `/health` · `/stats` · `/metrics` | liveness · dashboard JSON · Prometheus |

```bash
curl -s localhost:8080/indexes/products/query -H "Api-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"id": "sku-1", "topK": 5, "includeMetadata": true, "filter": {"price": {"$lt": 100}}}'
```

### Filters

`$eq $ne $gt $gte $lt $lte $in $nin $exists $and $or`. A bare value means `$eq`, and several
fields in one object are an implicit `$and`. Metadata values are strings, numbers, booleans or
lists of strings. A list field matches `$eq`/`$in` when any element matches.

## Choosing an index structure

| `index_type` | Search | Use it when |
|---|---|---|
| `auto` (default) | exact until 20k vectors per namespace, then HNSW, built in the background and swapped in | you don't want to think about it |
| `flat` | always exact, 100% recall | under ~50k vectors, or recall must be perfect |
| `hnsw` | HNSW from the first vector | large collections, lowest latency |

The HNSW settings are `m` (default 32), `ef_construction` (200) and `ef_search` (128). `ef_search`
can change at any time, and per query with `efSearch`. Every query reports its `plan`:
`exact`, `hnsw`, `filtered-exact` or `filtered-hnsw`.

## Dashboard

`/ui/` has pages for:
- **Overview:** vectors, memory, disk, live throughput and latency charts, per-index and per-route traffic.
- **Indexes:** create an index with presets for common embedding sizes.
- **Query:** paste a vector, generate one, or query by record id; build filters from fields seen in
  results; read the plan and latency; copy the request as curl.
- **Browse:** page through ids, inspect metadata and a colour strip of the vector, find similar
  records, delete.
- **Upsert:** paste JSON records, with validation against the index dimension.
- **Settings:** tune `ef_search`, delete the index.

## How it works

```
 SDK · Pinecone client · dashboard · curl
        │  HTTP/JSON (FastAPI, orjson; engine calls run in worker threads)
 Registry ── Index (one per name, one SQLite file) ── Collection (one per namespace)
                                                      ├─ FAISS IndexFlat / IndexHNSWFlat  ← vectors live here only
                                                      ├─ metadata postings + numeric columns (filter masks)
                                                      └─ reader–writer lock
```

- **Writes:** validate, commit to SQLite (WAL), then apply in memory under the namespace's write
  lock. Deletes and overwrites tombstone the old slot; searches exclude tombstones with a FAISS
  `IDSelectorBitmap`. Once 20% of slots are tombstones, a background rebuild compacts them.
  Writes that land during a rebuild are logged and replayed before the swap.
- **Reads:** run concurrently. FAISS releases the GIL while it searches, so one process uses every core.
- **Snapshots:** written every 50k writes (`NEEDLEDB_SNAPSHOT_EVERY`) and on shutdown: the FAISS
  index file plus slot tables, tagged with the log sequence number. A restart loads the snapshot
  and replays newer rows; a damaged snapshot falls back to a full rebuild from SQLite.

See [docs/DESIGN.md](docs/DESIGN.md) for the full design.

## Configuration

| Variable | Default | |
|---|---|---|
| `NEEDLEDB_API_KEY` | — | comma-separated accepted keys; required unless `NEEDLEDB_ALLOW_NO_AUTH=1` |
| `NEEDLEDB_DATA` | `./data` | data directory (one server process per directory) |
| `NEEDLEDB_HOST` / `NEEDLEDB_PORT` | `127.0.0.1` / `8080` | |
| `NEEDLEDB_SNAPSHOT_EVERY` | `50000` | writes between automatic snapshots |

## Development

```bash
uv venv && uv pip install -e ".[dev,bench]"
pytest                                   # engine, filters (property-tested), API, both SDKs, Pinecone client
npm --prefix ui install && npm --prefix ui run dev     # dashboard on :5173, proxied to :8080
npm --prefix ui run build                # outputs to needledb/server/static
```

## Limits and roadmap

This is 0.1:
- one node;
- vectors held in RAM (float32);
- no sparse vectors;
- no RBAC beyond API keys.

Next:
- quantized indexes (SQ8/PQ/IVF-PQ) for memory-bound collections;
- memory-mapped snapshots;
- gRPC;
- a TypeScript SDK;
- replication.
