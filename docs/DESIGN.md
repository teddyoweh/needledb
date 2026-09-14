# NeedleDB — design

A self-hostable vector database with a Pinecone-shaped API. It is one process with one data
directory and no managed service, so it can run locally, on a VM, or inside your own app.

This document describes what the code does. Where the code and this document disagree, one of
them is wrong and should be fixed.

---

## 1. Goals and non-goals

**Goals**

1. **Drop-in shape.** Control-plane and data-plane calls map one-to-one onto Pinecone's
   (`create_index`, `upsert`, `query`, `fetch`, `update`, `delete`, `list`,
   `describe_index_stats`). Moving an app off Pinecone is a host and key change. The official
   Pinecone Python client works against a NeedleDB index host, and a test proves it.
2. **Any dimension.** Every index declares its own dimension, from 1 to 65,536. Nothing in the
   engine assumes 768 or 1536.
3. **Fast, and honest about it.** Millisecond queries at hundreds of thousands of vectors on one
   machine. Every benchmark measures recall against exact search, and no latency number is
   published without its recall.
4. **Filters that keep recall.** A narrow metadata filter still returns a full page of the true
   nearest matches. Post-filtering a fixed candidate set, the naive approach, collapses here.
5. **Durable.** A crash loses no acknowledged write, and a restart is fast.
6. **Self-contained.** Server, dashboard and SDK ship together, and Docker is one command.
7. **Embeddable.** The same engine runs in-process through `NeedleDBLocal`.

**Non-goals (v0.1)**

- Distributed sharding and replication. v0.1 is a single node; see the roadmap.
- Sparse and hybrid vectors.
- Writing our own ANN kernels. FAISS provides them; NeedleDB is the database around them.

---

## 2. Architecture

```
        ┌──────────────┐   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
        │ NeedleDB SDK │   │   Pinecone   │   │  Dashboard   │   │  curl / any  │
        │ remote/local │   │    client    │   │   UI (/ui)   │   │  HTTP client │
        └──────┬───────┘   └──────┬───────┘   └──────┬───────┘   └──────┬───────┘
               └──────────────────┴────── Api-Key ───┴──────────────────┘
        ┌──────────────────────────────────▼─────────────────────────────────┐
        │  HTTP API (FastAPI + orjson) — auth · errors · metrics · /health   │
        │  body parse, engine call and serialization run in worker threads   │
        └──────────────────────────────────┬─────────────────────────────────┘
        ┌──────────────────────────────────▼─────────────────────────────────┐
        │  Registry — index name → Index (config, storage, namespaces)       │
        └──────────────────────────────────┬─────────────────────────────────┘
                                           │ one Collection per namespace
        ┌──────────────────────────────────▼─────────────────────────────────┐
        │  Collection                                                         │
        │   FAISS IndexFlat / IndexHNSWFlat  — the only copy of the vectors   │
        │   slot tables: ids, norms, tombstones                               │
        │   MetadataIndex: postings, numeric columns, presence                │
        │   search planner · reader–writer lock · background rebuild          │
        └──────────────────────────────────┬─────────────────────────────────┘
        ┌──────────────────────────────────▼─────────────────────────────────┐
        │  data/<index>/index.json · data.sqlite (WAL, source of truth)       │
        │  data/<index>/snapshots/<namespace>/<seq>/  (fast restart)          │
        └────────────────────────────────────────────────────────────────────┘
```

Code layout:

```
needledb/
  errors.py        error types shared by engine, server and clients (no heavy imports)
  core/
    config.py      IndexConfig, HNSWConfig, limits
    filters.py     filter grammar, validation, MetadataIndex
    collection.py  one namespace: FAISS index, slots, planner, rebuilds, snapshots
    index.py       one index: namespaces, write path, storage, snapshot schedule
    storage.py     SQLite records log and replay
    registry.py    every index under a data directory
    rwlock.py      writer-preferring reader–writer lock
    metrics.py     counters, histograms, rolling percentiles
  server/app.py    routes, auth middleware, error mapping, dashboard mount
  client/
    index.py       the shared Index surface and result type
    http.py        NeedleDB (remote)
    local.py       NeedleDBLocal (embedded)
  cli.py           `needledb serve`
ui/                React + Vite + TypeScript dashboard, built into needledb/server/static, served at /app
bench/             datasets, system adapters, runner, report, compose file for competitors
deploy/            docker-compose.yml for running NeedleDB
Dockerfile         dashboard build stage + server image
tests/             filters (property-tested), engine, persistence, API, SDKs, Pinecone client
```

