export type Metric = "cosine" | "dotproduct" | "euclidean";
export type IndexType = "auto" | "flat" | "hnsw";

export type IndexInfo = {
  name: string;
  dimension: number;
  metric: Metric;
  index_type: IndexType;
  hnsw: { m: number; ef_construction: number; ef_search: number };
  created_at: string;
  vectorCount: number;
  namespaceCount: number;
  annTypes: string[];
  memoryBytes: number;
  storageBytes: number;
  status: { ready: boolean; state: string };
  host: string;
};

export type Traffic = {
  qps: number;
  count: number;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
};

export type Stats = {
  version: string;
  dataDir: string;
  authEnabled: boolean;
  totals: { indexes: number; vectors: number; memoryBytes: number; storageBytes: number };
  process: { rssBytes: number | null; cpuCount: number; threads: number; pid: number };
  requests: {
    windowSeconds: number;
    uptimeSeconds: number;
    errors: number;
    all: Traffic;
    routes: Record<string, Traffic>;
    indexes: Record<string, Traffic>;
  };
  indexes: IndexInfo[];
};

export type Metadata = Record<string, string | number | boolean | string[]>;
export type Match = { id: string; score: number | null; values?: number[]; metadata?: Metadata | null };
export type QueryResult = { matches: Match[]; namespace: string; usage: { latencyMs: number; plan: string } };
export type NamespaceStats = { vectorCount: number; indexType: string; building: boolean; tombstones: number };
export type IndexStats = {
  dimension: number;
  metric: Metric;
  totalVectorCount: number;
  namespaces: Record<string, NamespaceStats>;
};
export type VectorRecord = { id: string; values: number[]; metadata: Metadata | null };

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const KEY_STORAGE = "needledb.apiKey";

export const apiKey = {
  get(): string {
    try {
      return localStorage.getItem(KEY_STORAGE) ?? "";
    } catch {
      return "";
    }
  },
  set(value: string) {
    try {
      if (value) localStorage.setItem(KEY_STORAGE, value);
      else localStorage.removeItem(KEY_STORAGE);
    } catch {
      /* storage unavailable: the key lasts for this page only */
    }
  },
};

const unauthorized = new Set<() => void>();

export function onUnauthorized(listener: () => void): () => void {
  unauthorized.add(listener);
  return () => {
    unauthorized.delete(listener);
  };
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  const key = apiKey.get();
  if (key) headers["Api-Key"] = key;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data: unknown = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }
  if (!res.ok) {
    const err = (data as { error?: { code: string; message: string } }).error;
    if (res.status === 401) unauthorized.forEach((fn) => fn());
    throw new ApiError(res.status, err?.code ?? `HTTP_${res.status}`, err?.message ?? (res.statusText || "Request failed"));
  }
  return data as T;
}

const seg = encodeURIComponent;

export const api = {
  health: () => call<{ status: string; version: string }>("GET", "/health"),
  stats: () => call<Stats>("GET", "/stats"),
  indexes: () => call<{ indexes: IndexInfo[] }>("GET", "/indexes"),
  index: (name: string) => call<IndexInfo>("GET", `/indexes/${seg(name)}`),
  createIndex: (body: { name: string; dimension: number; metric: Metric; index_type: IndexType; hnsw: IndexInfo["hnsw"] }) =>
    call<IndexInfo>("POST", "/indexes", body),
  configure: (name: string, efSearch: number) =>
    call<IndexInfo>("PATCH", `/indexes/${seg(name)}`, { hnsw: { ef_search: efSearch } }),
  deleteIndex: (name: string) => call<object>("DELETE", `/indexes/${seg(name)}`),
  describeStats: (name: string) => call<IndexStats>("POST", `/indexes/${seg(name)}/describe_index_stats`, {}),
  query: (name: string, body: Record<string, unknown>) => call<QueryResult>("POST", `/indexes/${seg(name)}/query`, body),
  list: (name: string, params: { namespace: string; prefix?: string; limit: number; paginationToken?: string }) => {
    const qs = new URLSearchParams({ namespace: params.namespace, limit: String(params.limit) });
    if (params.prefix) qs.set("prefix", params.prefix);
    if (params.paginationToken) qs.set("paginationToken", params.paginationToken);
    return call<{ vectors: { id: string }[]; pagination: { next?: string } }>("GET", `/indexes/${seg(name)}/vectors/list?${qs}`);
  },
  fetch: (name: string, ids: string[], namespace: string) =>
    call<{ vectors: Record<string, VectorRecord> }>("POST", `/indexes/${seg(name)}/vectors/fetch`, { ids, namespace }),
  upsert: (name: string, vectors: unknown[], namespace: string) =>
    call<{ upsertedCount: number }>("POST", `/indexes/${seg(name)}/vectors/upsert`, { vectors, namespace }),
  deleteVectors: (name: string, ids: string[], namespace: string) =>
    call<{ deletedCount: number }>("POST", `/indexes/${seg(name)}/vectors/delete`, { ids, namespace }),
};
