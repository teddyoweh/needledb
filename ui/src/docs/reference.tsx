import type { ReactNode } from "react";
import { CodeBlock, CodeTabs } from "../code";
import { IconActivity, IconCode, IconKey, IconSearch, IconShield } from "../icons";
import { C, Callout, CardGroup, DocCard, DocTable, EndpointBar, type Field, Fields, H2, type Method, ORIGIN } from "./parts";
import type { DocPage } from "./types";

type Access = "public" | "read" | "write" | "admin";

type Endpoint = {
  slug: string;
  title: string;
  group: string;
  method: Method;
  path: string;
  summary: string;
  access: Access;
  about?: ReactNode;
  pathParams?: Field[];
  query?: Field[];
  body?: Field[];
  response: Field[];
  curl: string;
  python?: string;
  status?: number;
  example: string;
  keywords?: string;
};

const ACCESS: Record<Access, ReactNode> = {
  public: <>No key needed</>,
  read: <>Needs a <b>read</b> key or higher</>,
  write: <>Needs a <b>write</b> key or higher</>,
  admin: <>Needs an <b>admin</b> key</>,
};

const STATUS: Record<number, string> = { 200: "OK", 201: "Created", 202: "Accepted" };

const H = `-H "Api-Key: $NEEDLEDB_API_KEY"`;
const JSON_H = `${H} -H "Content-Type: application/json"`;

const NAME: Field = { name: "name", type: "string", required: true, description: "The index name." };
const NAMESPACE: Field = { name: "namespace", type: "string", defaultValue: '""', description: "The namespace to use. Up to 256 bytes." };
const FILTER: Field = { name: "filter", type: "object", description: <>A <a href="#/docs/guides/filtering">metadata filter</a>.</> };

const INDEX_FIELDS: Field[] = [
  { name: "name", type: "string", description: "The index name." },
  { name: "dimension", type: "integer", description: "Length of every vector." },
  { name: "metric", type: "string", description: "cosine, dotproduct or euclidean." },
  { name: "index_type", type: "string", description: "auto, flat or hnsw." },
  {
    name: "hnsw", type: "object", description: "Graph settings.", children: [
      { name: "m", type: "integer", description: "Links per node." },
      { name: "ef_construction", type: "integer", description: "Build-time candidate list size." },
      { name: "ef_search", type: "integer", description: "Query-time candidate list size." },
    ],
  },
  { name: "created_at", type: "string", description: "ISO 8601 creation time." },
  { name: "vectorCount", type: "integer", description: "Live vectors across all namespaces." },
  { name: "namespaceCount", type: "integer", description: "Number of namespaces." },
  { name: "annTypes", type: "string[]", description: "Structures in use across namespaces: flat and/or hnsw." },
  { name: "memoryBytes", type: "integer", description: "Estimated memory for vectors and graphs." },
  { name: "storageBytes", type: "integer", description: "Size on disk." },
  {
    name: "status", type: "object", description: "Readiness.", children: [
      { name: "ready", type: "boolean", description: "Always true once created: the index accepts reads and writes." },
      { name: "state", type: "string", description: "Ready, or Building while a graph builds or compacts in the background." },
    ],
  },
  { name: "host", type: "string", description: "Base URL for data-plane requests and the Pinecone client." },
];

const INDEX_EXAMPLE = `{
  "name": "products",
  "dimension": 1536,
  "metric": "cosine",
  "index_type": "auto",
  "hnsw": {"m": 32, "ef_construction": 200, "ef_search": 128},
  "created_at": "2026-09-14T18:02:11+00:00",
  "vectorCount": 48210,
  "namespaceCount": 2,
  "annTypes": ["hnsw"],
  "memoryBytes": 310455296,
  "storageBytes": 402337792,
  "status": {"ready": true, "state": "Ready"},
  "host": "${ORIGIN}/indexes/products"
}`;

const KEY_FIELDS: Field[] = [
  { name: "id", type: "string", description: "Key id, used to revoke it. Not a secret." },
  { name: "name", type: "string", description: "The key's name." },
  { name: "prefix", type: "string | null", description: "The first characters of the secret, to recognise it." },
  { name: "role", type: "string", description: "read, write or admin." },
  { name: "indexes", type: "string[] | null", description: "Indexes the key is limited to, or null for all." },
  { name: "createdAt", type: "number | null", description: "Unix time." },
  { name: "lastUsedAt", type: "number | null", description: "Unix time the key last authenticated." },
  { name: "expiresAt", type: "number | null", description: "Unix time the key stops working, or null." },
  { name: "managed", type: "boolean", description: "False for keys set with NEEDLEDB_API_KEY." },
];

const MATCH_FIELDS: Field[] = [
  { name: "id", type: "string", description: "Record id." },
  { name: "score", type: "number", description: "Similarity or distance, depending on the metric." },
  { name: "values", type: "number[]", description: "The vector, when includeValues is true." },
  { name: "metadata", type: "object", description: "The metadata, when includeMetadata is true." },
];