---

## 3. Data model

**Index**

| field | meaning |
|---|---|
| `name` | 1–45 chars of `[a-z0-9-]`, starting and ending alphanumeric; unique |
| `dimension` | 1–65,536 |
| `metric` | `cosine` (default), `dotproduct`, `euclidean` |
| `index_type` | `auto` (default), `flat`, `hnsw` |
| `hnsw` | `m` (32), `ef_construction` (200), `ef_search` (128); only `ef_search` can change later |
| `created_at` | ISO timestamp |

**Namespace**: a partition inside an index; `""` is the default. It is created on first write
and dropped by `deleteAll`.

**Record**: an `id` (string of at most 512 bytes), `values` (float32 × dimension, finite) and
optional `metadata` (a JSON object of at most 40 KB). Metadata values are strings, finite
numbers, booleans or lists of strings.

**Scores**

| metric | stored as | score returned | order |
|---|---|---|---|
| cosine | unit vector + original norm | cosine similarity | higher first |
| dotproduct | raw | dot product | higher first |
| euclidean | raw | squared L2 distance | lower first |

Cosine indexes keep each record's norm, so `fetch` and `includeValues` return the values that
were written, not the normalized ones.

---

## 4. Engine

### 4.1 Slots and storage

A slot is a position in the collection. Both FAISS index types are filled positionally, so slot
*i* is FAISS label *i*. The vectors live **only** inside FAISS. Exact scans, fetches and rebuilds
read a zero-copy NumPy view of the index's flat storage (`rev_swig_ptr(storage.get_xb())`).
That view is valid until the next `add`, which only happens under the write lock, so any reader
holding the read lock may use it. RAM therefore holds one copy of the vectors, not two.

Beside FAISS, each collection keeps `slot → id`, `id → slot`, a float32 norm per slot and a
tombstone bit per slot.

Upserting an existing id tombstones the old slot and appends a new one. Deletes tombstone.
Tombstoned slots never reach a result: every search passes FAISS an `IDSelectorBitmap` of live
(and matching) slots.

### 4.2 Index structures

- **flat**: `IndexFlatIP` or `IndexFlatL2`. Exact, and the reference for recall.
- **hnsw**: `IndexHNSWFlat(d, m, metric)`. `efSearch` is set per query through
  `SearchParametersHNSW`: the index default, or the request's `efSearch`.
- **auto**: flat until 20,000 live vectors, then HNSW. The graph is built in a background
  thread while queries keep using the flat index, then swapped in (§4.4).

### 4.3 Search planner

For a query with a filter:

1. Evaluate the filter to a boolean mask over slots and intersect it with the live mask.
   *count* = matching slots.
2. **count = 0**: return no matches (`filtered-empty`).
3. **count ≤ max(5,000, 2% of live)**: run an exact scan over only those slots, in chunks of 4,096
   rows so memory stays bounded (`filtered-exact`). Recall is 100% by construction, and at this
   size the scan beats graph traversal.
4. **Flat index, larger count**: FAISS flat search with the bitmap selector (`filtered-exact`).
5. **HNSW, larger count**: HNSW search with the bitmap selector, so non-matching nodes are
   skipped during traversal rather than dropped afterwards. The beam widens as selectivity
   falls: `ef = clamp(ef / sqrt(count / live), ef, 4·ef)` (`filtered-hnsw`).

Without a filter the query is a plain ANN search (`exact` or `hnsw`). The selector is attached
only when tombstones exist. The plan is returned in `usage.plan`.

### 4.4 Rebuilds: promotion and compaction

A rebuild starts when an `auto` index reaches the threshold, or when tombstones reach
max(1,000, 20% of slots). It runs in four steps:

1. Under the write lock, copy the live vectors, ids, norms and metadata, and start logging every
   later write to this collection.
2. In a background thread, build the new FAISS index and a fresh `MetadataIndex`. Reads and
   writes continue against the old state meanwhile.
3. Under the write lock, swap in the compacted state, then replay the logged writes onto it.
4. If the replay itself crossed a threshold, start another rebuild.

`wait_for_index()` blocks until rebuilds settle. Snapshots wait for it too, so they never capture
a half-built graph.

