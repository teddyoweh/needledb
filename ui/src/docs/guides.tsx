import { CodeBlock, CodeTabs } from "../code";
import {
  IconFilter,
  IconKey,
  IconRocket,
  IconSearch,
  IconServer,
  IconShield,
  IconTarget,
  IconUpload,
} from "../icons";
import { Accordion, C, Callout, CardGroup, DocCard, DocTable, H2, H3, ORIGIN, Step, Steps } from "./parts";
import type { DocPage } from "./types";

const g = (slug: string) => `#/docs/guides/${slug}`;
const api = (slug: string) => `#/docs/api/${slug}`;
const sdk = (slug: string) => `#/docs/sdk/${slug}`;

export const GUIDES: DocPage[] = [
  // ---- get started ------------------------------------------------------------------
  {
    slug: "introduction",
    title: "Introduction",
    group: "Get started",
    description: "A self-hostable vector database with Pinecone's API, built on FAISS. One process, your hardware, your data.",
    keywords: "overview what is needledb",
    render: () => (
      <>
        <div className="docs-hero">
          <div className="docs-hero-text">
            <b>Pinecone's API on hardware you control</b>
            <p>A REST API, a web app, durable storage and metadata filtering in a single Python process. Bring the official Pinecone client, the NeedleDB SDK, or embed the engine with no server at all.</p>
            <div className="docs-hero-actions">
              <a className="btn btn-primary btn-md" href={g("quickstart")}><IconRocket size={16} />Quickstart</a>
              <a className="btn btn-secondary btn-md" href={api("introduction")}>API reference</a>
            </div>
          </div>
          <CodeBlock lang="python" title="search.py" code={`from needledb import NeedleDB

db = NeedleDB("${ORIGIN}")
index = db.Index("products")

res = index.query(
    vector=embedding,
    top_k=10,
    filter={"brand": {"$in": ["acme", "zenith"]}},
)`} />
        </div>

        <H2 id="why">What you get</H2>
        <ul>
          <li><b>A Pinecone-shaped API.</b> Upsert, query, fetch, update, delete, list, stats and namespaces, with the same JSON and filter grammar. The official <C>pinecone</C> Python client works against a NeedleDB index host unchanged.</li>
          <li><b>Any dimension</b> from 1 to 65,536, with cosine, dot product or euclidean distance.</li>
          <li><b>FAISS underneath.</b> Exact search for small collections, HNSW for large ones, and an <C>auto</C> mode that switches in the background at 20,000 vectors without blocking reads.</li>
          <li><b>Filters that keep their recall.</b> Narrow filters are answered with an exact scan of the matches; wide ones with filtered HNSW and a widened beam.</li>
          <li><b>Durable writes.</b> Every write commits to a SQLite write-ahead log before it's acknowledged. Snapshots make restarts fast.</li>
          <li><b>Secure by default.</b> Scoped, expiring API keys stored only as hashes, signed sessions, brute-force lockout, an audit log and hardened headers.</li>
        </ul>

        <H2 id="start">Where to start</H2>
        <CardGroup>
          <DocCard title="Quickstart" icon={<IconRocket size={18} />} href={g("quickstart")}>Run a server, create an index and search it in five minutes.</DocCard>
          <DocCard title="Self-hosting" icon={<IconServer size={18} />} href={g("self-hosting")}>Docker, configuration and the data directory.</DocCard>
          <DocCard title="Query" icon={<IconSearch size={18} />} href={g("query")}>Nearest-neighbour search by vector or by stored record.</DocCard>
          <DocCard title="Deploying securely" icon={<IconShield size={18} />} href={g("deploying")}>TLS, proxies, keys and a production checklist.</DocCard>
        </CardGroup>

        <H2 id="ways-to-connect">Ways to connect</H2>
        <DocTable head={["Client", "Use it when"]} rows={[
          [<a href={sdk("client")}>NeedleDB SDK</a>, "You want index management, API keys and data operations from Python, with retries and batching."],
          [<a href={g("migrate-from-pinecone")}>Pinecone client</a>, "You already have Pinecone code. Point it at a NeedleDB index host."],
          [<a href={sdk("embedded")}>Embedded mode</a>, "You want the engine inside your process, with no server and no network hop."],
          [<a href={api("introduction")}>REST API</a>, "Any other language, or curl."],
        ]} />

        <Callout kind="note" title="Version 0.1">
          NeedleDB runs on one node and keeps vectors in RAM as float32. Sparse vectors, quantized indexes and replication aren't available yet.
        </Callout>
      </>
    ),
  },
  {
    slug: "quickstart",
    title: "Quickstart",
    group: "Get started",
    description: "Start a server, create an index, insert a few vectors and run a filtered search.",
    keywords: "install getting started first index tutorial",
    render: () => (
      <>
        <Steps>
          <Step title="Install NeedleDB">
            <p>With Python 3.11 to 3.14. FAISS, the server, the web app and the SDK all come with it.</p>
            <CodeTabs tabs={[
              { label: "pip", lang: "bash", code: `pip install needledb` },
              { label: "uv", lang: "bash", code: `uv pip install needledb` },
              { label: "From source", lang: "bash", code: `git clone https://github.com/teddyoweh/needledb
cd needledb && pip install -e .     # builds the web app if Node.js 20.19+ is installed` },
            ]} />
          </Step>
          <Step title="Start the server">
            <p>The server needs an admin key. Generate one and keep it somewhere safe.</p>
            <CodeBlock lang="bash" title="Terminal" code={`export NEEDLEDB_API_KEY=$(openssl rand -hex 32)
needledb serve
# App  http://127.0.0.1:8080/app/
# API  http://127.0.0.1:8080`} />
            <p>Open the app and sign in with the same key to watch your data arrive.</p>
          </Step>
          <Step title="Create an index">
            <p>An index holds vectors of one dimension, compared with one metric. Use your embedding model's dimension; this example uses 8.</p>
            <CodeTabs tabs={[
              { label: "Python", lang: "python", code: `from needledb import NeedleDB

db = NeedleDB("http://127.0.0.1:8080")      # reads NEEDLEDB_API_KEY
db.create_index("quickstart", dimension=8, metric="cosine")
index = db.Index("quickstart")` },
              { label: "cURL", lang: "bash", code: `curl http://127.0.0.1:8080/indexes \\
  -H "Api-Key: $NEEDLEDB_API_KEY" -H "Content-Type: application/json" \\
  -d '{"name": "quickstart", "dimension": 8, "metric": "cosine"}'` },
            ]} />
          </Step>
          <Step title="Upsert vectors">
            <p>Each record has an id, its values and optional metadata. The write is on disk before the call returns.</p>
            <CodeBlock lang="python" title="Python" code={`import numpy as np

rng = np.random.default_rng(7)
index.upsert([
    {"id": "kind-of-blue", "values": rng.random(8).tolist(), "metadata": {"genre": "jazz", "year": 1959}},
    {"id": "led-zeppelin-iv", "values": rng.random(8).tolist(), "metadata": {"genre": "rock", "year": 1971}},
    {"id": "a-love-supreme", "values": rng.random(8).tolist(), "metadata": {"genre": "jazz", "year": 1965}},
])`} />
          </Step>
          <Step title="Query">
            <p>Find the records nearest to a stored one, narrowed to jazz. The record you searched from comes back first.</p>
            <CodeBlock lang="python" title="Python" code={`res = index.query(id="kind-of-blue", top_k=3, include_metadata=True,
                  filter={"genre": "jazz"})
for match in res.matches:
    print(match.id, round(match.score, 3), match.metadata)

print(res.usage.plan)   # "filtered-exact": a narrow filter, answered exactly`} />
          </Step>
        </Steps>

        <Callout kind="tip" title="Experimenting on your own machine?">
          <C>needledb serve --no-auth</C> skips keys entirely. The server refuses that on any address other than localhost.
        </Callout>

        <H2 id="next">Next steps</H2>
        <CardGroup>
          <DocCard title="Upsert at scale" icon={<IconUpload size={18} />} href={g("upsert")}>Batching, NumPy arrays and namespaces.</DocCard>
          <DocCard title="Metadata filtering" icon={<IconFilter size={18} />} href={g("filtering")}>Every operator, and how filtered search keeps its recall.</DocCard>
          <DocCard title="Create scoped keys" icon={<IconKey size={18} />} href={g("authentication")}>Give each app only the access it needs.</DocCard>
          <DocCard title="Explore your vectors" icon={<IconTarget size={18} />} href={g("concepts")}>Indexes, namespaces, records and scores.</DocCard>
        </CardGroup>
      </>
    ),
  },
  {
    slug: "self-hosting",
    title: "Self-hosting",
    group: "Get started",
    description: "Run NeedleDB with Docker or as a Python process, and choose where it keeps its data.",
    keywords: "docker compose install configuration environment variables data directory backup",
    render: () => (
      <>
        <H2 id="docker">Docker</H2>
        <p>The repository ships a Dockerfile and a Compose file. Data lives in a volume, so the container can be replaced freely.</p>
        <CodeBlock lang="bash" title="Terminal" code={`export NEEDLEDB_API_KEY=$(openssl rand -hex 32)
docker compose -f deploy/docker-compose.yml up -d`} />

        <H2 id="process">As a Python process</H2>
        <CodeBlock lang="bash" title="Terminal" code={`needledb serve --data /var/lib/needledb --host 127.0.0.1 --port 8080`} />
        <DocTable head={["Flag", "Default", "What it does"]} rows={[
          [<C>--data</C>, <C>./data</C>, "Data directory. One server process per directory."],
          [<C>--host</C>, <C>127.0.0.1</C>, "Address to bind. Use 0.0.0.0 only behind TLS."],
          [<C>--port</C>, <C>8080</C>, "Port to listen on."],
          [<C>--api-key</C>, "—", "Admin key, if not set in NEEDLEDB_API_KEY. Comma-separate several."],
          [<C>--tls-cert</C>, "—", "Serve HTTPS with this PEM certificate. Needs --tls-key."],
          [<C>--trust-proxy</C>, "off", "Take client address and scheme from X-Forwarded-* headers."],
          [<C>--no-auth</C>, "off", "Accept requests without a key. Localhost only."],
          [<C>--log-level</C>, <C>info</C>, "debug, info, warning or error."],
        ]} />

        <H2 id="configuration">Configuration</H2>
        <p>Every setting can also come from the environment, which is the usual choice for containers.</p>
        <DocTable head={["Variable", "Default", "Meaning"]} rows={[
          [<C>NEEDLEDB_API_KEY</C>, "—", "Comma-separated admin keys. Required unless managed keys exist."],
          [<C>NEEDLEDB_DATA</C>, <C>./data</C>, "Data directory."],
          [<C>NEEDLEDB_HOST</C>, <C>127.0.0.1</C>, "Bind address."],
          [<C>NEEDLEDB_PORT</C>, <C>8080</C>, "Port."],
          [<C>NEEDLEDB_TRUST_PROXY</C>, "off", "Set to 1 behind a TLS-terminating proxy."],
          [<C>NEEDLEDB_SESSION_SECRET</C>, "generated", "Pin the session signing secret."],
          [<C>NEEDLEDB_MAX_BODY_MB</C>, <C>64</C>, "Largest request body accepted."],
          [<C>NEEDLEDB_SNAPSHOT_EVERY</C>, <C>50000</C>, "Writes between automatic snapshots."],
        ]} />

        <H2 id="data-directory">The data directory</H2>
        <p>Each index is one SQLite file holding its records, plus snapshots of its FAISS structures. Keys, the session signing secret and the audit log live in <C>_system/</C>.</p>
        <Callout kind="warning" title="One process per directory">
          Two servers, or a server and an embedded client, must never open the same data directory at the same time.
        </Callout>

        <H2 id="backups">Backups</H2>
        <p>Stop the server (it writes a final snapshot on shutdown) and copy the data directory, or snapshot the volume it lives on. On start, NeedleDB loads the newest snapshot and replays any later writes from SQLite, so a copy of the SQLite files alone is enough to recover every record.</p>

        <H2 id="health">Health checks</H2>
        <p><C>GET /health</C> needs no key and returns <C>{'{"status": "ok"}'}</C>, which suits load balancers and container orchestrators. For monitoring, scrape <a href={api("metrics")}>/metrics</a>.</p>
      </>
    ),
  },

  // ---- concepts ---------------------------------------------------------------------
  {
    slug: "concepts",
    title: "Key concepts",
    group: "Concepts",
    description: "Indexes, namespaces, records and scores — the four ideas the whole API is built from.",
    keywords: "index namespace record metadata score metric host",
    render: () => (
      <>
        <H2 id="indexes">Indexes</H2>
        <p>An index is a named collection of vectors that share a <b>dimension</b> and a <b>metric</b>. Both are fixed when you create it. Names are 1 to 45 lowercase letters, digits and hyphens.</p>
        <p>Every index has a <b>host</b>, <C>{`${ORIGIN}/indexes/<name>`}</C>, which is where data-plane requests go and what you give the Pinecone client.</p>

        <H2 id="namespaces">Namespaces</H2>
        <p>A namespace partitions an index. Queries, fetches and deletes only see one namespace at a time, which makes namespaces a cheap way to separate tenants or datasets. The default namespace is the empty string.</p>
        <p>Namespaces are created by the first upsert into them and removed by <C>deleteAll</C>. Each keeps its own search structure, so a small namespace stays exact even when a large one has moved to HNSW.</p>

        <H2 id="records">Records</H2>
        <p>A record has an <C>id</C> (a string of up to 512 bytes), <C>values</C> (exactly <i>dimension</i> numbers) and optional <C>metadata</C>. Upserting an existing id replaces its values and metadata.</p>
        <H3 id="metadata">Metadata</H3>
        <p>Metadata is a flat JSON object of up to 40 KB. Values can be strings, numbers, booleans or lists of strings, and every field can be <a href={g("filtering")}>filtered</a>.</p>
        <CodeBlock lang="json" title="A record" code={`{
  "id": "sku-8841",
  "values": [0.0132, -0.0271, 0.0448, "…"],
  "metadata": {"title": "Trail running shoe", "brand": "acme", "price": 129, "tags": ["new", "outdoor"]}
}`} />

        <H2 id="scores">Scores</H2>
        <p>Every match carries a score whose meaning depends on the index's metric.</p>
        <DocTable head={["Metric", "Score", "Closer means"]} rows={[
          [<C>cosine</C>, "Cosine similarity, from −1 to 1", "Higher"],
          [<C>dotproduct</C>, "Inner product", "Higher"],
          [<C>euclidean</C>, "Squared euclidean distance", "Lower"],
        ]} />
        <Callout kind="tip">If your embedding model normalises its vectors (most do), cosine and dot product rank results identically. Cosine is the safe default.</Callout>
      </>
    ),
  },
  {
    slug: "architecture",
    title: "Architecture",
    group: "Concepts",
    description: "How a write becomes durable, how a query finds its neighbours, and what happens after a crash.",
    keywords: "design internals faiss sqlite wal snapshot recovery lock",
    render: () => (
      <>
        <pre className="code docs-diagram">{` SDK · Pinecone client · web app · curl
        │  HTTP/JSON (FastAPI, orjson; engine calls run in worker threads)
 Registry ── Index (one per name, one SQLite file) ── Collection (one per namespace)
                                                      ├─ FAISS IndexFlat / IndexHNSWFlat
                                                      ├─ metadata postings + numeric columns
                                                      └─ reader–writer lock`}</pre>

        <H2 id="writes">Writes</H2>
        <p>A write is validated, committed to SQLite in WAL mode, and only then applied in memory under the namespace's write lock. When the call returns, the record survives a crash.</p>
        <p>Deletes and overwrites mark the old slot as a tombstone. Searches skip tombstones with a FAISS <C>IDSelectorBitmap</C>. Once a fifth of the slots are tombstones, a background rebuild compacts them; writes that land during the rebuild are logged and replayed before the swap.</p>

        <H2 id="reads">Reads</H2>
        <p>Queries take the namespace's read lock and run concurrently. FAISS releases Python's GIL while it searches, so one process uses every core.</p>
        <p>Metadata filters become a bitmask over slots. Equality comes from postings lists (value to slots); ranges come from a float column per numeric field, evaluated vectorised.</p>

        <H2 id="snapshots">Snapshots and recovery</H2>
        <p>Every 50,000 writes and on shutdown, NeedleDB writes the FAISS index and its slot tables to disk, tagged with the log sequence number. On start it loads the snapshot and replays only the newer rows. A damaged snapshot falls back to a full rebuild from SQLite.</p>

        <H2 id="security-layer">The security layer</H2>
        <p>One middleware in front of every route adds security headers, caps the request body, authenticates the key or session, refuses cross-site cookie writes, applies the brute-force lockout, and records metrics.</p>
      </>
    ),
  },
  {
    slug: "index-structures",
    title: "Index structures",
    group: "Concepts",
    description: "Choose between exact and approximate search, and tune HNSW for your recall and latency targets.",
    keywords: "hnsw flat auto ef_search ef_construction m recall memory tuning",
    render: () => (
      <>
        <H2 id="choosing">Choosing a structure</H2>
        <DocTable head={["index_type", "How it searches", "Use it when"]} rows={[
          [<C>auto</C>, "Exact until a namespace holds 20,000 vectors, then HNSW, built in the background and swapped in", "You don't want to think about it (the default)"],
          [<C>flat</C>, "Always exact: 100% recall", "Under about 50,000 vectors, or recall must be perfect"],
          [<C>hnsw</C>, "HNSW graph from the first vector", "Large collections where latency matters most"],
        ]} />
        <p>The structure is fixed at creation. To change it, create a new index and upsert into it.</p>

        <H2 id="hnsw">HNSW parameters</H2>
        <DocTable head={["Parameter", "Default", "Range", "Effect"]} rows={[
          [<C>m</C>, "32", "4–128", "Links per node. Higher improves recall and uses more memory. Fixed at creation."],
          [<C>ef_construction</C>, "200", "16–2,000", "Candidates considered while building. Higher builds a better graph, more slowly."],
          [<C>ef_search</C>, "128", "1–10,000", "Candidates explored per query. Higher finds more true neighbours and takes longer."],
        ]} />

        <H2 id="tuning">Tuning ef_search</H2>
        <p><C>ef_search</C> is the one knob you can change at any time, for the whole index or for a single query.</p>
        <CodeTabs tabs={[
          { label: "Whole index", lang: "python", code: `db.configure_index("products", ef_search=256)` },
          { label: "One query", lang: "python", code: `index.query(vector=embedding, top_k=10, ef_search=512)` },
        ]} />
        <Steps>
          <Step title="Measure recall">Run a sample of queries against a <C>flat</C> copy of the index for ground truth, and compare the ids.</Step>
          <Step title="Raise ef_search until recall is enough">Double it each time. Recall climbs fast, then flattens.</Step>
          <Step title="Keep it at least top_k">Values below <C>top_k</C> return fewer good matches.</Step>
        </Steps>

        <H2 id="memory">Memory</H2>
        <p>Vectors take 4 bytes per dimension. An HNSW graph adds about <C>m × 8.4</C> bytes per vector: roughly 270 bytes at the default <C>m</C> of 32.</p>
        <DocTable head={["Vectors", "Dimension", "Flat", "HNSW, m = 32"]} rows={[
          ["1 million", "768", "≈ 3.1 GB", "≈ 3.3 GB"],
          ["1 million", "1,536", "≈ 6.1 GB", "≈ 6.4 GB"],
          ["1 million", "3,072", "≈ 12.3 GB", "≈ 12.6 GB"],
        ]} />
      </>
    ),
  },
  {
    slug: "performance",
    title: "Performance",
    group: "Concepts",
    description: "Practical ways to load faster, query faster and keep an eye on both.",
    keywords: "speed latency throughput bulk load benchmark tuning",
    render: () => (
      <>
        <H2 id="loading">Loading data</H2>
        <ul>
          <li>Use <a href={sdk("index")}><C>upsert_arrays</C></a> with a NumPy matrix. It skips building a Python dict per record.</li>
          <li>Send large batches. The SDK batches for you (500 records per request over HTTP, 10,000 embedded); the REST limit is 10,000 records and 64 MB per request.</li>
          <li>For the initial load of a very large collection, <a href={sdk("embedded")}>embedded mode</a> avoids HTTP entirely. Close it, then start a server on the same directory.</li>
        </ul>

        <H2 id="querying">Querying</H2>
        <ul>
          <li>Leave <C>include_values</C> off unless you need the vectors back. Large vectors dominate response size.</li>
          <li>Tune <a href={g("index-structures")}><C>ef_search</C></a> to the lowest value that meets your recall target.</li>
          <li>Keep <C>top_k</C> as small as your application allows.</li>
          <li>Split independent datasets into namespaces. Each is searched on its own.</li>
        </ul>

        <H2 id="concurrency">Concurrency</H2>
        <p>Queries run in worker threads and FAISS releases the GIL, so throughput scales with cores. Writes to a namespace briefly take its write lock; heavy ingestion into the same namespace you're querying will add tail latency.</p>

        <H2 id="measuring">Measuring</H2>
        <p>The app's overview shows live requests per second and p50/p99 per index. For dashboards and alerts, scrape <a href={api("metrics")}>/metrics</a> with Prometheus. Every query response also reports its own <C>usage.latencyMs</C> and <C>usage.plan</C>.</p>
        <Callout kind="note" title="Benchmarks">
          The repository's <C>bench/REPORT.md</C> compares NeedleDB with raw FAISS, Qdrant and pgvector on real OpenAI embeddings, with recall reported next to every speed figure.
        </Callout>
      </>
    ),
  },

  // ---- working with data --------------------------------------------------------------
  {
    slug: "upsert",
    title: "Upsert",
    group: "Working with data",
    description: "Insert new records or overwrite existing ones, one at a time or millions at once.",
    keywords: "insert write add vectors batch bulk numpy namespace",
    render: () => (
      <>
        <H2 id="format">Record format</H2>
        <p>Pass records as objects, or as <C>(id, values)</C> and <C>(id, values, metadata)</C> tuples in Python.</p>
        <CodeTabs tabs={[
          { label: "Python", lang: "python", code: `index.upsert([
    {"id": "sku-1", "values": embedding, "metadata": {"brand": "acme", "price": 49}},
    ("sku-2", other_embedding, {"brand": "zenith", "price": 120}),
    ("sku-3", third_embedding),
], namespace="catalog")` },
          { label: "cURL", lang: "bash", code: `curl ${ORIGIN}/indexes/products/vectors/upsert \\
  -H "Api-Key: $NEEDLEDB_API_KEY" -H "Content-Type: application/json" \\
  -d '{"namespace": "catalog", "vectors": [
        {"id": "sku-1", "values": [0.01, 0.02, 0.03], "metadata": {"brand": "acme", "price": 49}}
      ]}'` },
        ]} />

        <H2 id="bulk">Bulk loading from arrays</H2>
        <p>For large loads, hand the SDK an <i>n × d</i> array. It converts to float32 once and sends batches.</p>
        <CodeBlock lang="python" title="Python" code={`ids = [f"doc-{i}" for i in range(len(embeddings))]
metadata = [{"title": t} for t in titles]
index.upsert_arrays(ids, embeddings, metadata, batch_size=2000)`} />

        <H2 id="overwrites">Overwrites</H2>
        <p>Upserting an id that already exists replaces both its values and its metadata. To change only some metadata fields, use <a href={g("manage-records")}>update</a>.</p>

        <H2 id="durability">Durability</H2>
        <p>An upsert returns after the batch is committed to disk. A batch is all or nothing: if one record is invalid, none are written and the error names the problem.</p>

        <H2 id="limits">Limits</H2>
        <DocTable head={["Limit", "Value"]} rows={[
          ["Records per request", "10,000"],
          ["Request body", "64 MB (NEEDLEDB_MAX_BODY_MB)"],
          ["Id length", "512 bytes"],
          ["Metadata per record", "40 KB of JSON"],
          ["Namespace name", "256 bytes"],
        ]} />
      </>
    ),
  },
  {
    slug: "query",
    title: "Query",
    group: "Working with data",
    description: "Find the nearest neighbours of a vector or a stored record, optionally narrowed by metadata.",
    keywords: "search similarity nearest neighbours top_k ann",
    render: () => (
      <>
        <H2 id="by-vector">By vector</H2>
        <CodeTabs tabs={[
          { label: "Python", lang: "python", code: `res = index.query(vector=embedding, top_k=10, include_metadata=True)
for match in res.matches:
    print(match.id, match.score, match.metadata)` },
          { label: "cURL", lang: "bash", code: `curl ${ORIGIN}/indexes/products/query \\
  -H "Api-Key: $NEEDLEDB_API_KEY" -H "Content-Type: application/json" \\
  -d '{"vector": [0.01, 0.02, 0.03], "topK": 10, "includeMetadata": true}'` },
        ]} />

        <H2 id="by-id">By stored record</H2>
        <p>Search from a record already in the index, with no need to fetch its vector first. The record itself is included in the results.</p>
        <CodeBlock lang="python" title="Python" code={`index.query(id="sku-1", top_k=6, include_metadata=True)`} />

        <H2 id="options">Options</H2>
        <DocTable head={["Option", "Default", ""]} rows={[
          [<C>top_k</C>, "10", "How many matches to return, from 1 to 10,000."],
          [<C>namespace</C>, "default", "The namespace to search."],
          [<C>filter</C>, "none", <>A <a href={g("filtering")}>metadata filter</a>.</>],
          [<C>include_metadata</C>, "false", "Return each match's metadata."],
          [<C>include_values</C>, "false", "Return each match's vector."],
          [<C>ef_search</C>, "index setting", "HNSW search width for this query only."],
        ]} />

        <H2 id="response">The response</H2>
        <CodeBlock lang="json" title="Response" code={`{
  "matches": [
    {"id": "sku-1", "score": 0.9321, "metadata": {"brand": "acme", "price": 49}},
    {"id": "sku-7", "score": 0.9107, "metadata": {"brand": "acme", "price": 64}}
  ],
  "namespace": "",
  "usage": {"latencyMs": 1.84, "plan": "hnsw"}
}`} />

        <H2 id="plans">Query plans</H2>
        <p>Every response says how it was answered, so you can see what a filter did.</p>
        <DocTable head={["plan", "Meaning"]} rows={[
          [<C>exact</C>, "A full scan of the namespace. 100% recall."],
          [<C>hnsw</C>, "An HNSW graph search."],
          [<C>filtered-exact</C>, "The filter was narrow, so only its matches were scanned, exactly."],
          [<C>filtered-hnsw</C>, "The filter was wide, so the graph was searched with the filter applied and a widened beam."],
          [<C>empty</C>, "The namespace doesn't exist yet."],
        ]} />
      </>
    ),
  },
  {
    slug: "filtering",
    title: "Metadata filtering",
    group: "Working with data",
    description: "Narrow any query, delete or count to records whose metadata matches — with Pinecone's filter grammar.",
    keywords: "filter where $eq $in $gt $and $or metadata conditions",
    render: () => (
      <>
        <H2 id="operators">Operators</H2>
        <DocTable head={["Operator", "Matches when the field", "Example"]} rows={[
          [<C>$eq</C>, "equals the value", <C>{`{"brand": {"$eq": "acme"}}`}</C>],
          [<C>$ne</C>, "doesn't equal the value, or is missing", <C>{`{"brand": {"$ne": "acme"}}`}</C>],
          [<C>$gt $gte $lt $lte</C>, "is a number in range", <C>{`{"price": {"$lte": 100}}`}</C>],
          [<C>$in</C>, "equals any listed value", <C>{`{"brand": {"$in": ["acme", "zenith"]}}`}</C>],
          [<C>$nin</C>, "equals none of them, or is missing", <C>{`{"tier": {"$nin": ["gold"]}}`}</C>],
          [<C>$exists</C>, "is present (true) or absent (false)", <C>{`{"discount": {"$exists": true}}`}</C>],
          [<C>$and $or</C>, "combines filters", <C>{`{"$or": [{"a": 1}, {"b": 2}]}`}</C>],
        ]} />
        <p>A bare value is shorthand for <C>$eq</C>, and several fields in one object must all match.</p>

        <H2 id="examples">Examples</H2>
        <CodeBlock lang="python" title="Python" code={`# In stock, under $100, from either brand
index.query(vector=q, top_k=10, filter={
    "in_stock": True,
    "price": {"$lt": 100},
    "brand": {"$in": ["acme", "zenith"]},
})

# Tagged "sale", or any shoe
index.query(vector=q, top_k=10, filter={
    "$or": [{"tags": "sale"}, {"category": "shoes"}],
})`} />

        <H2 id="lists">List fields</H2>
        <p>When a field holds a list of strings, <C>$eq</C> and <C>$in</C> match if <i>any</i> element matches. <C>{`{"tags": "sale"}`}</C> matches a record tagged <C>["new", "sale"]</C>.</p>

        <H2 id="missing">Missing fields</H2>
        <p><C>$ne</C> and <C>$nin</C> are the exact opposites of <C>$eq</C> and <C>$in</C>, so they also match records that don't have the field. Add <C>{`{"$exists": true}`}</C> if you need the field present.</p>

        <H2 id="recall">How filtered search keeps its recall</H2>
        <p>Approximate indexes often lose results under a narrow filter: the graph finds ten neighbours, and none of them pass. NeedleDB checks how many records match first.</p>
        <ul>
          <li>If only a small number match, it scans those records exactly (<C>filtered-exact</C>), which is both fast and perfect.</li>
          <li>Otherwise it searches the HNSW graph with the filter applied and a wider beam (<C>filtered-hnsw</C>).</li>
        </ul>
        <Callout kind="tip">Filters also work with <a href={g("manage-records")}>delete</a> and <a href={api("describe-index-stats")}>describe_index_stats</a>, to remove or count matching records.</Callout>
      </>
    ),
  },
  {
    slug: "manage-records",
    title: "Manage records",
    group: "Working with data",
    description: "Fetch, update, delete, list and count the records in an index.",
    keywords: "fetch update delete list pagination stats count",
    render: () => (
      <>
        <H2 id="fetch">Fetch</H2>
        <p>Read up to 1,000 records by id. Ids that don't exist are left out of the response.</p>
        <CodeBlock lang="python" title="Python" code={`res = index.fetch(["sku-1", "sku-2"], namespace="catalog")
print(res.vectors["sku-1"].metadata)`} />

        <H2 id="update">Update</H2>
        <p>Replace a record's values, merge fields into its metadata, or both. Fields you don't mention are kept.</p>
        <CodeBlock lang="python" title="Python" code={`index.update("sku-1", set_metadata={"price": 39, "on_sale": True})
index.update("sku-1", values=new_embedding)`} />

        <H2 id="delete">Delete</H2>
        <p>Give exactly one of a list of ids, a filter, or <C>delete_all</C>.</p>
        <CodeBlock lang="python" title="Python" code={`index.delete(ids=["sku-1", "sku-2"])
index.delete(filter={"discontinued": True})
index.delete(delete_all=True, namespace="staging")   # removes the namespace`} />
        <Callout kind="warning">Deletes are permanent. There's no trash.</Callout>

        <H2 id="list">List ids</H2>
        <p>Page through ids in sorted order, optionally by prefix. Prefixes make hierarchical ids like <C>doc-42#chunk-3</C> easy to manage.</p>
        <CodeBlock lang="python" title="Python" code={`for ids in index.list(prefix="doc-42#"):
    index.delete(ids=ids)`} />

        <H2 id="count">Count</H2>
        <CodeBlock lang="python" title="Python" code={`stats = index.describe_index_stats()
print(stats.total_vector_count, stats.namespaces)

index.describe_index_stats(filter={"brand": "acme"}).total_vector_count`} />
      </>
    ),
  },

  // ---- security --------------------------------------------------------------------
  {
    slug: "authentication",
    title: "Authentication",
    group: "Security",
    description: "API keys, roles and index scopes: give every app and person exactly the access they need.",
    keywords: "api key role scope read write admin expiry revoke lockout brute force",
    render: () => (
      <>
        <H2 id="sending">Sending a key</H2>
        <p>Every route except <C>/health</C> needs a key, in either header:</p>
        <CodeBlock lang="bash" title="Headers" code={`Api-Key: ndb_…
Authorization: Bearer ndb_…`} />
        <p>The SDK and the Pinecone client send it for you. The web app exchanges it for a <a href={g("sessions")}>session</a>.</p>

        <H2 id="roles">Roles</H2>
        <DocTable head={["Role", "Can"]} rows={[
          [<span className="role role-read">Read</span>, "Query, fetch and list vectors; read index stats, the vector map, /stats and /metrics."],
          [<span className="role role-write">Read & write</span>, "Everything above, plus upsert, update and delete vectors."],
          [<span className="role role-admin">Admin</span>, "Everything, including creating and deleting indexes, managing keys and reading the audit log."],
        ]} />

        <H2 id="scopes">Index scopes</H2>
        <p>Read and write keys can be limited to named indexes. To a scoped key, other indexes look like they don't exist. Admin keys always cover every index.</p>

        <H2 id="creating">Creating keys</H2>
        <p>Keys set in <C>NEEDLEDB_API_KEY</C> are admin keys for bootstrapping. Create a managed key for everything else.</p>
        <CodeTabs tabs={[
          { label: "Python", lang: "python", code: `key = db.create_key("search-api", role="read", indexes=["products"], expires_in_days=90)
print(key.key)      # shown once` },
          { label: "CLI", lang: "bash", code: `needledb keys create --name search-api --role read --index products --expires-days 90` },
          { label: "cURL", lang: "bash", code: `curl ${ORIGIN}/keys -H "Api-Key: $ADMIN_KEY" -H "Content-Type: application/json" \\
  -d '{"name": "search-api", "role": "read", "indexes": ["products"], "expiresInDays": 90}'` },
        ]} />
        <Callout kind="note" title="Shown once, stored as a hash">
          NeedleDB keeps only a SHA-256 digest of each key. If a key is lost, revoke it and create another.
        </Callout>

        <H2 id="expiry">Expiry and revocation</H2>
        <p>A key can expire after 1 to 3,650 days. Expired and revoked keys stop working immediately, and any web-app sessions opened with them end.</p>

        <H2 id="lockout">Brute-force protection</H2>
        <p>Ten failed attempts from one address within five minutes block that address for five minutes, on the API and the sign-in page alike. Blocked requests get <C>429</C> with a <C>Retry-After</C> header, and each block is written to the <a href={g("audit-log")}>audit log</a>.</p>

        <H2 id="local">Local development</H2>
        <p><C>needledb serve --no-auth</C> accepts requests without a key, as an admin. It only starts on a loopback address.</p>
      </>
    ),
  },
  {
    slug: "sessions",
    title: "Sessions",
    group: "Security",
    description: "How signing in to the web app works, and why the key never reaches the browser's storage.",
    keywords: "cookie csrf sign in web app session secret",
    render: () => (
      <>
        <H2 id="sign-in">Signing in</H2>
        <p>The sign-in page posts the key once to <a href={api("sign-in")}>/auth/login</a>. The server checks it and sets a signed cookie that names the key but doesn't contain it. The browser never stores the key.</p>

        <H2 id="cookie">The cookie</H2>
        <DocTable head={["Property", "Value"]} rows={[
          ["Name", <C>needledb_session</C>],
          ["Lifetime", "12 hours"],
          ["HttpOnly", "Yes. Page scripts can't read it."],
          ["SameSite", "Strict. Other sites can't send it."],
          ["Secure", "Over HTTPS."],
          ["Signature", "HMAC with the server's session secret."],
        ]} />

        <H2 id="csrf">Cross-site requests</H2>
        <p>A write authenticated by the cookie must come from the server's own origin; anything else gets <C>403</C>. API clients using a key header aren't affected.</p>

        <H2 id="ending">Ending sessions</H2>
        <ul>
          <li><b>Sign out</b> ends the current session.</li>
          <li><b>Revoking a key</b> ends every session opened with it.</li>
          <li><b>End all sessions</b> on the Security page rotates the signing secret, which signs everyone out, including you.</li>
        </ul>

        <H2 id="secret">The signing secret</H2>
        <p>The secret is generated on first start and kept in <C>_system/session.key</C> with owner-only permissions. Set <C>NEEDLEDB_SESSION_SECRET</C> to pin it instead, for example when the data directory is rebuilt from backups.</p>
      </>
    ),
  },
  {
    slug: "deploying",
    title: "Deploying securely",
    group: "Security",
    description: "Put NeedleDB on a network without putting your vectors at risk.",
    keywords: "production tls https proxy caddy nginx checklist firewall",
    render: () => (
      <>
        <H2 id="checklist">Checklist</H2>
        <Steps>
          <Step title="Serve over HTTPS">Keys travel in headers. Terminate TLS in NeedleDB or in a proxy in front of it.</Step>
          <Step title="Bind privately">Keep <C>--host 127.0.0.1</C> behind a proxy, or restrict the port with a firewall.</Step>
          <Step title="Use managed keys">Keep the environment key for administration. Give each app its own scoped, expiring key.</Step>
          <Step title="Watch the audit log">Repeated failures from one address show up on the Security page.</Step>
          <Step title="Back up the data directory">See <a href={g("self-hosting")}>backups</a>.</Step>
        </Steps>

        <H2 id="tls">TLS in NeedleDB</H2>
        <CodeBlock lang="bash" title="Terminal" code={`needledb serve --host 0.0.0.0 --port 443 \\
  --tls-cert /etc/needledb/cert.pem --tls-key /etc/needledb/key.pem`} />

        <H2 id="proxy">Behind a proxy</H2>
        <p>Run NeedleDB on localhost with <C>--trust-proxy</C>, so client addresses (used by the lockout and audit log) and the HTTPS scheme come from the proxy's headers.</p>
        <CodeTabs tabs={[
          { label: "Caddy", lang: "bash", code: `# Caddyfile — certificates are automatic
vectors.example.com {
    reverse_proxy 127.0.0.1:8080
}` },
          { label: "nginx", lang: "bash", code: `server {
    listen 443 ssl;
    server_name vectors.example.com;
    ssl_certificate     /etc/ssl/vectors.pem;
    ssl_certificate_key /etc/ssl/vectors.key;
    client_max_body_size 64m;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}` },
          { label: "NeedleDB", lang: "bash", code: `needledb serve --host 127.0.0.1 --port 8080 --trust-proxy` },
        ]} />
        <Callout kind="danger" title="Only trust a proxy you run">
          With <C>--trust-proxy</C>, NeedleDB believes <C>X-Forwarded-For</C>. If clients can reach the server directly, they can forge their address and dodge the lockout.
        </Callout>

        <H2 id="headers">What the server enforces</H2>
        <DocTable head={["Protection", "Detail"]} rows={[
          ["Content Security Policy", "Scripts, styles and connections only from the server itself."],
          ["Framing", "Refused, so the app can't be embedded for clickjacking."],
          ["MIME sniffing", "Disabled with X-Content-Type-Options: nosniff."],
          ["Referrers", "Never sent."],
          ["Caching", "API responses are marked no-store."],
          ["HSTS", "Sent over HTTPS."],
          ["Body size", "Larger than 64 MB is refused before it's read."],
          ["API explorer", "/docs needs a key or a session."],
        ]} />
      </>
    ),
  },
  {
    slug: "audit-log",
    title: "Audit log",
    group: "Security",
    description: "A record of every sign-in, rejected key and change to indexes and keys.",
    keywords: "events history security log export csv",
    render: () => (
      <>
        <H2 id="events">What's recorded</H2>
        <DocTable head={["Action", "When"]} rows={[
          [<C>auth.signed_in</C>, "Someone signed in to the web app."],
          [<C>auth.sign_in_failed</C>, "A sign-in used an invalid key."],
          [<C>auth.key_rejected</C>, "An API request used an invalid key."],
          [<C>auth.blocked</C>, "An address hit the lockout."],
          [<C>auth.signed_out</C>, "A session was ended."],
          [<C>auth.sessions_revoked</C>, "An admin ended every session."],
          [<C>key.created</C>, "A key was created (its secret is never logged)."],
          [<C>key.revoked</C>, "A key was revoked."],
          [<C>index.created</C>, "An index was created."],
          [<C>index.configured</C>, "An index's ef_search changed."],
          [<C>index.deleted</C>, "An index was deleted."],
        ]} />
        <p>Each event records who acted, from which address, the target, and whether it succeeded. Queries and writes aren't logged here; they're counted in <a href={api("metrics")}>metrics</a>.</p>

        <H2 id="reading">Reading the log</H2>
        <p>Admins see the log on the Security page, where it can be searched, filtered to failures, and exported as CSV. Or read it from the API:</p>
        <CodeBlock lang="bash" title="Terminal" code={`curl "${ORIGIN}/events?limit=100" -H "Api-Key: $ADMIN_KEY"`} />

        <H2 id="retention">Retention</H2>
        <p>The log lives in <C>_system/audit.sqlite</C> and keeps the most recent 20,000 events. Export regularly, or ship it to your log system, if you need longer history.</p>
      </>
    ),
  },

  // ---- migrate -----------------------------------------------------------------------
  {
    slug: "migrate-from-pinecone",
    title: "Migrate from Pinecone",
    group: "Migrate",
    description: "Keep your Pinecone code, copy your vectors, and know the few places the two differ.",
    keywords: "pinecone migration compatibility client import export",
    render: () => (
      <>
        <H2 id="client">Keep your client</H2>
        <p>The official Pinecone Python client works with a NeedleDB index host. Only the connection changes:</p>
        <CodeBlock lang="python" title="Python" code={`from pinecone import Pinecone

pc = Pinecone(api_key=NEEDLEDB_API_KEY)                  # a NeedleDB key
index = pc.Index(host="${ORIGIN}/indexes/products")

index.upsert(vectors=[("sku-1", embedding, {"brand": "acme"})])
index.query(vector=embedding, top_k=10, include_metadata=True, filter={"brand": "acme"})`} />
        <Callout kind="note">Create and delete indexes with the <a href={sdk("client")}>NeedleDB SDK</a>, the web app or the REST API. The Pinecone client's control-plane calls talk to Pinecone's own service.</Callout>

        <H2 id="copy">Copy your data</H2>
        <Steps>
          <Step title="Create a matching index">
            <p>Use the same dimension and metric as the Pinecone index.</p>
            <CodeBlock lang="python" title="Python" code={`db.create_index("products", dimension=1536, metric="cosine")`} />
          </Step>
          <Step title="Stream every namespace across">
            <CodeBlock lang="python" title="Python" code={`from needledb import NeedleDB
from pinecone import Pinecone

source = Pinecone(api_key=PINECONE_API_KEY).Index("products")
target = NeedleDB("${ORIGIN}").Index("products")

for namespace in source.describe_index_stats().namespaces:
    for ids in source.list(namespace=namespace):
        page = source.fetch(ids=ids, namespace=namespace)
        target.upsert([
            {"id": v.id, "values": v.values, "metadata": v.metadata}
            for v in page.vectors.values()
        ], namespace=namespace)`} />
          </Step>
          <Step title="Check the counts">
            <CodeBlock lang="python" title="Python" code={`print(source.describe_index_stats().total_vector_count)
print(target.describe_index_stats().total_vector_count)`} />
          </Step>
          <Step title="Point your app at NeedleDB">Swap the host and key in your configuration.</Step>
        </Steps>

        <H2 id="differences">Differences</H2>
        <DocTable head={["", "Pinecone", "NeedleDB"]} rows={[
          ["Hosting", "Managed service", "Your own server, container or process"],
          ["Sparse and hybrid vectors", "Supported", "Not yet"],
          ["Scaling", "Serverless or pods", "One node; vectors held in RAM"],
          ["indexFullness", "Reported", "Always 0"],
          ["Index management", "api.pinecone.io", "The NeedleDB server itself"],
          ["Structure", "Managed", <>Your choice of <a href={g("index-structures")}>flat, HNSW or auto</a></>],
        ]} />

        <Accordion title="Does the filter syntax change?">
          No. NeedleDB implements the same operators with the same semantics, including list fields and <C>$ne</C> matching missing fields.
        </Accordion>
        <Accordion title="Do scores match Pinecone's?">
          For cosine and dot product, yes. For euclidean, NeedleDB reports squared distance, so smaller is closer.
        </Accordion>
        <Accordion title="Can I use Pinecone's gRPC client?">
          Not yet. Use the HTTP client.
        </Accordion>
      </>
    ),
  },
];
