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
- **Secure by default**: scoped API keys (read / write / admin, optionally per index), stored
  only as hashes; web-app sign-in with signed HttpOnly SameSite=Strict sessions; brute-force
  lockout, CSRF refusal, CSP and security headers; no unauthenticated access except on localhost.
- **Operable**:
  - a web app at `/app` to query, browse, upsert, manage keys and review security, with live QPS and p50/p99;
  - Prometheus `/metrics`, OpenAPI docs at `/docs`, built-in TLS or proxy support;
  - a Docker image.
- **Benchmarked honestly** against raw FAISS, Qdrant and pgvector on real OpenAI embeddings.
  Recall is always reported next to speed. See [bench/REPORT.md](bench/REPORT.md).

## Quickstart

```bash
pip install needledb                  # Python 3.11–3.14
export NEEDLEDB_API_KEY=$(openssl rand -hex 32)   # an admin key — keep it secret
needledb serve
# App http://127.0.0.1:8080/app/ · API http://127.0.0.1:8080 · docs /docs (sign in first)
```

From source, `git clone https://github.com/teddyoweh/needledb && pip install -e ./needledb` builds the web app
too when Node.js 20.19+ is installed; without Node the API still works.

Or with Docker:

```bash
export NEEDLEDB_API_KEY=$(openssl rand -hex 24)
docker compose -f deploy/docker-compose.yml up -d
```

For local experiments without a key: `needledb serve --no-auth`. The server refuses that on any
address other than localhost.

## Python SDK

```python
from needledb import NeedleDB

db = NeedleDB("http://localhost:8080", api_key="…")
db.create_index("docs", embed={"provider": "openai", "model": "text-embedding-3-small"}, exist_ok=True)
docs = db.Index("docs")

docs.upsert_texts(["Waterproof hiking boots", "Cast iron skillet"], metadata={"source": "catalog"})
res = docs.search("shoes for rainy hikes", top_k=5)   # a string searches by meaning
print(res.matches[0].metadata.text)

docs.get(res.matches[0].id)                          # one record, or None
docs.count(filter={"source": "catalog"})
for record in docs.scan():                           # every record, a page at a time
    ...
```

Indexes of your own vectors use the same Pinecone-shaped calls:

```python
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

**Half-precision vectors.** Graph indexes keep their vectors in fp16: half the memory of float32 and
faster to search, with recall unchanged (the rounding is far below what the graph itself approximates).
Loading links the graph on float32 and the finished graph moves onto fp16 storage, so bulk loads cost
nothing extra. Pass `storage="float32"` when `fetch` must return exactly the floats that were written.

**Async** code gets the same methods, awaited, with parallel batch uploads:

```python
from needledb import AsyncNeedleDB

async with AsyncNeedleDB("http://localhost:8080") as db:
    index = db.Index("products")
    await index.upsert_arrays(ids, matrix, max_concurrency=8)
    res = await index.search(embedding, top_k=10)
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

Every route except `/health` needs `Api-Key: <key>` (or `Authorization: Bearer <key>`), or the
web app's session. Errors are
`{"error": {"code": "INVALID_ARGUMENT" | "UNAUTHENTICATED" | "PERMISSION_DENIED" | "NOT_FOUND" | "ALREADY_EXISTS" | "PAYLOAD_TOO_LARGE" | "RESOURCE_EXHAUSTED" | "INTERNAL", "message": "…"}}`.

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
| `GET` | `/indexes/{name}/map` | `?namespace&limit&color_by` → a 2-D projection of a sample, for the explorer |
| `POST` | `/indexes/{name}/describe_index_stats` | `{filter?}` |
| `GET` | `/health` · `/stats` · `/metrics` | liveness · dashboard JSON · Prometheus |
| `GET`/`POST`/`DELETE` | `/keys` · `/keys/{id}` | list, create (`{name, role, indexes?, expiresInDays?}` → the key, once), revoke — admin |
| `GET` | `/events` | `?limit&before` → the audit log — admin |
| `POST` | `/auth/login` · `/auth/logout` · `/auth/sessions/revoke-all` | web-app sessions |

```bash
curl -s localhost:8080/indexes/products/query -H "Api-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"id": "sku-1", "topK": 5, "includeMetadata": true, "filter": {"price": {"$lt": 100}}}'
```

### Filters

`$eq $ne $gt $gte $lt $lte $in $nin $exists $and $or`. A bare value means `$eq`, and several
fields in one object are an implicit `$and`. Metadata values are strings, numbers, booleans or
lists of strings. A list field matches `$eq`/`$in` when any element matches.

## Text search

Give an index an embedding model and send text instead of vectors. NeedleDB embeds records
on upsert and queries on search, and keeps the text in metadata.

```python
db.create_index("products", embed={"provider": "openai", "model": "text-embedding-3-small"})
index = db.Index("products")
index.upsert([{"id": "sku-1", "text": "Waterproof hiking boots", "metadata": {"price": 129}}])
index.search("shoes for rainy hikes", top_k=5)
```

- Hosted: OpenAI, Cohere, Voyage AI, Google Gemini, Mistral AI and Jina AI. Admins add keys in the
  web app under **Settings** (checked, then stored in `_system/providers.json` with owner-only
  permissions), or set them in the environment (`OPENAI_API_KEY`, `COHERE_API_KEY`, `VOYAGE_API_KEY`,
  `GEMINI_API_KEY`, `MISTRAL_API_KEY`, `JINA_API_KEY`), which takes precedence. Keys are never stored
  with an index or returned by the API.
- Local: BGE, MiniLM, Nomic, Arctic, mxbai and E5 on the server's CPU with
  `pip install "needledb[local]"` — text never leaves the machine.
