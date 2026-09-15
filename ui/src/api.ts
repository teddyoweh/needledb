export type Metric = "cosine" | "dotproduct" | "euclidean";
export type IndexType = "auto" | "flat" | "hnsw";
export type Role = "read" | "write" | "admin";

export type Principal = {
  id: string;
  name: string;
  role: Role;
  indexes: string[] | null;
  source: "key" | "environment" | "local";
};

export type Security = {
  https: boolean;
  secureCookies: boolean;
  sessionHours: number;
  lockout: { maxFailures: number; windowSeconds: number; blockSeconds: number };
  maxBodyBytes: number;
  trustProxy: boolean;
  environmentKeys: number;
  managedKeys: number;
};

export type Me = {
  authRequired: boolean;
  authenticated: boolean;
  version?: string;
  principal?: Principal;
  via?: "key" | "session" | "local";
  sessionExpiresAt?: number | null;
  security?: Security;
};

export type ApiKey = {
  id: string;
  name: string;
  prefix: string | null;
  role: Role;
  indexes: string[] | null;
  createdAt: number | null;
  lastUsedAt: number | null;
  expiresAt: number | null;
  managed: boolean;
};

export type AuditEvent = {
  id: number;
  ts: number;
  action: string;
  actorId: string | null;
  actorName: string | null;
  ip: string | null;
  target: string | null;
  ok: boolean;
  detail: Record<string, unknown> | null;
};

export type MapPoint = { id: string; x: number; y: number; cluster: number; label: string | null; group?: string | null };
export type VectorMap = { namespace: string; total: number; sampled: number; explained: [number, number]; points: MapPoint[]; colorFields: string[] };

export type EmbedConfig = { provider: string; model: string; field: string };
export type EmbeddingProvider = { id: string; name: string; available: boolean; env: string[]; local: boolean };
export type EmbeddingModel = {
  provider: string;
  id: string;
  name: string;
  dimension: number;
  dimensions: number[];
  description: string;
  vendor: string;
  maxTokens: number;
  multilingual: boolean;
  sizeMb: number | null;
};
export type EmbeddingCatalog = { providers: EmbeddingProvider[]; models: EmbeddingModel[] };

export type CompareResult = {
  provider: string;
  model: string;
  name?: string;
  dimension?: number;
  embedMs?: number;
  matches?: { index: number; score: number }[];
  error?: { code: string; message: string };
};

export type IndexInfo = {
  name: string;
  dimension: number;
  metric: Metric;
  index_type: IndexType;
  hnsw: { m: number; ef_construction: number; ef_search: number };
  embed: EmbedConfig | null;
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
  dataDir: string | null;
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
export type QueryResult = { matches: Match[]; namespace: string; usage: { latencyMs: number; plan: string; embedMs?: number } };
export type NamespaceStats = { vectorCount: number; indexType: string; building: boolean; tombstones: number };
export type IndexStats = {
  dimension: number;
  metric: Metric;
  totalVectorCount: number;
  namespaces: Record<string, NamespaceStats>;
};
export type VectorRecord = { id: string; values?: number[]; metadata: Metadata | null };

export class ApiError extends Error {
  status: number;
  code: string;
  retryAfter?: number;
  constructor(status: number, code: string, message: string, retryAfter?: number) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

const signedOut = new Set<() => void>();

/** Called when the server says the session is gone, so the app can show sign-in. */
export function onSignedOut(listener: () => void): () => void {
  signedOut.add(listener);
  return () => {
    signedOut.delete(listener);
  };
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }
  if (!res.ok) {
    const err = (data as { error?: { code: string; message: string } }).error;
    if (res.status === 401 && !path.startsWith("/auth/")) signedOut.forEach((fn) => fn());
    const retry = Number(res.headers.get("Retry-After")) || undefined;
    throw new ApiError(res.status, err?.code ?? `HTTP_${res.status}`, err?.message ?? (res.statusText || "Request failed"), retry);
  }
  return data as T;
}

const seg = encodeURIComponent;

export const api = {
  me: () => call<Me>("GET", "/auth/me"),
  login: (apiKey: string) => call<Me>("POST", "/auth/login", { apiKey }),
  logout: () => call<object>("POST", "/auth/logout", {}),
  revokeAllSessions: () => call<object>("POST", "/auth/sessions/revoke-all", {}),

  keys: () => call<{ keys: ApiKey[] }>("GET", "/keys"),
  createKey: (body: { name: string; role: Role; indexes?: string[]; expiresInDays?: number }) => call<ApiKey & { key: string }>("POST", "/keys", body),
  revokeKey: (id: string) => call<object>("DELETE", `/keys/${seg(id)}`),
  events: (limit = 50) => call<{ events: AuditEvent[] }>("GET", `/events?limit=${limit}`),

  stats: () => call<Stats>("GET", "/stats"),
  indexes: () => call<{ indexes: IndexInfo[] }>("GET", "/indexes"),
  index: (name: string) => call<IndexInfo>("GET", `/indexes/${seg(name)}`),
  createIndex: (body: { name: string; dimension: number; metric: Metric; index_type: IndexType; hnsw: IndexInfo["hnsw"]; embed?: { provider: string; model: string } }) =>
    call<IndexInfo>("POST", "/indexes", body),
  embeddingModels: () => call<EmbeddingCatalog>("GET", "/embeddings/models"),
  compareModels: (body: { query: string; documents: string[]; models: { provider: string; model: string }[]; topK: number }) =>
    call<{ results: CompareResult[] }>("POST", "/playground/compare", body),
  configure: (name: string, efSearch: number) =>
    call<IndexInfo>("PATCH", `/indexes/${seg(name)}`, { hnsw: { ef_search: efSearch } }),
  deleteIndex: (name: string) => call<object>("DELETE", `/indexes/${seg(name)}`),
  vectorMap: (name: string, namespace: string, limit = 1500, colorBy?: string | null) => {
    const qs = new URLSearchParams({ namespace, limit: String(limit) });
    if (colorBy) qs.set("color_by", colorBy);
    return call<VectorMap>("GET", `/indexes/${seg(name)}/map?${qs}`);
  },
  describeStats: (name: string) => call<IndexStats>("POST", `/indexes/${seg(name)}/describe_index_stats`, {}),
  query: (name: string, body: Record<string, unknown>) => call<QueryResult>("POST", `/indexes/${seg(name)}/query`, body),
  list: (name: string, params: { namespace: string; prefix?: string; limit: number; paginationToken?: string }) => {
    const qs = new URLSearchParams({ namespace: params.namespace, limit: String(params.limit) });
    if (params.prefix) qs.set("prefix", params.prefix);
    if (params.paginationToken) qs.set("paginationToken", params.paginationToken);
    return call<{ vectors: { id: string }[]; pagination: { next?: string } }>("GET", `/indexes/${seg(name)}/vectors/list?${qs}`);
  },
  fetch: (name: string, ids: string[], namespace: string, includeValues = true) =>
    call<{ vectors: Record<string, VectorRecord> }>("POST", `/indexes/${seg(name)}/vectors/fetch`, { ids, namespace, includeValues }),
  upsert: (name: string, vectors: unknown[], namespace: string) =>
    call<{ upsertedCount: number }>("POST", `/indexes/${seg(name)}/vectors/upsert`, { vectors, namespace }),
  deleteVectors: (name: string, ids: string[], namespace: string) =>
    call<{ deletedCount: number }>("POST", `/indexes/${seg(name)}/vectors/delete`, { ids, namespace }),
};