### 4.5 Metadata index and filter language

Grammar (Pinecone-compatible):

```
filter    := { field: condition, ... } | { "$and": [filter, ...] } | { "$or": [filter, ...] }
condition := scalar                                  (shorthand for $eq)
           | { "$eq" | "$ne": scalar }
           | { "$gt" | "$gte" | "$lt" | "$lte": number }
           | { "$in" | "$nin": [scalar, ...] }
           | { "$exists": bool }
```

Several fields in one object are an implicit `$and`. For list-valued metadata, `$eq` and `$in`
match when any element matches. `$ne` and `$nin` are their exact complements, so they also match
records that lack the field. Numbers compare numerically (`1 == 1.0`), and booleans never equal
numbers.

For each field, `MetadataIndex` keeps:
- inverted postings `value → set[slot]`;
- a float64 column for numeric values, so range predicates are vectorized;
- a presence set.

Masks for single postings and presence sets are cached, keyed by a metadata version that every
change bumps. A repeated filter costs NumPy boolean ops, not set iteration. Invalid grammar
returns a 400 naming the problem.

### 4.6 Concurrency

Each collection has a writer-preferring reader–writer lock:
- Queries hold the read lock and run concurrently. FAISS releases the GIL while searching, so
  one process scales across cores.
- Writes serialize per collection. Waiting writers block new readers, so steady query load
  cannot starve an upsert.

A single-query search in FAISS is single-threaded (it parallelizes across queries, not within
one), so concurrent requests don't oversubscribe the cores.

---

## 5. Storage and durability

Each index lives in its own directory, `data/<index>/`:

- `index.json`: the config, written atomically.
- `data.sqlite`: WAL mode with `synchronous=NORMAL`. It is the **source of truth**.
  - Table `records(namespace, id, vals BLOB, metadata BLOB, seq, deleted)`, keyed by
    `(namespace, id)`.
  - Table `meta` holds the durable high-water `seq`.
  - Every write batch is one transaction with the next `seq`, and the API acknowledges after
    commit.
  - Deletes keep a marker row with no values, so replay can apply them.
- `snapshots/<namespace>/<seq>/`: a snapshot of one namespace at `seq`, containing:
  - `index.faiss`, written with `faiss.write_index`, streamed to disk rather than serialized in
    memory;
  - `slots.npz` (norms, tombstones);
  - `slots.json` (seq, slot ids, index kind).

  A `CURRENT` file points at the complete one: the snapshot is written to a temp directory,
  renamed, and only then is `CURRENT` replaced. Older snapshots are removed.

**Write path:** validate everything first, commit to SQLite, apply in memory — all under the
collection's write lock. A snapshot, taken under the read lock, therefore matches its `seq`
exactly.

**Snapshots** run in the background every `NEEDLEDB_SNAPSHOT_EVERY` writes (default 50,000) and
on clean shutdown. Once every namespace is snapshotted past a delete marker, the marker is
purged. The high-water `seq` is persisted first, so `seq` never moves backwards.

**Startup:** for each namespace, load the `CURRENT` snapshot, rebuild the metadata index from
SQLite, then replay rows with `seq` greater than the snapshot's. With no usable snapshot — missing
or inconsistent — the namespace is rebuilt from the live rows: slower, same result.

---

## 6. HTTP API

**Auth:** every route except `/health`, the web app's static files and `/auth/login|logout|me` needs
an `Api-Key` (or `Authorization: Bearer`) header, or a web-app session cookie. See §6.1.

### 6.1 Security model

- **Keys.** `NEEDLEDB_API_KEY` holds bootstrap admin keys. Managed keys (`ndb_…`) are created by
  admins, shown once, and stored as SHA-256 digests in `data/_system/auth.sqlite`.
  - Roles: `read` (query, fetch, list, stats), `write` (+ upsert, update, delete), `admin`
    (+ indexes, keys).
  - Read and write keys can be limited to named indexes; other indexes answer 404 to them.
  - A revocation takes effect immediately.
- **Sessions.** `POST /auth/login` exchanges a key for an HMAC-signed token in an HttpOnly,
  SameSite=Strict cookie (Secure over HTTPS) that lasts 12 h and names the key id, never the key.
  - Signing out denylists that token.
  - Revoking the key invalidates its sessions.
  - `POST /auth/sessions/revoke-all` rotates the secret (`data/_system/session.key`, mode 600).
  - Cookie-authenticated writes must be same-origin (the `Origin` or `Sec-Fetch-Site` header is checked).
