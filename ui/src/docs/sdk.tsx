import type { ReactNode } from "react";
import { CodeBlock, CodeTabs } from "../code";
import { IconCode, IconServer, IconSparkles } from "../icons";
import { C, Callout, CardGroup, DocCard, DocTable, type Field, Fields, H2, ORIGIN, Step, Steps } from "./parts";
import type { DocPage } from "./types";

/** A method: its signature, what it does, its parameters and an example. */
function Signature({ id, name, sig, children, params, example }: {
  id: string;
  name: string;
  sig: string;
  children: ReactNode;
  params?: Field[];
  example?: string;
}) {
  return (
    <section className="sig">
      <H2 id={id}>{name}</H2>
      <pre className="sig-code"><code>{sig}</code></pre>
      <div className="sig-about">{children}</div>
      {params && params.length > 0 && <Fields title="Parameters" fields={params} />}
      {example && <CodeBlock lang="python" title="Example" code={example} />}
    </section>
  );
}

const NS: Field = { name: "namespace", type: "str | None", defaultValue: "None", description: "The namespace. None means the default namespace." };
const FILTER: Field = { name: "filter", type: "dict | None", defaultValue: "None", description: <>A <a href="#/docs/guides/filtering">metadata filter</a>.</> };

export const SDK: DocPage[] = [
  {
    slug: "overview",
    title: "Python SDK",
    group: "Get started",
    description: "Search by text or vector, load data in bulk, and manage indexes — from scripts, async apps, or with the engine embedded.",
    keywords: "install python client import quickstart AsyncNeedleDB asyncio search text",
    render: () => (
      <>
        <H2 id="install">Install</H2>
        <CodeBlock lang="bash" title="Terminal" code={`pip install needledb                 # Python 3.11–3.14
pip install "needledb[local]"         # adds local embedding models`} />

        <H2 id="quickstart">Search your own text</H2>
        <p>Give an index an embedding model, send it plain text, and search in natural language. The server embeds both sides with the same model.</p>
        <Steps>
          <Step title="Connect and create an index">
            <CodeBlock lang="python" title="Python" code={`from needledb import NeedleDB

db = NeedleDB("${ORIGIN}", api_key="ndb_…")     # or NEEDLEDB_URL and NEEDLEDB_API_KEY
db.create_index(
    "products",
    embed={"provider": "openai", "model": "text-embedding-3-small"},
    exist_ok=True,
)
index = db.Index("products")`} />
            <p><C>exist_ok=True</C> makes the script safe to run again: an existing index of the same shape is reused.</p>
          </Step>
          <Step title="Add text">
            <CodeBlock lang="python" title="Python" code={`index.upsert_texts(
    ["Waterproof hiking boots for muddy trails", "Cast iron skillet for searing steak"],
    ids=["sku-1", "sku-2"],
    metadata=[{"price": 129}, {"price": 45}],
)`} />
            <p>Leave out <C>ids</C> and each record gets a stable id made from its text, so loading the same text twice doesn't duplicate it.</p>
          </Step>
          <Step title="Search">
            <CodeBlock lang="python" title="Python" code={`res = index.search("shoes for rainy hikes", top_k=5, filter={"price": {"$lt": 150}})
for match in res.matches:
    print(f"{match.score:.3f}", match.id, match.metadata.text)`} />
            <p>Pass a string to search by meaning, or a vector to search by vector. Metadata comes back by default.</p>
          </Step>
        </Steps>

        <H2 id="clients">Choose a client</H2>
        <CardGroup cols={3}>
          <DocCard title="NeedleDB" icon={<IconServer size={18} />} href="#/docs/sdk/client">A server over HTTP, with pooled connections, retries and batching.</DocCard>
          <DocCard title="AsyncNeedleDB" icon={<IconSparkles size={18} />} href="#/docs/sdk/async">The same methods, awaited — for FastAPI, workers and parallel loads.</DocCard>
          <DocCard title="NeedleDBLocal" icon={<IconCode size={18} />} href="#/docs/sdk/embedded">The engine inside your process. No server, no network.</DocCard>
        </CardGroup>
        <CodeTabs tabs={[
          { label: "Sync", lang: "python", code: `from needledb import NeedleDB

with NeedleDB("${ORIGIN}") as db:
    res = db.Index("products").search("waterproof boots")` },
          { label: "Async", lang: "python", code: `from needledb import AsyncNeedleDB

async with AsyncNeedleDB("${ORIGIN}") as db:
    res = await db.Index("products").search("waterproof boots")` },
          { label: "Embedded", lang: "python", code: `from needledb import NeedleDBLocal

with NeedleDBLocal("./vectors") as db:
    res = db.Index("products").search("waterproof boots")` },
        ]} />

        <H2 id="tasks">Common tasks</H2>
        <DocTable head={["To", "Call"]} rows={[
          ["Search by meaning", <C>index.search("text")</C>],
          ["Search by vector, or from a stored record", <><C>index.search(vector)</C> · <C>index.query(id="sku-1")</C></>],
          ["Add text", <C>index.upsert_texts(texts, ids=None, metadata=None)</C>],
          ["Add vectors", <><C>index.upsert(records)</C> · <C>index.upsert_arrays(ids, matrix)</C></>],
          ["Read one record", <C>index.get("sku-1")</C>],
          ["Walk every record", <C>for record in index.scan(): …</C>],
          ["Count records", <C>index.count(filter=…)</C>],
          ["Change or remove", <><C>index.update(id, set_metadata=…)</C> · <C>index.delete(filter=…)</C></>],
          ["See the index's settings", <C>index.describe()</C>],
        ]} />

        <H2 id="results">Results</H2>
        <p>Methods return <C>Obj</C>, a dict whose keys also read as attributes. The API's camelCase fields read in snake_case too.</p>
        <CodeBlock lang="python" title="Python" code={`res = index.search("waterproof boots", top_k=3)
res.matches[0].id, res.matches[0].score, res.matches[0].metadata.text
res.usage.latency_ms == res["usage"]["latencyMs"]       # True

record = index.get("sku-1")
record.values[:3], record.metadata.price`} />

        <Callout kind="note" title="Pinecone-shaped">
          <C>query</C>, <C>upsert</C>, <C>fetch</C>, <C>update</C>, <C>delete</C>, <C>list</C> and <C>describe_index_stats</C> take the same arguments as Pinecone's Python SDK, so most code moves across by changing the import. <C>search</C>, <C>upsert_texts</C>, <C>get</C>, <C>scan</C>, <C>count</C> and <C>describe</C> are NeedleDB additions.
        </Callout>
      </>
    ),
  },
  {
    slug: "client",
    title: "NeedleDB client",
    group: "Reference",
    description: "Connect to a server, manage indexes and keys, and open indexes.",
    keywords: "NeedleDB create_index exist_ok list_indexes describe_index delete_index create_key revoke_key",
    render: () => (
      <>
        <Signature id="constructor" name="NeedleDB()" sig={`NeedleDB(url=None, api_key=None, *, timeout=30.0, retries=3, client=None, binary_vectors=True)`}
          params={[
            { name: "url", type: "str | None", defaultValue: "NEEDLEDB_URL", description: <>Server address. Falls back to <C>NEEDLEDB_URL</C>, then <C>http://localhost:8080</C>.</> },
            { name: "api_key", type: "str | None", defaultValue: "NEEDLEDB_API_KEY", description: "The key to send with every request." },
            { name: "timeout", type: "float", defaultValue: "30.0", description: "Seconds before a request fails." },
            { name: "retries", type: "int", defaultValue: "3", description: "Retries for connection errors and 502, 503 and 504, with exponential backoff." },
            { name: "client", type: "httpx.Client | None", defaultValue: "None", description: "Bring your own configured httpx client, for proxies or custom TLS." },
            { name: "binary_vectors", type: "bool", defaultValue: "True", description: "Send vectors as base64 float32 — a quarter of the size of JSON. Set False for servers older than 0.2." },
          ]}
          example={`from needledb import NeedleDB

with NeedleDB("${ORIGIN}") as db:       # closes connections on exit
    print(db.health())`}>
          <p>Connections are pooled and kept alive. Use it as a context manager, or call <C>close()</C>. For asyncio code, <a href="#/docs/sdk/async">AsyncNeedleDB</a> has the same methods.</p>
        </Signature>

        <Signature id="create_index" name="create_index" sig={`db.create_index(name, dimension=None, metric="cosine", index_type="auto", hnsw=None, embed=None, *, exist_ok=False) -> Obj`}
          params={[
            { name: "name", type: "str", required: true, description: "1–45 lowercase letters, digits and hyphens." },
            { name: "dimension", type: "int | None", defaultValue: "None", description: "1–65,536. Required unless embed is set; then it defaults to the model's size." },
            { name: "metric", type: "str", defaultValue: '"cosine"', description: "cosine, dotproduct or euclidean." },
            { name: "index_type", type: "str", defaultValue: '"auto"', description: "auto, flat or hnsw." },
            { name: "hnsw", type: "dict | None", defaultValue: "None", description: "m, ef_construction and ef_search." },
            { name: "embed", type: "dict | None", defaultValue: "None", description: <>{"{"}"provider": …, "model": …{"}"} to embed text on the server. See <a href="#/docs/guides/text-search">text search</a>.</> },
            { name: "exist_ok", type: "bool", defaultValue: "False", description: <>Return the existing index instead of raising <C>AlreadyExists</C>. Still raises if it has a different dimension or metric.</> },
          ]}
          example={`db.create_index("products", dimension=1536, index_type="hnsw", hnsw={"m": 48})
db.create_index("docs", embed={"provider": "openai", "model": "text-embedding-3-small"}, exist_ok=True)`}>
          <p>Returns the index's description.</p>
        </Signature>

        <Signature id="list_indexes" name="list_indexes · describe_index · has_index" sig={`db.list_indexes() -> list[Obj]
db.describe_index(name) -> Obj
db.has_index(name) -> bool`}
          example={`for info in db.list_indexes():
    print(info.name, info.dimension, info.vector_count, info.embed and info.embed.model)`}>
          <p>Read index descriptions: dimension, metric, embedding model, record count, memory and status. A scoped key only sees its own indexes.</p>
        </Signature>

        <Signature id="configure_index" name="configure_index" sig={`db.configure_index(name, ef_search=None, *, embed=...) -> Obj`}
          example={`db.configure_index("products", ef_search=256)
db.configure_index("articles", embed={"provider": "openai", "model": "text-embedding-3-large", "field": "summary"})`}>
          <p>Change the default HNSW search width, or connect the embedding model that made an index's vectors so it can be searched by text. <C>embed=None</C> disconnects it.</p>
        </Signature>

        <Signature id="delete_index" name="delete_index" sig={`db.delete_index(name) -> None`}>
          <p>Delete an index and all its records, permanently.</p>
        </Signature>

        <Signature id="Index" name="Index" sig={`db.Index(name) -> RemoteIndex`}
          example={`index = db.Index("products")      # db.index("products") also works`}>
          <p>Open an index for data operations. No request is made until you call a method. See <a href="#/docs/sdk/index">Index methods</a>.</p>
        </Signature>

        <Signature id="keys" name="create_key · list_keys · revoke_key" sig={`db.create_key(name, role="read", indexes=None, expires_in_days=None) -> Obj
db.list_keys() -> list[Obj]
db.revoke_key(key_id) -> None`}
          params={[
            { name: "name", type: "str", required: true, description: "1–64 characters." },
            { name: "role", type: "str", defaultValue: '"read"', description: "read, write or admin." },
            { name: "indexes", type: "list[str] | None", defaultValue: "None", description: "Limit the key to these indexes." },
            { name: "expires_in_days", type: "int | None", defaultValue: "None", description: "1–3,650. None never expires." },
          ]}
          example={`key = db.create_key("nightly-ingest", role="write", indexes=["products"], expires_in_days=30)
secret = key.key            # only available now
db.revoke_key(key.id)`}>
          <p>Admin only. <C>create_key</C> returns the key's details plus <C>key</C>, the secret.</p>
        </Signature>

        <Signature id="list_embedding_models" name="list_embedding_models" sig={`db.list_embedding_models() -> Obj`}
          example={`catalog = db.list_embedding_models()
ready = [p.id for p in catalog.providers if p.available]`}>
          <p>The embedding providers and models the server supports, and which have keys set.</p>
        </Signature>

        <Signature id="ops" name="health · stats · close" sig={`db.health() -> Obj
db.stats() -> Obj
db.close() -> None`}>
          <p><C>health</C> needs no key. <C>stats</C> returns totals, process information and live traffic.</p>
        </Signature>
      </>
    ),
  },
  {
    slug: "async",
    title: "Async client",
    group: "Reference",
    description: "AsyncNeedleDB: every client and Index method, awaited, with parallel batch uploads.",
    keywords: "AsyncNeedleDB asyncio await async fastapi concurrency max_concurrency aiohttp",
    render: () => (
      <>
        <CodeBlock lang="python" title="Python" code={`from needledb import AsyncNeedleDB

async with AsyncNeedleDB("${ORIGIN}", api_key="ndb_…") as db:
    index = db.Index("products")
    res = await index.search("waterproof hiking boots", top_k=5)
    print(await index.count())`} />

        <H2 id="same-methods">The same methods</H2>
        <p><C>AsyncNeedleDB</C> takes the same arguments as <a href="#/docs/sdk/client">NeedleDB</a> and has the same methods; await each one. Its indexes have every <a href="#/docs/sdk/index">Index method</a>. The two iterators, <C>list</C> and <C>scan</C>, are async iterators.</p>
        <CodeBlock lang="python" title="Python" code={`async for ids in index.list(prefix="doc-42#"):
    print(len(ids))

async for record in index.scan():
    print(record.id, record.metadata)`} />

        <H2 id="parallel-uploads">Parallel uploads</H2>
        <p>The upsert methods take <C>max_concurrency</C>: how many batches to send at once. Batches may then land in any order, so don't repeat an id across the input.</p>
        <CodeBlock lang="python" title="Python" code={`await index.upsert_arrays(ids, embeddings, metadata, batch_size=500, max_concurrency=8)
await index.upsert_texts(paragraphs, max_concurrency=4)`} />

        <H2 id="fastapi">In a FastAPI app</H2>
        <p>Open one client for the life of the app and share it: it pools connections.</p>
        <CodeBlock lang="python" title="app.py" code={`from contextlib import asynccontextmanager
from fastapi import FastAPI
from needledb import AsyncNeedleDB

@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.db = AsyncNeedleDB()          # NEEDLEDB_URL and NEEDLEDB_API_KEY
    yield
    await app.state.db.close()

app = FastAPI(lifespan=lifespan)

@app.get("/search")
async def search(q: str):
    res = await app.state.db.Index("products").search(q, top_k=10)
    return [{"id": m.id, "score": m.score, "title": m.metadata.get("title")} for m in res.matches]`} />

        <Callout kind="note" title="Server only">
          The async client talks to a server. For the embedded engine, call <C>NeedleDBLocal</C> from a thread, for example with <C>asyncio.to_thread</C>.
        </Callout>
      </>
    ),
  },
  {
    slug: "index",
    title: "Index methods",
    group: "Reference",
    description: "Search, write, read, change and inspect records. Identical on remote, async and embedded indexes.",
    keywords: "search query upsert upsert_texts upsert_arrays get fetch scan list list_paginated update delete count describe describe_index_stats",
    render: () => (
      <>
        <Signature id="search" name="search" sig={`index.search(query, top_k=10, *, namespace=None, filter=None, include_metadata=True,
             include_values=False, ef_search=None) -> Obj`}
          params={[
            { name: "query", type: "str | list[float] | ndarray", required: true, description: "A string searches by meaning, on an index with an embedding model. A vector searches by vector." },
            { name: "top_k", type: "int", defaultValue: "10", description: "1–10,000." },
            NS,
            FILTER,
            { name: "include_metadata", type: "bool", defaultValue: "True", description: "Return metadata, including the stored text." },
            { name: "include_values", type: "bool", defaultValue: "False", description: "Return vectors." },
            { name: "ef_search", type: "int | None", defaultValue: "None", description: "HNSW search width for this query." },
          ]}
          example={`res = index.search("shoes for rainy hikes", top_k=5, filter={"in_stock": True})
for match in res.matches:
    print(f"{match.score:.3f}", match.metadata.text)

similar = index.search(index.get("sku-1").values, top_k=5)`}>
          <p>The everyday way to search. Returns <C>matches</C>, <C>namespace</C> and <C>usage</C>, which includes <C>embed_ms</C> when the query was embedded.</p>
        </Signature>

        <Signature id="query" name="query" sig={`index.query(vector=None, *, id=None, text=None, top_k=10, namespace=None, filter=None,
            include_values=False, include_metadata=False, ef_search=None) -> Obj`}
          params={[
            { name: "vector", type: "list[float] | ndarray", description: "Search from this vector." },
            { name: "id", type: "str", description: "Or search from this stored record." },
            { name: "text", type: "str", description: "Or search by meaning, on an index with an embedding model." },
            { name: "top_k", type: "int", defaultValue: "10", description: "1–10,000." },
            NS,
            FILTER,
            { name: "include_values", type: "bool", defaultValue: "False", description: "Return vectors." },
            { name: "include_metadata", type: "bool", defaultValue: "False", description: "Return metadata." },
            { name: "ef_search", type: "int | None", defaultValue: "None", description: "HNSW search width for this query." },
          ]}
          example={`res = index.query(id="sku-1", top_k=10, include_metadata=True,
                  filter={"price": {"$lte": 100}})
print(res.usage.plan)`}>
          <p>Pinecone's search call. Give exactly one of <C>vector</C>, <C>id</C> or <C>text</C>. Metadata is off by default, as in Pinecone.</p>
        </Signature>

        <Signature id="upsert_texts" name="upsert_texts" sig={`index.upsert_texts(texts, ids=None, metadata=None, namespace=None, batch_size=None) -> Obj`}
          params={[
            { name: "texts", type: "str | Iterable[str]", required: true, description: "One text or many. Each is embedded by the index's model and kept in metadata." },
            { name: "ids", type: "Iterable[str] | None", defaultValue: "None", description: "One id per text. Without them, each id is a hash of the text, so the same text always gets the same id." },
            { name: "metadata", type: "dict | list[dict | None] | None", defaultValue: "None", description: "One dict for every text, or one entry per text." },
            NS,
            { name: "batch_size", type: "int | None", defaultValue: "256", description: "Texts per request." },
          ]}
          example={`res = index.upsert_texts(
    [p.text for p in paragraphs],
    ids=[f"{doc.id}#{i}" for i, p in enumerate(paragraphs)],
    metadata={"doc": doc.id, "source": "handbook"},
)
res.upserted_count, res.ids[:3]`}>
          <p>Add text to an index with an embedding model. Returns <C>upsertedCount</C> and the <C>ids</C> used. If an id repeats, the last text wins.</p>
        </Signature>

        <Signature id="upsert" name="upsert" sig={`index.upsert(vectors, namespace=None, batch_size=None) -> Obj`}
          params={[
            { name: "vectors", type: "Iterable", required: true, description: "Dicts with id, values and metadata, or (id, values) and (id, values, metadata) tuples. On an index with an embedding model, dicts can carry text instead of values." },
            NS,
            { name: "batch_size", type: "int | None", defaultValue: "500 remote, 10,000 embedded", description: "Records per request." },
          ]}
          example={`index.upsert([
    {"id": "sku-1", "values": embedding, "metadata": {"brand": "acme"}},
    ("sku-2", other_embedding),
])`}>
          <p>Insert or overwrite records. Returns <C>upsertedCount</C>.</p>
        </Signature>

        <Signature id="upsert_arrays" name="upsert_arrays" sig={`index.upsert_arrays(ids, values, metadata=None, namespace=None, batch_size=None) -> Obj`}
          params={[
            { name: "ids", type: "list[str]", required: true, description: "One id per row." },
            { name: "values", type: "array-like", required: true, description: "An n × d array. Converted to float32." },
            { name: "metadata", type: "list[dict | None] | None", defaultValue: "None", description: "One entry per row." },
            NS,
            { name: "batch_size", type: "int | None", defaultValue: "None", description: "Records per request." },
          ]}
          example={`index.upsert_arrays(ids, embeddings, [{"title": t} for t in titles])`}>
          <p>The fast path for bulk loads from NumPy.</p>
        </Signature>

        <Signature id="get" name="get" sig={`index.get(id, namespace=None) -> Obj | None`}
          example={`record = index.get("sku-1")
if record:
    print(record.metadata, len(record.values))`}>
          <p>One record with its values and metadata, or <C>None</C> if it doesn't exist.</p>
        </Signature>

        <Signature id="fetch" name="fetch" sig={`index.fetch(ids, namespace=None) -> Obj`}
          example={`found = index.fetch(["sku-1", "sku-2"]).vectors
found["sku-1"].values`}>
          <p>Read up to 1,000 records by id. Missing ids are left out of <C>vectors</C>.</p>
        </Signature>

        <Signature id="scan" name="scan" sig={`index.scan(prefix=None, namespace=None, batch_size=100, include_values=False) -> Iterator[Obj]`}
          params={[
            { name: "prefix", type: "str | None", defaultValue: "None", description: "Only ids that start with this." },
            NS,
            { name: "batch_size", type: "int", defaultValue: "100", description: "Records fetched per round trip, 1–1,000." },
            { name: "include_values", type: "bool", defaultValue: "False", description: "Include vectors. Metadata is always included." },
          ]}
          example={`import json

with open("export.jsonl", "w") as out:
    for record in index.scan(batch_size=1000):
        out.write(json.dumps(record) + "\\n")`}>
          <p>Walk every record, a page at a time, for exports, migrations and backfills.</p>
        </Signature>

        <Signature id="list" name="list · list_paginated" sig={`index.list(prefix=None, limit=100, namespace=None) -> Iterator[list[str]]
index.list_paginated(prefix=None, limit=100, pagination_token=None, namespace=None) -> Obj`}
          example={`for ids in index.list(prefix="doc-42#"):
    index.delete(ids=ids)

page = index.list_paginated(limit=1000)
next_token = page.pagination.get("next")`}>
          <p><C>list</C> yields pages of ids until there are none left. <C>list_paginated</C> returns one page and its token.</p>
        </Signature>

        <Signature id="update" name="update" sig={`index.update(id, values=None, set_metadata=None, namespace=None) -> Obj`}
          example={`index.update("sku-1", set_metadata={"price": 39})`}>
          <p>Replace values, merge metadata, or both. Raises <C>NotFound</C> if the record doesn't exist.</p>
        </Signature>

        <Signature id="delete" name="delete" sig={`index.delete(ids=None, delete_all=False, filter=None, namespace=None) -> Obj`}
          example={`index.delete(filter={"discontinued": True}).deleted_count`}>
          <p>Give exactly one of <C>ids</C>, <C>delete_all</C> or <C>filter</C>. Returns <C>deletedCount</C>.</p>
        </Signature>

        <Signature id="count" name="count" sig={`index.count(namespace=None, filter=None) -> int`}
          example={`index.count()                                  # the default namespace
index.count("archive", filter={"lang": "fr"})`}>
          <p>How many records a namespace holds, optionally only those matching a filter.</p>
        </Signature>

        <Signature id="describe" name="describe" sig={`index.describe() -> Obj`}
          example={`info = index.describe()
info.dimension, info.metric, info.embed and info.embed.model, info.status.state`}>
          <p>This index's settings and status. The same as <C>db.describe_index(name)</C>.</p>
        </Signature>

        <Signature id="describe_index_stats" name="describe_index_stats" sig={`index.describe_index_stats(filter=None) -> Obj`}
          example={`stats = index.describe_index_stats()
stats.total_vector_count, {ns: s.vector_count for ns, s in stats.namespaces.items()}`}>
          <p>Record counts for every namespace, optionally only those matching a filter.</p>
        </Signature>
      </>
    ),
  },
  {
    slug: "embedded",
    title: "Embedded mode",
    group: "Reference",
    description: "The same engine and Index API inside your Python process, persisted to a directory.",
    keywords: "NeedleDBLocal local in-process no server wait_for_index",
    render: () => (
      <>
        <CodeBlock lang="python" title="Python" code={`from needledb import NeedleDBLocal

with NeedleDBLocal("./vectors") as db:
    db.create_index("docs", dimension=1536, exist_ok=True)
    index = db.Index("docs")
    index.upsert_arrays(ids, embeddings)
    index.wait_for_index()                 # let a background HNSW build finish
    res = index.search(q, top_k=10)`} />

        <H2 id="when">When to use it</H2>
        <ul>
          <li>Notebooks, tests and scripts where running a server is overhead.</li>
          <li>Initial bulk loads: load embedded, close, then serve the same directory.</li>
          <li>Applications that want vector search with no network hop.</li>
        </ul>

        <H2 id="text">Text search, embedded</H2>
        <p>Indexes with an embedding model work here too. Hosted models read their key from the environment; local models run in your process with <C>pip install "needledb[local]"</C>.</p>
        <CodeBlock lang="python" title="Python" code={`with NeedleDBLocal("./notes") as db:
    db.create_index("notes", embed={"provider": "local", "model": "BAAI/bge-small-en-v1.5"}, exist_ok=True)
    notes = db.Index("notes")
    notes.upsert_texts(["Call the plumber on Tuesday", "Book flights to Lisbon"])
    print(notes.search("travel plans", top_k=1).matches[0].metadata.text)`} />

        <H2 id="api">What's different</H2>
        <DocTable head={["", "NeedleDBLocal"]} rows={[
          ["Constructor", <C>NeedleDBLocal(path="./needledb-data")</C>],
          ["Index management", "create_index, list_indexes, describe_index, has_index, configure_index, delete_index"],
          ["Index methods", "All of them, including search, upsert_texts, get, scan and count"],
          ["Keys, health, stats", "Not available; there's no server"],
          ["Default batch size", "10,000"],
          ["Extra", <><C>index.wait_for_index(timeout=None)</C> blocks until background builds are swapped in</>],
          ["close()", "Snapshots every index and releases the directory"],
        ]} />

        <Callout kind="warning" title="One process per directory">
          Don't open a directory with <C>NeedleDBLocal</C> while a server, or another process, has it open.
        </Callout>
      </>
    ),
  },
  {
    slug: "errors",
    title: "Errors and retries",
    group: "Reference",
    description: "Every API error becomes a typed Python exception.",
    keywords: "exceptions NotFound InvalidArgument AlreadyExists FailedPrecondition retry backoff",
    render: () => (
      <>
        <H2 id="exceptions">Exceptions</H2>
        <p>All inherit from <C>NeedleError</C> and carry the server's <C>message</C>. Import them from <C>needledb.errors</C>.</p>
        <DocTable head={["Exception", "Status", "Raised when"]} rows={[
          [<C>InvalidArgument</C>, "400", "A request breaks a rule or limit, such as a vector of the wrong size."],
          [<C>FailedPrecondition</C>, "400", "The server isn't set up for the request, such as a missing provider key."],
          [<C>Unauthenticated</C>, "401", "The key is missing, invalid, expired or revoked."],
          [<C>PermissionDenied</C>, "403", "The key's role or scope doesn't allow it."],
          [<C>NotFound</C>, "404", "The index, record or key doesn't exist."],
          [<C>AlreadyExists</C>, "409", "The index name is taken — or, with exist_ok, taken by an index of a different shape."],
          [<C>PayloadTooLarge</C>, "413", "The request body is too large."],
          [<C>ResourceExhausted</C>, "429", "The address is locked out after failed attempts, or a provider is rate limiting."],
          [<C>Unavailable</C>, "502", "An embedding provider failed."],
          [<C>NeedleError</C>, "500", "Anything else."],
        ]} />
        <CodeBlock lang="python" title="Python" code={`from needledb.errors import FailedPrecondition, NotFound

try:
    index.search("waterproof boots")
except FailedPrecondition as err:
    print("Add an OpenAI key under Settings:", err)

try:
    index.update("missing-id", set_metadata={"x": 1})
except NotFound:
    pass`} />
        <p>Client-side mistakes raise standard exceptions before anything is sent: <C>ValueError</C> for a <C>search()</C> without a query or mismatched lengths, <C>TypeError</C> for texts that aren't strings.</p>

        <H2 id="retries">Retries</H2>
        <p>The remote clients retry connection errors and <C>502</C>, <C>503</C> and <C>504</C> responses up to <C>retries</C> times, waiting 0.25 s, 0.5 s, 1 s and so on, up to 4 s. Other errors are raised immediately.</p>
      </>
    ),
  },
  {
    slug: "cli",
    title: "Command line",
    group: "Tools",
    description: "Run the server and manage API keys from a terminal.",
    keywords: "cli needledb serve keys create list revoke version",
    render: () => (
      <>
        <H2 id="serve">needledb serve</H2>
        <CodeBlock lang="bash" title="Terminal" code={`needledb serve [--data DIR] [--host HOST] [--port PORT] [--api-key KEY]
               [--tls-cert PEM --tls-key PEM] [--trust-proxy] [--no-auth]
               [--log-level debug|info|warning|error]`} />
        <p>See <a href="#/docs/guides/self-hosting">self-hosting</a> for every flag.</p>

        <H2 id="keys-create">needledb keys create</H2>
        <CodeBlock lang="bash" title="Terminal" code={`needledb keys create --name search-api --role read --index products --expires-days 90`} />
        <p>Prints the new key once. Repeat <C>--index</C> to allow several indexes. Works while the server is stopped, which is how you create the first managed key without an environment key.</p>

        <H2 id="keys-list">needledb keys list</H2>
        <CodeBlock lang="bash" title="Terminal" code={`needledb keys list --data /var/lib/needledb`} />

        <H2 id="keys-revoke">needledb keys revoke</H2>
        <CodeBlock lang="bash" title="Terminal" code={`needledb keys revoke key_3f9a2c71b04e`} />

        <H2 id="version">needledb version</H2>
        <CodeBlock lang="bash" title="Terminal" code={`needledb version`} />
      </>
    ),
  },
];