const ENDPOINTS: Endpoint[] = [
  // ---- indexes ---------------------------------------------------------------------
  {
    slug: "create-index", title: "Create an index", group: "Indexes", method: "POST", path: "/indexes", access: "admin", status: 201,
    summary: "Create an index with a fixed dimension, metric and structure.",
    keywords: "new index",
    body: [
      { name: "name", type: "string", required: true, description: "1–45 lowercase letters, digits and hyphens, starting and ending with a letter or digit." },
      { name: "dimension", type: "integer", required: true, description: "Vector length, from 1 to 65,536." },
      { name: "metric", type: "string", defaultValue: "cosine", description: "cosine, dotproduct or euclidean." },
      { name: "index_type", type: "string", defaultValue: "auto", description: <>auto, flat or hnsw. See <a href="#/docs/guides/index-structures">index structures</a>.</> },
      {
        name: "hnsw", type: "object", description: "Graph settings. Only used by hnsw and auto.", children: [
          { name: "m", type: "integer", defaultValue: "32", description: "Links per node, 4–128." },
          { name: "ef_construction", type: "integer", defaultValue: "200", description: "Build-time candidates, 16–2,000." },
          { name: "ef_search", type: "integer", defaultValue: "128", description: "Query-time candidates, 1–10,000." },
        ],
      },
    ],
    response: INDEX_FIELDS,
    curl: `curl ${ORIGIN}/indexes \\
  ${JSON_H} \\
  -d '{"name": "products", "dimension": 1536, "metric": "cosine"}'`,
    python: `db.create_index("products", dimension=1536, metric="cosine")`,
    example: INDEX_EXAMPLE.replace('"vectorCount": 48210', '"vectorCount": 0').replace('"namespaceCount": 2', '"namespaceCount": 0')
      .replace('"annTypes": ["hnsw"]', '"annTypes": []').replace('"memoryBytes": 310455296', '"memoryBytes": 0').replace('"storageBytes": 402337792', '"storageBytes": 24576'),
  },
  {
    slug: "list-indexes", title: "List indexes", group: "Indexes", method: "GET", path: "/indexes", access: "read",
    summary: "List the indexes this key can access.",
    about: <p>A key scoped to some indexes sees only those.</p>,
    response: [{ name: "indexes", type: "object[]", description: "One description per index, as returned by describe.", children: INDEX_FIELDS }],
    curl: `curl ${ORIGIN}/indexes ${H}`,
    python: `for index in db.list_indexes():
    print(index.name, index.vector_count)`,
    example: `{\n  "indexes": [\n${INDEX_EXAMPLE.split("\n").map((l) => `    ${l}`).join("\n")}\n  ]\n}`,
  },
  {
    slug: "describe-index", title: "Describe an index", group: "Indexes", method: "GET", path: "/indexes/{name}", access: "read",
    summary: "Read an index's configuration, size and status.",
    pathParams: [NAME],
    response: INDEX_FIELDS,
    curl: `curl ${ORIGIN}/indexes/products ${H}`,
    python: `info = db.describe_index("products")
print(info.host, info.status.state)`,
    example: INDEX_EXAMPLE,
  },
  {
    slug: "configure-index", title: "Configure an index", group: "Indexes", method: "PATCH", path: "/indexes/{name}", access: "admin",
    summary: "Change an index's default search width.",
    about: <p>Only <C>ef_search</C> can change after creation. The new value applies to the next query.</p>,
    pathParams: [NAME],
    body: [{
      name: "hnsw", type: "object", required: true, description: "The settings to change.", children: [
        { name: "ef_search", type: "integer", required: true, description: "Query-time candidates, 1–10,000." },
      ],
    }],
    response: INDEX_FIELDS,
    curl: `curl -X PATCH ${ORIGIN}/indexes/products \\
  ${JSON_H} \\
  -d '{"hnsw": {"ef_search": 256}}'`,
    python: `db.configure_index("products", ef_search=256)`,
    example: INDEX_EXAMPLE.replace('"ef_search": 128', '"ef_search": 256'),
  },
  {
    slug: "delete-index", title: "Delete an index", group: "Indexes", method: "DELETE", path: "/indexes/{name}", access: "admin", status: 202,
    summary: "Delete an index and every record in it, permanently.",
    pathParams: [NAME],
    response: [],
    curl: `curl -X DELETE ${ORIGIN}/indexes/products ${H}`,
    python: `db.delete_index("products")`,
    example: `{}`,
  },
  {
    slug: "describe-index-stats", title: "Describe index stats", group: "Indexes", method: "POST", path: "/indexes/{name}/describe_index_stats", access: "read",
    summary: "Count records per namespace, optionally only those matching a filter.",
    keywords: "count statistics namespaces",
    about: <p><C>GET</C> on the same path returns unfiltered stats.</p>,
    pathParams: [NAME],
    body: [FILTER],
    response: [
      { name: "dimension", type: "integer", description: "Vector length." },
      { name: "metric", type: "string", description: "Distance metric." },
      { name: "totalVectorCount", type: "integer", description: "Matching records across namespaces." },
      {
        name: "namespaces", type: "object", description: "Per namespace, keyed by name.", children: [
          { name: "vectorCount", type: "integer", description: "Matching records." },
          { name: "indexType", type: "string", description: "flat or hnsw." },
          { name: "building", type: "boolean", description: "Whether a graph build or compaction is running." },
          { name: "tombstones", type: "integer", description: "Deleted slots awaiting compaction." },
        ],
      },
      { name: "indexFullness", type: "number", description: "Always 0. Present for Pinecone compatibility." },
    ],
    curl: `curl ${ORIGIN}/indexes/products/describe_index_stats \\
  ${JSON_H} \\
  -d '{"filter": {"brand": "acme"}}'`,
    python: `stats = index.describe_index_stats(filter={"brand": "acme"})
print(stats.total_vector_count)`,
    example: `{
  "dimension": 1536,
  "metric": "cosine",
  "totalVectorCount": 1204,
  "namespaces": {
    "": {"vectorCount": 1100, "indexType": "hnsw", "building": false, "tombstones": 12},
    "staging": {"vectorCount": 104, "indexType": "flat", "building": false, "tombstones": 0}
  },
  "indexFullness": 0.0
}`,
  },
  {
    slug: "vector-map", title: "Vector map", group: "Indexes", method: "GET", path: "/indexes/{name}/map", access: "read",
    summary: "A 2-D projection of a sample of a namespace, for visual exploration.",
    keywords: "visualize explore projection pca cluster scatter",
    about: (
      <p>Samples up to <C>limit</C> records, projects them onto their two strongest directions with randomized PCA, and clusters them with k-means. This is what the app's Explore tab draws.</p>
    ),
    pathParams: [NAME],
    query: [
      NAMESPACE,
      { name: "limit", type: "integer", defaultValue: "1500", description: "Records to sample, 1–5,000." },
      { name: "color_by", type: "string", description: "A metadata field whose value is returned as each point's group." },
    ],
    response: [
      { name: "namespace", type: "string", description: "The namespace mapped." },
      { name: "total", type: "integer", description: "Records in the namespace." },
      { name: "sampled", type: "integer", description: "Records in this map." },
      { name: "explained", type: "number[]", description: "Share of the sample's variance along each axis." },
      {
        name: "points", type: "object[]", description: "One per sampled record.", children: [
          { name: "id", type: "string", description: "Record id." },
          { name: "x", type: "number", description: "Horizontal position, from −1 to 1." },
          { name: "y", type: "number", description: "Vertical position, from −1 to 1." },
          { name: "cluster", type: "integer", description: "k-means cluster." },
          { name: "label", type: "string | null", description: "A title-like metadata field (title, name, text…), shortened." },
          { name: "group", type: "string | null", description: "The color_by field's value, when requested." },
        ],
      },
      { name: "colorFields", type: "string[]", description: "Metadata fields with 2–12 distinct values in the sample: good candidates for color_by." },
    ],
    curl: `curl "${ORIGIN}/indexes/products/map?limit=1500&color_by=category" ${H}`,
    example: `{
  "namespace": "",
  "total": 48210,
  "sampled": 1500,
  "explained": [0.182, 0.094],
  "points": [
    {"id": "sku-1", "x": -0.42, "y": 0.17, "cluster": 3, "label": "Trail running shoe", "group": "Footwear"}
  ],
  "colorFields": ["brand", "category", "in_stock"]
}`,
  },

  // ---- vectors -----------------------------------------------------------------------
  {
    slug: "upsert", title: "Upsert vectors", group: "Vectors", method: "POST", path: "/indexes/{name}/vectors/upsert", access: "write",
    summary: "Insert records, or overwrite records with the same id.",
    keywords: "insert write add",
    about: <p>A batch is written to disk before the response is sent, and is all or nothing.</p>,
    pathParams: [NAME],
    body: [
      {
        name: "vectors", type: "object[]", required: true, description: "1–10,000 records.", children: [
          { name: "id", type: "string", required: true, description: "Up to 512 bytes." },
          { name: "values", type: "number[]", required: true, description: "Exactly dimension finite numbers." },
          { name: "metadata", type: "object", description: "Strings, numbers, booleans or lists of strings. Up to 40 KB." },
        ],
      },
      NAMESPACE,
    ],
    response: [{ name: "upsertedCount", type: "integer", description: "Records written." }],
    curl: `curl ${ORIGIN}/indexes/products/vectors/upsert \\
  ${JSON_H} \\
  -d '{"vectors": [{"id": "sku-1", "values": [0.01, 0.02, 0.03], "metadata": {"brand": "acme"}}]}'`,
    python: `index.upsert([
    {"id": "sku-1", "values": embedding, "metadata": {"brand": "acme"}},
])`,
    example: `{"upsertedCount": 1}`,
  },
  {
    slug: "query", title: "Query", group: "Vectors", method: "POST", path: "/indexes/{name}/query", access: "read",
    summary: "Find the nearest neighbours of a vector or a stored record.",
    keywords: "search similarity nearest top_k",
    about: <p>Give exactly one of <C>vector</C> or <C>id</C>. Body fields also accept snake_case, such as <C>top_k</C>.</p>,
    pathParams: [NAME],
    body: [
      { name: "vector", type: "number[]", description: "The query vector. Exactly dimension numbers." },
      { name: "id", type: "string", description: "Search from this stored record instead." },
      { name: "topK", type: "integer", defaultValue: "10", description: "Matches to return, 1–10,000." },
      NAMESPACE,
      FILTER,
      { name: "includeMetadata", type: "boolean", defaultValue: "false", description: "Return each match's metadata." },
      { name: "includeValues", type: "boolean", defaultValue: "false", description: "Return each match's vector." },
      { name: "efSearch", type: "integer", description: "HNSW search width for this query, 1–10,000." },
    ],
    response: [
      { name: "matches", type: "object[]", description: "Best first.", children: MATCH_FIELDS },
      { name: "namespace", type: "string", description: "The namespace searched." },
      {
        name: "usage", type: "object", description: "How the query ran.", children: [
          { name: "latencyMs", type: "number", description: "Time spent in the engine." },
          { name: "plan", type: "string", description: <>exact, hnsw, filtered-exact, filtered-hnsw or empty. See <a href="#/docs/guides/query">query plans</a>.</> },
        ],
      },
    ],
    curl: `curl ${ORIGIN}/indexes/products/query \\
  ${JSON_H} \\
  -d '{"id": "sku-1", "topK": 5, "includeMetadata": true,
       "filter": {"price": {"$lt": 100}}}'`,
    python: `res = index.query(id="sku-1", top_k=5, include_metadata=True,
                  filter={"price": {"$lt": 100}})`,
    example: `{
  "matches": [
    {"id": "sku-1", "score": 1.0, "metadata": {"brand": "acme", "price": 49}},
    {"id": "sku-7", "score": 0.9107, "metadata": {"brand": "acme", "price": 64}}
  ],
  "namespace": "",
  "usage": {"latencyMs": 0.92, "plan": "filtered-exact"}
}`,
  },
  {
    slug: "fetch", title: "Fetch vectors", group: "Vectors", method: "POST", path: "/indexes/{name}/vectors/fetch", access: "read",
    summary: "Read records by id.",
    about: <p>Ids that don't exist are left out. <C>{"GET /indexes/{name}/vectors/fetch?ids=a&ids=b"}</C> also works, and always includes values.</p>,
    pathParams: [NAME],
    body: [
      { name: "ids", type: "string[]", required: true, description: "Up to 1,000 ids." },
      NAMESPACE,
      { name: "includeValues", type: "boolean", defaultValue: "true", description: "Return the vectors. Turn off to read only metadata." },
    ],
    response: [
      { name: "vectors", type: "object", description: "Records keyed by id, each with id, metadata and values." },
      { name: "namespace", type: "string", description: "The namespace read." },
    ],
    curl: `curl ${ORIGIN}/indexes/products/vectors/fetch \\
  ${JSON_H} \\
  -d '{"ids": ["sku-1", "sku-2"]}'`,
    python: `res = index.fetch(["sku-1", "sku-2"])
res.vectors["sku-1"].metadata`,
    example: `{
  "vectors": {
    "sku-1": {"id": "sku-1", "metadata": {"brand": "acme"}, "values": [0.01, 0.02, 0.03]}
  },
  "namespace": ""
}`,
  },
  {
    slug: "update", title: "Update a vector", group: "Vectors", method: "POST", path: "/indexes/{name}/vectors/update", access: "write",
    summary: "Replace a record's values, merge into its metadata, or both.",
    pathParams: [NAME],
    body: [
      { name: "id", type: "string", required: true, description: "The record to update. Must exist." },
      { name: "values", type: "number[]", description: "New vector." },
      { name: "setMetadata", type: "object", description: "Fields to set. Other fields are kept." },
      NAMESPACE,
    ],
    response: [],
    curl: `curl ${ORIGIN}/indexes/products/vectors/update \\
  ${JSON_H} \\
  -d '{"id": "sku-1", "setMetadata": {"price": 39}}'`,
    python: `index.update("sku-1", set_metadata={"price": 39})`,
    example: `{}`,
  },
  {
    slug: "delete", title: "Delete vectors", group: "Vectors", method: "POST", path: "/indexes/{name}/vectors/delete", access: "write",
    summary: "Delete records by id, by filter, or a whole namespace.",
    about: <p>Give exactly one of <C>ids</C>, <C>filter</C> or <C>deleteAll</C>.</p>,
    pathParams: [NAME],
    body: [
      { name: "ids", type: "string[]", description: "Records to delete." },
      FILTER,
      { name: "deleteAll", type: "boolean", description: "Delete the whole namespace." },
      NAMESPACE,
    ],
    response: [{ name: "deletedCount", type: "integer", description: "Records removed." }],
    curl: `curl ${ORIGIN}/indexes/products/vectors/delete \\
  ${JSON_H} \\
  -d '{"filter": {"discontinued": true}}'`,
    python: `index.delete(filter={"discontinued": True})`,
    example: `{"deletedCount": 318}`,
  },
  {
    slug: "list", title: "List vector ids", group: "Vectors", method: "GET", path: "/indexes/{name}/vectors/list", access: "read",
    summary: "Page through ids in sorted order, optionally by prefix.",
    pathParams: [NAME],
    query: [
      { name: "prefix", type: "string", description: "Only ids starting with this." },
      { name: "limit", type: "integer", defaultValue: "100", description: "Ids per page, 1–10,000." },
      { name: "paginationToken", type: "string", description: "The previous page's pagination.next." },
      NAMESPACE,
    ],
    response: [
      { name: "vectors", type: "object[]", description: "Objects with an id." },
      { name: "pagination", type: "object", description: "Has next when more pages remain." },
      { name: "namespace", type: "string", description: "The namespace listed." },
    ],
    curl: `curl "${ORIGIN}/indexes/products/vectors/list?prefix=sku-&limit=2" ${H}`,
    python: `for ids in index.list(prefix="sku-"):
    print(ids)`,
    example: `{
  "vectors": [{"id": "sku-1"}, {"id": "sku-10"}],
  "pagination": {"next": "sku-10"},
  "namespace": ""
}`,
  },

  // ---- keys -------------------------------------------------------------------------
  {
    slug: "create-key", title: "Create a key", group: "API keys", method: "POST", path: "/keys", access: "admin", status: 201,
    summary: "Create an API key. The secret is returned once.",
    body: [
      { name: "name", type: "string", required: true, description: "1–64 characters." },
      { name: "role", type: "string", defaultValue: "read", description: "read, write or admin." },
      { name: "indexes", type: "string[]", description: "Limit the key to these indexes. Not allowed for admin keys." },
      { name: "expiresInDays", type: "integer", description: "Expire after 1–3,650 days. Omit for a key that never expires." },
    ],
    response: [...KEY_FIELDS, { name: "key", type: "string", description: "The secret. Store it now: it can't be retrieved again." }],
    curl: `curl ${ORIGIN}/keys \\
  ${JSON_H} \\
  -d '{"name": "search-api", "role": "read", "indexes": ["products"], "expiresInDays": 90}'`,
    python: `key = db.create_key("search-api", role="read", indexes=["products"], expires_in_days=90)
print(key.key)`,
    example: `{
  "id": "key_3f9a2c71b04e",
  "name": "search-api",
  "prefix": "ndb_Qm81xZ",
  "role": "read",
  "indexes": ["products"],
  "createdAt": 1789412531.2,
  "lastUsedAt": null,
  "expiresAt": 1797188531.2,
  "managed": true,
  "key": "ndb_Qm81xZ…"
}`,
  },
  {
    slug: "list-keys", title: "List keys", group: "API keys", method: "GET", path: "/keys", access: "admin",
    summary: "List active keys, including those set in the environment. Secrets are never returned.",
    response: [{ name: "keys", type: "object[]", description: "Environment keys first, then managed keys, newest first.", children: KEY_FIELDS }],
    curl: `curl ${ORIGIN}/keys ${H}`,
    python: `for key in db.list_keys():
    print(key.name, key.role, key.expires_at)`,
    example: `{
  "keys": [
    {"id": "env-1", "name": "Environment key", "prefix": null, "role": "admin", "indexes": null,
     "createdAt": null, "lastUsedAt": null, "expiresAt": null, "managed": false},
    {"id": "key_3f9a2c71b04e", "name": "search-api", "prefix": "ndb_Qm81xZ", "role": "read",
     "indexes": ["products"], "createdAt": 1789412531.2, "lastUsedAt": 1789413002.9,
     "expiresAt": 1797188531.2, "managed": true}
  ]
}`,
  },
  {
    slug: "revoke-key", title: "Revoke a key", group: "API keys", method: "DELETE", path: "/keys/{id}", access: "admin",
    summary: "Revoke a managed key. It stops working immediately and its sessions end.",
    pathParams: [{ name: "id", type: "string", required: true, description: "The key's id, such as key_3f9a2c71b04e." }],
    response: [],
    curl: `curl -X DELETE ${ORIGIN}/keys/key_3f9a2c71b04e ${H}`,
    python: `db.revoke_key("key_3f9a2c71b04e")`,
    example: `{}`,
  },

  // ---- sessions --------------------------------------------------------------------
  {
    slug: "sign-in", title: "Sign in", group: "Sessions", method: "POST", path: "/auth/login", access: "public",
    summary: "Exchange an API key for a web-app session cookie.",
    about: <p>Used by the app's sign-in page. Failed attempts count toward the <a href="#/docs/guides/authentication">lockout</a>.</p>,
    body: [{ name: "apiKey", type: "string", required: true, description: "The key to sign in with." }],
    response: [
      { name: "authenticated", type: "boolean", description: "True on success." },
      { name: "principal", type: "object", description: "The key's id, name, role, source and indexes." },
      { name: "sessionExpiresAt", type: "integer", description: "Unix time the session ends." },
      { name: "security", type: "object", description: "The protections in force on this connection." },
    ],
    curl: `curl -i ${ORIGIN}/auth/login \\
  -H "Content-Type: application/json" \\
  -d '{"apiKey": "ndb_…"}'`,
    example: `{
  "authRequired": true,
  "authenticated": true,
  "version": "0.1.0",
  "principal": {"id": "key_3f9a2c71b04e", "name": "search-api", "role": "read", "source": "key", "indexes": ["products"]},
  "via": "session",
  "sessionExpiresAt": 1789455731
}`,
  },
  {
    slug: "me", title: "Current principal", group: "Sessions", method: "GET", path: "/auth/me", access: "public",
    summary: "Who this request is authenticated as, and how the server is protected.",
    response: [
      { name: "authRequired", type: "boolean", description: "False only in --no-auth mode." },
      { name: "authenticated", type: "boolean", description: "Whether a valid key or session came with the request." },
      { name: "principal", type: "object", description: "Present when authenticated." },
      { name: "via", type: "string", description: "key, session or local." },
      { name: "sessionExpiresAt", type: "integer | null", description: "When the session ends." },
      {
        name: "security", type: "object", description: "Present when authenticated.", children: [
          { name: "https", type: "boolean", description: "Whether this connection is encrypted." },
          { name: "sessionHours", type: "integer", description: "Session lifetime." },
          { name: "lockout", type: "object", description: "maxFailures, windowSeconds and blockSeconds." },
          { name: "maxBodyBytes", type: "integer", description: "Largest accepted body." },
          { name: "environmentKeys", type: "integer", description: "Keys set in the environment." },
          { name: "managedKeys", type: "integer", description: "Active managed keys." },
        ],
      },
    ],
    curl: `curl ${ORIGIN}/auth/me ${H}`,
    example: `{
  "authRequired": true,
  "authenticated": true,
  "version": "0.1.0",
  "principal": {"id": "env-1", "name": "Environment key", "role": "admin", "source": "environment", "indexes": null},
  "via": "key",
  "sessionExpiresAt": null,
  "security": {"https": true, "secureCookies": true, "sessionHours": 12,
               "lockout": {"maxFailures": 10, "windowSeconds": 300, "blockSeconds": 300},
               "maxBodyBytes": 67108864, "trustProxy": true, "environmentKeys": 1, "managedKeys": 4}
}`,
  },
  {
    slug: "sign-out", title: "Sign out", group: "Sessions", method: "POST", path: "/auth/logout", access: "public",
    summary: "End the current session and clear its cookie.",
    response: [],
    curl: `curl -X POST ${ORIGIN}/auth/logout --cookie "needledb_session=…"`,
    example: `{}`,
  },
  {
    slug: "revoke-sessions", title: "End all sessions", group: "Sessions", method: "POST", path: "/auth/sessions/revoke-all", access: "admin",
    summary: "Rotate the session signing secret, which signs out everyone.",
    about: <p>API keys keep working. Only web-app sessions end, including the caller's.</p>,
    response: [],
    curl: `curl -X POST ${ORIGIN}/auth/sessions/revoke-all ${H}`,
    example: `{}`,
  },

  // ---- operations -------------------------------------------------------------------
  {
    slug: "events", title: "Audit events", group: "Operations", method: "GET", path: "/events", access: "admin",
    summary: "Read the audit log, newest first.",
    keywords: "audit log history",
    query: [
      { name: "limit", type: "integer", defaultValue: "50", description: "Events to return, 1–500." },
      { name: "before", type: "integer", description: "Only events with a smaller id: pass the last id you saw to page back." },
    ],
    response: [{
      name: "events", type: "object[]", description: "Newest first.", children: [
        { name: "id", type: "integer", description: "Increasing event id." },
        { name: "ts", type: "number", description: "Unix time." },
        { name: "action", type: "string", description: <>Such as auth.signed_in. See the <a href="#/docs/guides/audit-log">full list</a>.</> },
        { name: "actorId", type: "string | null", description: "The key that acted." },
        { name: "actorName", type: "string | null", description: "Its name." },
        { name: "ip", type: "string | null", description: "Client address." },
        { name: "target", type: "string | null", description: "Index or key affected." },
        { name: "ok", type: "boolean", description: "Whether it succeeded." },
        { name: "detail", type: "object | null", description: "Extra context." },
      ],
    }],
    curl: `curl "${ORIGIN}/events?limit=2" ${H}`,
    example: `{
  "events": [
    {"id": 812, "ts": 1789412531.2, "action": "key.created", "actorId": "env-1", "actorName": "Environment key",
     "ip": "10.0.4.18", "target": "search-api", "ok": true,
     "detail": {"id": "key_3f9a2c71b04e", "role": "read", "indexes": ["products"], "expiresInDays": 90}},
    {"id": 811, "ts": 1789412420.7, "action": "auth.key_rejected", "actorId": null, "actorName": null,
     "ip": "203.0.113.9", "target": null, "ok": false, "detail": {"path": "/indexes"}}
  ]
}`,
  },
  {
    slug: "health", title: "Health", group: "Operations", method: "GET", path: "/health", access: "public",
    summary: "Liveness check for load balancers and orchestrators.",
    response: [{ name: "status", type: "string", description: "ok." }],
    curl: `curl ${ORIGIN}/health`,
    python: `db.health()`,
    example: `{"status": "ok"}`,
  },
  {
    slug: "stats", title: "Server stats", group: "Operations", method: "GET", path: "/stats", access: "read",
    summary: "Totals, process info and live traffic: what the app's overview shows.",
    response: [
      { name: "version", type: "string", description: "Server version." },
      { name: "dataDir", type: "string | null", description: "Data directory. Admin keys only." },
      { name: "authEnabled", type: "boolean", description: "Whether keys are required." },
      { name: "totals", type: "object", description: "indexes, vectors, memoryBytes and storageBytes." },
      { name: "process", type: "object", description: "rssBytes, cpuCount, threads and pid." },
      { name: "requests", type: "object", description: "QPS and p50/p99 over the last minute: overall, per route and per index." },
      { name: "indexes", type: "object[]", description: "Index descriptions." },
    ],
    curl: `curl ${ORIGIN}/stats ${H}`,
    python: `db.stats().totals`,
    example: `{
  "version": "0.1.0",
  "dataDir": "/var/lib/needledb",
  "authEnabled": true,
  "totals": {"indexes": 3, "vectors": 1204882, "memoryBytes": 7512334336, "storageBytes": 9120044032},
  "process": {"rssBytes": 8012210176, "cpuCount": 16, "threads": 41, "pid": 1},
  "requests": {"windowSeconds": 60, "uptimeSeconds": 86211.4, "errors": 0,
               "all": {"count": 5412, "qps": 90.2, "p50Ms": 1.9, "p99Ms": 11.4}, "routes": {}, "indexes": {}},
  "indexes": []
}`,
  },
  {
    slug: "metrics", title: "Prometheus metrics", group: "Operations", method: "GET", path: "/metrics", access: "read",
    summary: "Counters, latency histograms and index gauges in Prometheus text format.",
    keywords: "prometheus monitoring grafana",
    about: (
      <>
        <p>Metrics cover every index, so keys scoped to particular indexes are refused.</p>
        <DocTable head={["Metric", "Type", "Labels"]} rows={[
          [<C>needledb_requests_total</C>, "counter", "route, method, index, status"],
          [<C>needledb_request_latency_ms</C>, "histogram", "route"],
          [<C>needledb_vectors</C>, "gauge", "index, namespace"],
          [<C>needledb_index_memory_bytes_estimate</C>, "gauge", "index"],
          [<C>needledb_index_storage_bytes</C>, "gauge", "index"],
        ]} />
      </>
    ),
    response: [],
    curl: `curl ${ORIGIN}/metrics ${H}`,
    example: `# TYPE needledb_requests_total counter
needledb_requests_total{route="/indexes/{name}/query",method="POST",index="products",status="200"} 5412
# TYPE needledb_vectors gauge
needledb_vectors{index="products",namespace=""} 48210`,
  },
];

