import type { ReactNode } from "react";
import { CodeBlock } from "../code";
import { IconCode, IconServer } from "../icons";
import { C, Callout, CardGroup, DocCard, DocTable, type Field, Fields, H2, ORIGIN } from "./parts";
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

export const SDK: DocPage[] = [
  {
    slug: "overview",
    title: "Python SDK",
    group: "Get started",
    description: "Two clients with the same Index methods: one for a running server, one that embeds the engine.",
    keywords: "install python client import",
    render: () => (
      <>
        <H2 id="install">Install</H2>
        <CodeBlock lang="bash" title="Terminal" code={`pip install needledb                 # Python 3.11–3.14
pip install "needledb[local]"         # adds local embedding models`} />

        <H2 id="clients">Choose a client</H2>
        <CardGroup>
          <DocCard title="NeedleDB" icon={<IconServer size={18} />} href="#/docs/sdk/client">Talks to a server over HTTP, with retries, batching and key management.</DocCard>
          <DocCard title="NeedleDBLocal" icon={<IconCode size={18} />} href="#/docs/sdk/embedded">Runs the engine inside your process. No server, no network.</DocCard>
        </CardGroup>
        <CodeBlock lang="python" title="Python" code={`from needledb import NeedleDB, NeedleDBLocal

db = NeedleDB("${ORIGIN}", api_key="ndb_…")
local = NeedleDBLocal("./vectors")

# Both hand you an Index with the same methods.
db.Index("products").query(vector=embedding, top_k=10)
local.Index("products").query(vector=embedding, top_k=10)`} />

        <H2 id="results">Results</H2>
        <p>Methods return <C>Obj</C>, a dict whose keys also read as attributes in either spelling. The API's camelCase fields can be read in snake_case.</p>
        <CodeBlock lang="python" title="Python" code={`stats = index.describe_index_stats()
stats.total_vector_count == stats["totalVectorCount"]     # True

res = index.query(vector=embedding, top_k=3, include_metadata=True)
res.matches[0].id, res.matches[0].score, res.usage.latency_ms`} />

        <Callout kind="note" title="Pinecone-shaped">
          Method names and arguments mirror Pinecone's Python SDK, so most code moves across by changing the import and the connection.
        </Callout>
      </>
    ),
  },
  {
    slug: "client",
    title: "NeedleDB client",
    group: "Reference",
    description: "Connect to a server, manage indexes and keys, and open indexes.",
    keywords: "NeedleDB create_index list_indexes describe_index delete_index create_key revoke_key",
    render: () => (
      <>
        <Signature id="constructor" name="NeedleDB()" sig={`NeedleDB(url=None, api_key=None, *, timeout=30.0, retries=3, client=None)`}
          params={[
            { name: "url", type: "str | None", defaultValue: "NEEDLEDB_URL", description: <>Server address. Falls back to <C>NEEDLEDB_URL</C>, then <C>http://localhost:8080</C>.</> },
            { name: "api_key", type: "str | None", defaultValue: "NEEDLEDB_API_KEY", description: "The key to send with every request." },
            { name: "timeout", type: "float", defaultValue: "30.0", description: "Seconds before a request fails." },
            { name: "retries", type: "int", defaultValue: "3", description: "Retries for connection errors and 502, 503 and 504, with exponential backoff." },
            { name: "client", type: "httpx.Client | None", defaultValue: "None", description: "Bring your own configured httpx client." },
          ]}
          example={`from needledb import NeedleDB

with NeedleDB("${ORIGIN}") as db:       # closes connections on exit
    print(db.health())`}>
          <p>Connections are pooled and kept alive. Use it as a context manager, or call <C>close()</C>.</p>
        </Signature>

        <Signature id="create_index" name="create_index" sig={`db.create_index(name, dimension=None, metric="cosine", index_type="auto", hnsw=None, embed=None) -> Obj`}
          params={[
            { name: "name", type: "str", required: true, description: "1–45 lowercase letters, digits and hyphens." },
            { name: "dimension", type: "int | None", defaultValue: "None", description: "1–65,536. Required unless embed is set; then it defaults to the model's size." },
            { name: "metric", type: "str", defaultValue: '"cosine"', description: "cosine, dotproduct or euclidean." },
            { name: "index_type", type: "str", defaultValue: '"auto"', description: "auto, flat or hnsw." },
            { name: "hnsw", type: "dict | None", defaultValue: "None", description: "m, ef_construction and ef_search." },
            { name: "embed", type: "dict | None", defaultValue: "None", description: <>{"{"}"provider": …, "model": …{"}"} to embed text on the server. See <a href="#/docs/guides/text-search">text search</a>.</> },
          ]}
          example={`db.create_index("products", dimension=1536, index_type="hnsw", hnsw={"m": 48})
db.create_index("docs", embed={"provider": "openai", "model": "text-embedding-3-small"})`}>
          <p>Returns the new index's description.</p>
        </Signature>

        <Signature id="list_indexes" name="list_indexes · describe_index · has_index" sig={`db.list_indexes() -> list[Obj]
db.describe_index(name) -> Obj
db.has_index(name) -> bool`}
          example={`if not db.has_index("products"):
    db.create_index("products", dimension=1536)`}>
          <p>Read index descriptions. A scoped key only sees its own indexes.</p>
        </Signature>

        <Signature id="configure_index" name="configure_index" sig={`db.configure_index(name, ef_search) -> Obj`}
          example={`db.configure_index("products", ef_search=256)`}>
          <p>Change the default HNSW search width.</p>
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
    slug: "index",
    title: "Index methods",
    group: "Reference",
    description: "Upsert, query, fetch, update, delete, list and count. Identical on remote and embedded indexes.",
    keywords: "upsert upsert_arrays query fetch update delete list list_paginated describe_index_stats",
    render: () => (
      <>
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

        <Signature id="query" name="query" sig={`index.query(vector=None, *, id=None, text=None, top_k=10, namespace=None, filter=None,
            include_values=False, include_metadata=False, ef_search=None) -> Obj`}
          params={[
            { name: "vector", type: "list[float] | ndarray", description: "Search from this vector." },
            { name: "id", type: "str", description: "Or search from this stored record." },
            { name: "text", type: "str", description: "Or search by meaning, on an index with an embedding model." },
            { name: "top_k", type: "int", defaultValue: "10", description: "1–10,000." },
            NS,
            { name: "filter", type: "dict | None", defaultValue: "None", description: <>A <a href="#/docs/guides/filtering">metadata filter</a>.</> },
            { name: "include_values", type: "bool", defaultValue: "False", description: "Return vectors." },
            { name: "include_metadata", type: "bool", defaultValue: "False", description: "Return metadata." },
            { name: "ef_search", type: "int | None", defaultValue: "None", description: "HNSW search width for this query." },
          ]}
          example={`res = index.query(vector=embedding, top_k=10, include_metadata=True,
                  filter={"price": {"$lte": 100}})
for m in res.matches:
    print(m.id, m.score, m.metadata)
print(res.usage.plan)`}>
          <p>Returns <C>matches</C>, <C>namespace</C> and <C>usage</C>.</p>
        </Signature>

        <Signature id="search" name="search" sig={`index.search(text, top_k=10, *, namespace=None, filter=None, include_metadata=True) -> Obj`}
          example={`res = index.search("shoes for rainy hikes", filter={"in_stock": True})
print(res.matches[0].metadata["text"])`}>
          <p>Search by meaning on an index with an embedding model. The same as <C>query(text=…)</C>, with metadata included.</p>
        </Signature>

        <Signature id="fetch" name="fetch" sig={`index.fetch(ids, namespace=None) -> Obj`}
          example={`index.fetch(["sku-1"]).vectors["sku-1"].values`}>
          <p>Read up to 1,000 records by id, with values and metadata.</p>
        </Signature>

        <Signature id="update" name="update" sig={`index.update(id, values=None, set_metadata=None, namespace=None) -> Obj`}
          example={`index.update("sku-1", set_metadata={"price": 39})`}>
          <p>Replace values, merge metadata, or both. Raises <C>NotFound</C> if the record doesn't exist.</p>
        </Signature>

        <Signature id="delete" name="delete" sig={`index.delete(ids=None, delete_all=False, filter=None, namespace=None) -> Obj`}
          example={`index.delete(filter={"discontinued": True}).deleted_count`}>
          <p>Give exactly one of <C>ids</C>, <C>delete_all</C> or <C>filter</C>. Returns <C>deletedCount</C>.</p>
        </Signature>

        <Signature id="list" name="list · list_paginated" sig={`index.list(prefix=None, limit=100, namespace=None) -> Iterator[list[str]]
index.list_paginated(prefix=None, limit=100, pagination_token=None, namespace=None) -> Obj`}
          example={`for ids in index.list(prefix="doc-42#"):
    print(len(ids))

page = index.list_paginated(limit=1000)
next_token = page.pagination.get("next")`}>
          <p><C>list</C> yields pages of ids until there are none left. <C>list_paginated</C> returns one page and its token.</p>
        </Signature>

        <Signature id="describe_index_stats" name="describe_index_stats" sig={`index.describe_index_stats(filter=None) -> Obj`}
          example={`index.describe_index_stats().namespaces`}>
          <p>Record counts per namespace, optionally only those matching a filter.</p>
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
    db.create_index("docs", dimension=1536)
    index = db.Index("docs")
    index.upsert_arrays(ids, embeddings)
    index.wait_for_index()                 # let a background HNSW build finish
    res = index.query(vector=q, top_k=10)`} />

        <H2 id="when">When to use it</H2>
        <ul>
          <li>Notebooks, tests and scripts where running a server is overhead.</li>
          <li>Initial bulk loads: load embedded, close, then serve the same directory.</li>
          <li>Applications that want vector search with no network hop.</li>
        </ul>

        <H2 id="api">What's different</H2>
        <DocTable head={["", "NeedleDBLocal"]} rows={[
          ["Constructor", <C>NeedleDBLocal(path="./needledb-data")</C>],
          ["Index management", "create_index, list_indexes, describe_index, has_index, configure_index, delete_index"],
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
    keywords: "exceptions NotFound InvalidArgument retry backoff",
    render: () => (
      <>
        <H2 id="exceptions">Exceptions</H2>
        <p>All inherit from <C>NeedleError</C> and carry the server's <C>message</C>.</p>
        <DocTable head={["Exception", "Status", "Raised when"]} rows={[
          [<C>InvalidArgument</C>, "400", "A request breaks a rule or limit."],
          [<C>Unauthenticated</C>, "401", "The key is missing, invalid, expired or revoked."],
          [<C>PermissionDenied</C>, "403", "The key's role or scope doesn't allow it."],
          [<C>NotFound</C>, "404", "The index, record or key doesn't exist."],
          [<C>AlreadyExists</C>, "409", "The index name is taken."],
          [<C>PayloadTooLarge</C>, "413", "The request body is too large."],
          [<C>ResourceExhausted</C>, "429", "The address is locked out after failed attempts."],
          [<C>FailedPrecondition</C>, "400", "The server isn't set up for the request, such as a missing provider key."],
          [<C>Unavailable</C>, "502", "An embedding provider failed."],
          [<C>NeedleError</C>, "500", "Anything else."],
        ]} />
        <CodeBlock lang="python" title="Python" code={`from needledb.errors import AlreadyExists, NotFound

try:
    db.create_index("products", dimension=1536)
except AlreadyExists:
    pass

try:
    index.update("missing-id", set_metadata={"x": 1})
except NotFound as err:
    print(err.message)`} />

        <H2 id="retries">Retries</H2>
        <p>The remote client retries connection errors and <C>502</C>, <C>503</C> and <C>504</C> responses up to <C>retries</C> times, waiting 0.25 s, 0.5 s, 1 s and so on, up to 4 s. Other errors are raised immediately.</p>
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