- **Lockout.** 10 failed authentications from one client within 5 minutes block it for 5 minutes (429).
- **Headers and limits.**
  - CSP on `/app`, `default-src 'none'` on API responses, plus `X-Frame-Options: DENY`,
    `nosniff`, `no-referrer` and `Cache-Control: no-store`.
  - HSTS over HTTPS.
  - Bodies over `NEEDLEDB_MAX_BODY_MB` are refused with 413.
- **Serving.**
  - `--no-auth` is refused on non-loopback addresses.
  - A public plain-HTTP bind warns.
  - `--tls-cert/--tls-key` serve HTTPS directly; `--trust-proxy` reads `X-Forwarded-*` from a TLS proxy.

**Errors:** `{"error": {"code": "INVALID_ARGUMENT" | "UNAUTHENTICATED" | "NOT_FOUND" |
"ALREADY_EXISTS" | "METHOD_NOT_ALLOWED" | "INTERNAL", "message": "…"}}`, with the matching HTTP status.

Request bodies accept camelCase and snake_case (`topK` / `top_k`); responses use camelCase.

### Control plane

| method | path | body / result |
|---|---|---|
| POST | `/indexes` | `{name, dimension, metric?, index_type?, hnsw?}` → 201 index |
| GET | `/indexes` | `{indexes: [index…]}` |
| GET | `/indexes/{name}` | `{name, dimension, metric, index_type, hnsw, created_at, vectorCount, namespaceCount, annTypes, memoryBytes, storageBytes, status: {ready, state}, host}` |
| PATCH | `/indexes/{name}` | `{hnsw: {ef_search}}` → index |
| DELETE | `/indexes/{name}` | 202 |

### Data plane (under `/indexes/{name}`)

| method | path | body / result |
|---|---|---|
| POST | `/vectors/upsert` | `{vectors: [{id, values, metadata?}], namespace?}` → `{upsertedCount}` (≤ 10,000 per request) |
| POST | `/query` | `{vector \| id, topK, namespace?, filter?, includeValues?, includeMetadata?, efSearch?}` → `{matches: [{id, score, values?, metadata?}], namespace, usage: {latencyMs, plan}}` |
| GET / POST | `/vectors/fetch` | `?ids=a&ids=b&namespace=` or `{ids, namespace}` → `{vectors: {id: {id, values, metadata}}, namespace}` |
| POST | `/vectors/update` | `{id, values?, setMetadata?, namespace?}` → `{}` (`setMetadata` merges) |
| POST | `/vectors/delete` | `{ids \| deleteAll \| filter, namespace?}` → `{deletedCount}` |
| GET | `/vectors/list` | `?prefix&limit&paginationToken&namespace` → `{vectors: [{id}], pagination: {next?}, namespace}` |
| GET / POST | `/describe_index_stats` | `{filter?}` → `{dimension, metric, totalVectorCount, namespaces: {ns: {vectorCount, indexType, building, tombstones}}, indexFullness}` |

### Operations

- `GET /health`: unauthenticated.
- `GET /metrics`: Prometheus text — request counters by route, index and status; latency
  histograms by route; vectors per namespace; memory estimate and disk per index.
- `GET /stats`: the JSON the dashboard polls — totals, process RSS, and live QPS with p50/p95/p99
  over the last 60 s, overall, per route and per index.

---

## 7. SDK

```python
from needledb import NeedleDB, NeedleDBLocal

db = NeedleDB("http://localhost:8080", api_key="…")     # remote
# db = NeedleDBLocal("./data")                          # embedded, no server

db.create_index("products", dimension=1536, metric="cosine")
index = db.Index("products")
index.upsert([("sku-1", vec, {"category": "jeans", "price": 49.0})], namespace="catalog")
index.upsert_arrays(ids, matrix, metadata)              # bulk from an (n × d) array
res = index.query(vector=vec, top_k=10, filter={"category": {"$in": ["jeans"]}},
                  include_metadata=True, namespace="catalog")
res.matches[0].id, res.matches[0].score
index.fetch(["sku-1"]); index.update("sku-1", set_metadata={"price": 39.0})
index.delete(ids=["sku-1"]); index.describe_index_stats().total_vector_count
for ids in index.list(prefix="sku-"): ...
```