- `GET /embeddings/models` lists every model and whether its provider is ready.

Provider logos in the web app come from [LobeHub Icons](https://github.com/lobehub/lobe-icons) (MIT);
the marks belong to their owners.

## Choosing an index structure

| `index_type` | Search | Use it when |
|---|---|---|
| `auto` (default) | exact until 20k vectors per namespace, then HNSW, built in the background and swapped in | you don't want to think about it |
| `flat` | always exact, 100% recall | under ~50k vectors, or recall must be perfect |
| `hnsw` | HNSW from the first vector | large collections, lowest latency |

The HNSW settings are `m` (default 32), `ef_construction` (200) and `ef_search` (128). `ef_search`
can change at any time, and per query with `efSearch`. Every query reports its `plan`:
`exact`, `hnsw`, `filtered-exact` or `filtered-hnsw`.

## Security

- **API keys.** `NEEDLEDB_API_KEY` holds bootstrap admin keys. Admins create more under **API Keys**
  in the app, with `db.create_key(...)`, or with `needledb keys create --name ci --role read --index products`.
  - Roles: `read` lets a key query, fetch, list and read stats; `write` adds upsert, update and
    delete; `admin` adds indexes and key management.
  - Index scope: read and write keys can be limited to named indexes. Other indexes look absent to them.
  - Storage: keys are shown once and stored only as SHA-256 digests. Revoking a key takes effect immediately.
- **Web app sessions.** Signing in exchanges a key for a signed, HttpOnly, SameSite=Strict cookie that
  names the key (never contains it) and lasts 12 hours.
  - Cookie-authenticated writes from other origins are refused.
  - Revoking a key ends its sessions, and **Sign out everywhere** rotates the signing secret.
- **Brute force.** 10 failed attempts in 5 minutes block that client for 5 minutes, on both the API and the sign-in page.
- **Hardening.**
  - Every response carries a Content Security Policy for the app, plus frame blocking, `nosniff`, no referrers and `no-store`.
  - Bodies over 64 MB are refused (`NEEDLEDB_MAX_BODY_MB`).
  - `/docs` requires sign-in.
  - HSTS is sent over HTTPS.
- **Transport.** Serve over HTTPS in production: `needledb serve --tls-cert cert.pem --tls-key key.pem`,
  or run behind Caddy or nginx with `--trust-proxy` (`NEEDLEDB_TRUST_PROXY=1`), so client addresses
  and the scheme come from the proxy. The server warns when it binds publicly over plain HTTP, and
  refuses `--no-auth` on anything but localhost.

## Web app

`/app/` opens on a sign-in screen, then has pages for:
- **Overview:** vectors, queries per second, p99 and memory with sparklines; live throughput and
  latency charts; index cards; per-route traffic.
- **Indexes:** cards for every index you can access, and a create sheet with presets for common
  embedding models.
- **Query:** search by stored record or vector. Results show the record's title, similarity,
  metadata, server and round-trip latency, and the plan. Filters can be built from fields seen in
  results, and the request copies as cURL.
- **Explore:** a map of the index laid out by similarity, coloured by cluster or any metadata
  field. Click a point to thread its nearest neighbours. Empty indexes offer sample data.
- **Browse:** page through records by title, inspect metadata and a colour strip of the vector, find
  similar records, delete.
- **Upsert and Settings:** paste validated JSON records; tune `ef_search` with a slider; delete an index.
- **API Keys and Security:** create scoped keys (shown once) and revoke them; review every
  protection active on your connection; end all sessions.
- **⌘K:** jump to any index, page or action.
- **Docs** at `/app/#/docs`: guides, an API reference and the Python SDK, readable without signing in.

`/ui` redirects to `/app/`.

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
| `NEEDLEDB_API_KEY` | — | comma-separated admin keys; required unless managed keys exist or auth is off on localhost |
| `NEEDLEDB_DATA` | `./data` | data directory (one server process per directory; keys live in `_system/`) |
| `NEEDLEDB_HOST` / `NEEDLEDB_PORT` | `127.0.0.1` / `8080` | |
| `NEEDLEDB_TRUST_PROXY` | off | trust `X-Forwarded-For/Proto/Host` from a TLS proxy |
| `NEEDLEDB_SESSION_SECRET` | generated | pin the session signing secret (otherwise `_system/session.key`, mode 600) |
| `NEEDLEDB_MAX_BODY_MB` | `64` | largest accepted request body |
| `NEEDLEDB_SNAPSHOT_EVERY` | `50000` | writes between automatic snapshots |
| `OPENAI_API_KEY`, `COHERE_API_KEY`, … | — | keys for hosted embedding models (see Text search) |
| `NEEDLEDB_MODEL_CACHE` | fastembed default | where local embedding models are downloaded |

## Development

```bash
uv venv && uv pip install -e ".[dev,bench]"
pytest                                   # engine, filters (property-tested), API, both SDKs, Pinecone client
npm --prefix ui install && npm --prefix ui run dev     # web app on :5173/app/, proxied to :8080
npm --prefix ui run build                # outputs to needledb/server/static
scripts/release.sh                       # build sdist + wheel, install into a clean venv, smoke-test
scripts/release.sh --publish             # ...then upload to PyPI (UV_PUBLISH_TOKEN)
```

## Limits and roadmap

This is 0.1:
- one node;
- vectors held in RAM (float32);
- no sparse vectors;
- access control is key-based (roles and index scopes), with no SSO yet.

Next:
- quantized indexes (SQ8/PQ/IVF-PQ) for memory-bound collections;
- memory-mapped snapshots;
- gRPC;
- a TypeScript SDK;
- replication.