function EndpointPage({ e }: { e: Endpoint }) {
  const status = e.status ?? 200;
  const tabs = [
    { label: "cURL", lang: "bash" as const, code: e.curl },
    ...(e.python ? [{ label: "Python", lang: "python" as const, code: e.python }] : []),
  ];
  return (
    <div className="api-page">
      <div className="api-main">
        <EndpointBar method={e.method} path={e.path} />
        <div className="api-access">{e.access === "public" ? <IconShield size={15} /> : <IconKey size={15} />}{ACCESS[e.access]}</div>
        {e.about && <div className="api-about">{e.about}</div>}
        {e.pathParams && <Fields title="Path parameters" fields={e.pathParams} />}
        {e.query && <Fields title="Query parameters" fields={e.query} />}
        {e.body && <Fields title="Body" fields={e.body} />}
        {e.response.length > 0 && <Fields title="Response" fields={e.response} />}
      </div>
      <aside className="api-examples">
        <CodeTabs tabs={tabs} />
        <CodeBlock lang={e.slug === "metrics" ? "bash" : "json"} title={`${status} ${STATUS[status] ?? ""}`} code={e.example} />
      </aside>
    </div>
  );
}

const OVERVIEW: DocPage[] = [
  {
    slug: "introduction",
    title: "API reference",
    group: "Overview",
    description: "A JSON-over-HTTP API shaped like Pinecone's, served by your NeedleDB server.",
    keywords: "rest http base url authentication",
    render: () => (
      <>
        <H2 id="base-url">Base URL</H2>
        <p>Every path in this reference is relative to your server:</p>
        <CodeBlock lang="bash" title="Base URL" code={ORIGIN} />
        <p>Data-plane paths start with an index's host, <C>{`${ORIGIN}/indexes/<name>`}</C>.</p>

        <H2 id="authentication">Authentication</H2>
        <p>Send a key in <C>Api-Key</C> or <C>Authorization: Bearer</C>. Each endpoint lists the role it needs. See <a href="#/docs/guides/authentication">authentication</a>.</p>
        <CodeBlock lang="bash" title="Terminal" code={`curl ${ORIGIN}/indexes -H "Api-Key: $NEEDLEDB_API_KEY"`} />

        <H2 id="requests">Requests and responses</H2>
        <ul>
          <li>Bodies are JSON, sent with <C>Content-Type: application/json</C>.</li>
          <li>Body fields accept camelCase or snake_case: <C>topK</C> and <C>top_k</C> are the same.</li>
          <li>Responses are JSON. Errors use one <a href="#/docs/api/errors">error format</a>.</li>
        </ul>

        <H2 id="explore">Explore</H2>
        <CardGroup>
          <DocCard title="Query" icon={<IconSearch size={18} />} href="#/docs/api/query">The endpoint you'll call most.</DocCard>
          <DocCard title="Create an index" icon={<IconCode size={18} />} href="#/docs/api/create-index">Dimension, metric and structure.</DocCard>
          <DocCard title="Create a key" icon={<IconKey size={18} />} href="#/docs/api/create-key">Scoped, expiring access.</DocCard>
          <DocCard title="Prometheus metrics" icon={<IconActivity size={18} />} href="#/docs/api/metrics">Monitor traffic and size.</DocCard>
        </CardGroup>

        <Callout kind="tip" title="Interactive explorer">
          The server also serves an OpenAPI explorer at <a href="/docs" target="_blank" rel="noreferrer">/docs</a>. It needs a key or a signed-in session.
        </Callout>
      </>
    ),
  },
  {
    slug: "errors",
    title: "Errors",
    group: "Overview",
    description: "Every error has an HTTP status, a stable code and a message that says what to fix.",
    keywords: "error codes status 400 401 403 404 409 413 429 500",
    render: () => (
      <>
        <H2 id="format">Format</H2>
        <CodeBlock lang="json" title="400 Bad Request" code={`{
  "error": {
    "code": "INVALID_ARGUMENT",
    "message": "query vector must have dimension 1536"
  }
}`} />

        <H2 id="codes">Codes</H2>
        <DocTable head={["Status", "Code", "Meaning", "Python exception"]} rows={[
          ["400", <C>INVALID_ARGUMENT</C>, "The request is malformed or breaks a limit.", <C>InvalidArgument</C>],
          ["401", <C>UNAUTHENTICATED</C>, "No key, or the key is invalid, expired or revoked.", <C>Unauthenticated</C>],
          ["403", <C>PERMISSION_DENIED</C>, "The key's role or scope doesn't allow this, or a cross-site cookie write.", <C>PermissionDenied</C>],
          ["404", <C>NOT_FOUND</C>, "The index, record or key doesn't exist, or is outside the key's scope.", <C>NotFound</C>],
          ["409", <C>ALREADY_EXISTS</C>, "An index with that name exists.", <C>AlreadyExists</C>],
          ["413", <C>PAYLOAD_TOO_LARGE</C>, "The body is over the size limit.", <C>PayloadTooLarge</C>],
          ["429", <C>RESOURCE_EXHAUSTED</C>, "Too many failed attempts. Wait for Retry-After seconds.", <C>ResourceExhausted</C>],
          ["500", <C>INTERNAL</C>, "Something went wrong on the server. Details are in its log.", <C>NeedleError</C>],
        ]} />

        <H2 id="retrying">Retrying</H2>
        <p>Retry <C>502</C>, <C>503</C> and <C>504</C> with backoff; the Python SDK does this automatically. Don't retry <C>4xx</C> errors without changing the request.</p>
      </>
    ),
  },
  {
    slug: "limits",
    title: "Limits",
    group: "Overview",
    description: "The bounds every request is checked against.",
    keywords: "maximum size quota dimension top_k batch",
    render: () => (
      <>
        <H2 id="data">Data</H2>
        <DocTable head={["What", "Limit"]} rows={[
          ["Dimension", "1–65,536"],
          ["Index name", "1–45 lowercase letters, digits and hyphens"],
          ["Record id", "512 bytes"],
          ["Metadata per record", "40 KB of JSON"],
          ["Namespace name", "256 bytes"],
          ["Records per upsert", "10,000"],
          ["Ids per fetch", "1,000"],
        ]} />

        <H2 id="requests">Requests</H2>
        <DocTable head={["What", "Limit"]} rows={[
          ["Request body", "64 MB, set with NEEDLEDB_MAX_BODY_MB"],
          ["topK", "1–10,000"],
          ["efSearch and hnsw.ef_search", "1–10,000"],
          ["List page size", "1–10,000"],
          ["Vector map sample", "1–5,000"],
          ["Audit events per page", "1–500"],
        ]} />

        <H2 id="index-settings">Index settings</H2>
        <DocTable head={["Setting", "Range"]} rows={[
          ["hnsw.m", "4–128"],
          ["hnsw.ef_construction", "16–2,000"],
        ]} />

        <H2 id="access">Access</H2>
        <DocTable head={["What", "Limit"]} rows={[
          ["Key name", "1–64 characters"],
          ["Key expiry", "1–3,650 days"],
          ["Session lifetime", "12 hours"],
          ["Failed attempts", "10 per address in 5 minutes, then a 5-minute block"],
        ]} />
      </>
    ),
  },
];

export const REFERENCE: DocPage[] = [
  ...OVERVIEW,
  ...ENDPOINTS.map((e): DocPage => ({
    slug: e.slug,
    title: e.title,
    group: e.group,
    description: e.summary,
    method: e.method,
    keywords: `${e.path} ${e.keywords ?? ""}`,
    wide: true,
    render: () => <EndpointPage e={e} />,
  })),
];