Remote and local clients expose the same `Index` methods, so an app can start embedded and move
to a server without changing call sites.
- **Results** are dicts that also read as attributes, in either spelling
  (`stats.total_vector_count == stats["totalVectorCount"]`).
- **Upserts** batch automatically: 500 per request remote, 10,000 local.
- **The remote client** retries transport errors and 502/503/504 with backoff, and raises typed
  errors (`NotFound`, `InvalidArgument`, `AlreadyExists`, `Unauthenticated`).
- **Imports:** the remote client never imports FAISS.

---

## 8. Dashboard

The dashboard is React + Vite + TypeScript, built to static files and served at `/ui/` with hash
routing. It follows the viewer's light or dark theme and has no runtime dependencies beyond React.

- **Overview**: vectors, queries per second, index memory, disk, process RSS; live throughput and
  p50/p99 charts; per-index and per-route traffic.
- **Indexes**: list and create — name, dimension with presets, metric, structure, HNSW settings.
- **Index → Overview**: namespaces with vector counts, structure, tombstones and rebuild state;
  the configuration; a connect snippet.
- **Index → Query**:
  - query by pasted vector, random unit vector or stored record id;
  - topK, efSearch and namespace;
  - a JSON filter with validation, plus one-click filters from fields seen in results;
  - results with a score bar and metadata;
  - server and round-trip latency and the plan;
  - the request, copyable as curl.
- **Index → Browse**: page ids by namespace and prefix; each record's metadata, norm, range and a
  diverging colour strip of its vector; find similar; delete with a two-step confirm.
- **Index → Upsert**: paste JSON records, validated against the dimension, or insert an example.
- **Index → Settings**: tune `ef_search`; delete the index after typing its name.

The API key is entered once and kept in `localStorage`. A 401 opens the key dialog.

---

## 9. Benchmarks

The harness lives in `bench/`, results as JSON in `bench/results/`, and the rendered report in
`bench/REPORT.md`.

**Data.** Real embeddings, not synthetic ones: DBpedia entities embedded with OpenAI
`text-embedding-3-large`, from Qdrant's public copies, at 1536 and 3072 dimensions. The corpus
is 100k vectors, with 1,000 held-out queries from the same distribution. Synthetic Gaussian
clusters (`synthetic-<dim>`) cover other shapes.

**Filters.** Each vector gets a uniform label. The fields `s50`, `s10`, `s1` and `s01` select
50%, 10%, 1% and 0.1% of the corpus, independently of the vectors.

**Ground truth.** Exact top-100 by brute force, unfiltered and per filter.

**Systems:**
- NumPy brute force (the exact floor) and raw FAISS HNSW (the library ceiling);
- NeedleDB embedded and NeedleDB server, native on the host;
- NeedleDB, Qdrant (gRPC) and pgvector in Docker — same VM, same CPU and memory limits.

Every HNSW uses the same `m` and `ef_construction`.

**Measured:**
- build time (to fully searchable);
- memory (with the benchmark's own copy of the data freed first);
- recall@10 and single-client p50/p95/p99 across an `ef_search` sweep;
- 16-client throughput at the first `ef` reaching 95% recall;
- filtered recall and latency at each selectivity.

Each system runs in its own process.

---

## 10. Testing

- **Filters**: the engine against a straightforward reference implementation on random metadata
  and random nested filters, including removals, plus number/boolean typing, cache
  invalidation and invalid grammar.
- **Engine**:
  - flat equals brute force for every metric;
  - HNSW recall;
  - filtered recall at 50%, 5% and 0.1% selectivity;
  - dimensions 1, 2, 3, 257 and 4,096;
  - overwrite, update and delete semantics, namespaces, pagination, validation;
  - rebuilds with concurrent writes replayed;
  - concurrent reads during writes;
  - restart from snapshot plus log, and after a crash without a snapshot.
- **API**: every route, auth, error codes and shapes, `/stats` and `/metrics`.
- **SDKs**: the same round-trip test against remote and local clients, plus the official Pinecone
  client against a live server.

---

## 11. Roadmap

1. Quantized indexes (SQ8, PQ, IVF-PQ) for memory-bound collections.
2. Memory-mapped snapshots; snapshots to S3/GCS; read replicas.
3. Sparse and hybrid search.
4. TypeScript SDK; gRPC transport.
5. Per-key permissions and quotas.
