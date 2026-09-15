import { useEffect, useState } from "react";
import { api, ApiError, type IndexInfo, type IndexStats } from "../api";
import { AreaChart, Sparkline } from "../charts";
import { CodeTabs, type Lang } from "../code";
import {
  IconActivity,
  IconArrowRight,
  IconBolt,
  IconBook,
  IconCheck,
  IconChip,
  IconCopy,
  IconGauge,
  IconIndexes,
  IconKey,
  IconRocket,
  IconRows,
  IconSearch,
  IconSliders,
  IconTarget,
  IconTrash,
  IconUpload,
} from "../icons";
import { colorFor, copyText, fmtBytes, fmtInt, fmtMs, go, randomUnitVector, usePoll } from "../lib";
import { useSession } from "../session";
import { Badge, Button, Card, Empty, ErrorNote, Field, IndexAvatar, PageHeader, Skeleton, Tabs, useToast } from "../ui";
import BrowsePanel from "./BrowsePanel";
import QueryPanel from "./QueryPanel";
import UpsertPanel from "./UpsertPanel";
import VectorMap from "./VectorMap";

type Sample = { t: number; qps: number; p50: number | null; p99: number | null; count: number };

const METRIC_LABEL: Record<string, string> = { cosine: "Cosine similarity", dotproduct: "Dot product", euclidean: "Euclidean distance" };

export default function IndexPage({ name, tab, params, onChanged }: {
  name: string;
  tab: string;
  params: URLSearchParams;
  onChanged: () => void;
}) {
  const { can } = useSession();
  const info = usePoll(() => api.index(name), 3000, [name]);
  const described = usePoll(() => api.describeStats(name), 3000, [name]);
  const live = usePoll(api.stats, 2000);
  const [history, setHistory] = useState<Sample[]>([]);
  const route = `/indexes/${encodeURIComponent(name)}`;

  useEffect(() => {
    if (!live.data) return;
    const t = live.data.requests.indexes[name];
    setHistory((h) => [...h.slice(-89), { t: Date.now(), qps: t?.qps ?? 0, p50: t?.p50Ms ?? null, p99: t?.p99Ms ?? null, count: t?.count ?? 0 }]);
  }, [live.data, name]);

  const tabs = [
    { id: "overview", label: "Overview", href: `#${route}/overview` },
    { id: "explore", label: "Explore", href: `#${route}/explore` },
    { id: "query", label: "Query", href: `#${route}/query` },
    { id: "browse", label: "Browse", href: `#${route}/browse` },
    ...(can("write") ? [{ id: "upsert", label: "Upsert", href: `#${route}/upsert` }] : []),
    ...(can("admin") ? [{ id: "settings", label: "Settings", href: `#${route}/settings` }] : []),
  ];
  const current = tabs.some((t) => t.id === tab) ? tab : "overview";

  if (!info.data) {
    const missing = info.error instanceof ApiError && info.error.status === 404;
    return (
      <>
        <PageHeader title={name} />
        {missing ? (
          <Card>
            <Empty icon={<IconIndexes size={24} />} title={`There's no index named “${name}”`}
              action={<Button onClick={() => go("/indexes")}>All indexes</Button>}>
              It may have been deleted, or your key may not have access to it.
            </Empty>
          </Card>
        ) : info.error ? <ErrorNote error={info.error} /> : <Skeleton height={320} radius={16} />}
      </>
    );
  }

  const index = info.data;
  const namespaces = Object.keys(described.data?.namespaces ?? {});
  const latest = history[history.length - 1];
  const graph = index.annTypes.includes("hnsw") || (!index.annTypes.length && index.index_type === "hnsw");
  const refresh = () => {
    void info.reload();
    void described.reload();
    onChanged();
  };

  return (
    <>
      <IndexHero index={index} route={route} />

      <div className="spec-strip">
        <Spec icon={<IconIndexes size={15} />} label="Vectors" value={fmtInt(index.vectorCount)}
          hint={`${index.namespaceCount} ${index.namespaceCount === 1 ? "namespace" : "namespaces"}`} />
        <Spec icon={<IconTarget size={15} />} label="Dimensions" value={fmtInt(index.dimension)} hint={METRIC_LABEL[index.metric]} />
        <Spec icon={<IconGauge size={15} />} label="Structure" value={graph ? "HNSW graph" : "Flat, exact"}
          hint={graph ? `m ${index.hnsw.m} · ef_search ${index.hnsw.ef_search}` : index.index_type === "auto" ? "HNSW from 20k vectors" : "100% recall"} />
        <Spec icon={<IconChip size={15} />} label="Memory" value={fmtBytes(index.memoryBytes)} hint={`${fmtBytes(index.storageBytes)} on disk`} />
        <Spec icon={<IconBolt size={15} />} label="Queries / s" value={(latest?.qps ?? 0).toFixed(1)}
          hint={`p99 ${fmtMs(latest?.p99)}`} spark={history.map((s) => s.qps)} />
      </div>

      <Tabs label="Index sections" items={tabs} current={current} />

      {/* Panels stay mounted so a half-written query survives switching tabs. */}
      <div hidden={current !== "overview"}>
        <IndexOverview info={index} namespaces={namespaces} stats={described.data} history={history}
          canWrite={can("write")} isAdmin={can("admin")} onSeeded={refresh} onExplore={() => go(`${route}/explore`)} />
      </div>
      <div hidden={current !== "explore"}>
        {current === "explore" && (
          <VectorMap info={index} namespaces={namespaces}
            onSimilar={(id, ns) => go(`${route}/query?id=${encodeURIComponent(id)}&namespace=${encodeURIComponent(ns)}`)} />
        )}
      </div>
      <div hidden={current !== "query"}><QueryPanel info={index} namespaces={namespaces} params={params} active={current === "query"} /></div>
      <div hidden={current !== "browse"}><BrowsePanel info={index} namespaces={namespaces} active={current === "browse"} onChanged={refresh} /></div>
      {can("write") && <div hidden={current !== "upsert"}><UpsertPanel info={index} namespaces={namespaces} onDone={refresh} /></div>}
      {can("admin") && (
        <div hidden={current !== "settings"} className="stack">
          <SettingsPanel key={index.hnsw.ef_search} info={index}
            onSaved={(next) => { info.setData(next); onChanged(); }}
            onDeleted={() => { onChanged(); go("/indexes"); }} />
        </div>
      )}
    </>
  );
}

function IndexHero({ index, route }: { index: IndexInfo; route: string }) {
  const [copied, setCopied] = useState(false);
  const ready = index.status.state === "Ready";
  return (
    <header className="ix-hero">
      <div className="ix-identity">
        <IndexAvatar name={index.name} size={58} />
        <div className="ix-identity-text">
          <div className="ix-title">
            <h1>{index.name}</h1>
            <Badge tone={ready ? "good" : "warn"} dot>{ready ? "Ready" : "Rebuilding graph"}</Badge>
          </div>
          <button type="button" className="ix-host" title="Copy the index host"
            onClick={async () => {
              if (await copyText(index.host)) {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1500);
              }
            }}>
            <span className="ix-host-label">Host</span>
            <span className="ix-host-url">{index.host}</span>
            {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
          </button>
        </div>
      </div>
      <div className="page-actions">
        <a className="btn btn-secondary btn-md" href="#/docs/api/query"><IconBook size={16} />Docs</a>
        <Button icon={<IconTarget size={16} />} onClick={() => go(`${route}/explore`)}>Explore</Button>
        <Button variant="primary" icon={<IconSearch size={16} />} onClick={() => go(`${route}/query`)}>Query</Button>
      </div>
    </header>
  );
}

function Spec({ icon, label, value, hint, spark }: { icon: React.ReactNode; label: string; value: string; hint: string; spark?: number[] }) {
  return (
    <div className="spec">
      <div className="spec-label">{icon}{label}</div>
      <div className="spec-row">
        <span className="spec-value">{value}</span>
        {spark && spark.length > 1 && <Sparkline values={spark} width={72} height={26} color="#12a189" />}
      </div>
      <span className="spec-hint">{hint}</span>
    </div>
  );
}

function connectTabs(info: IndexInfo): { label: string; lang: Lang; code: string }[] {
  const origin = window.location.origin;
  return [
    {
      label: "NeedleDB SDK", lang: "python",
      code: `from needledb import NeedleDB

db = NeedleDB("${origin}")          # reads NEEDLEDB_API_KEY
index = db.Index("${info.name}")

index.upsert([("doc-1", embedding, {"title": "Hello"})])
res = index.query(vector=embedding, top_k=10, include_metadata=True)
for match in res.matches:
    print(match.score, match.metadata["title"])`,
    },
    {
      label: "Pinecone client", lang: "python",
      code: `from pinecone import Pinecone

pc = Pinecone(api_key=NEEDLEDB_API_KEY)
index = pc.Index(host="${info.host}")

res = index.query(vector=embedding, top_k=10, include_metadata=True)`,
    },
    {
      label: "cURL", lang: "bash",
      code: `curl ${info.host}/query \\
  -H "Api-Key: $NEEDLEDB_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"vector": [/* ${info.dimension} floats */], "topK": 10, "includeMetadata": true}'`,
    },
  ];
}

function IndexOverview({ info, namespaces, stats, history, canWrite, isAdmin, onSeeded, onExplore }: {
  info: IndexInfo;
  namespaces: string[];
  stats?: IndexStats;
  history: Sample[];
  canWrite: boolean;
  isAdmin: boolean;
  onSeeded: () => void;
  onExplore: () => void;
}) {
  const latest = history[history.length - 1];
  const entries = Object.entries(stats?.namespaces ?? {}).sort((a, b) => b[1].vectorCount - a[1].vectorCount);
  const total = entries.reduce((a, [, s]) => a + s.vectorCount, 0);

  if (stats && info.vectorCount === 0 && entries.every(([, s]) => s.vectorCount === 0)) {
    return <GetStarted info={info} canWrite={canWrite} isAdmin={isAdmin} onSeeded={onSeeded} />;
  }

  return (
    <div className="ix-grid">
      <Card className="span-2" icon={<IconTarget size={16} />} title="Vector map" subtitle="A sample of this index, laid out by similarity"
        actions={<Button size="sm" icon={<IconArrowRight size={15} />} onClick={onExplore}>Open explorer</Button>}>
        <VectorMap compact info={info} namespaces={namespaces} onOpen={onExplore} />
      </Card>

      <Card icon={<IconActivity size={16} />} title="Live traffic" subtitle="Requests to this index">
        <div className="chart-head">
          <div><span className="chart-figure">{(latest?.qps ?? 0).toFixed(1)}</span><span className="chart-unit">requests / s</span></div>
        </div>
        <AreaChart times={history.map((s) => s.t)} height={176} format={(v) => v.toFixed(v < 1 ? 2 : v < 10 ? 1 : 0)} empty="No requests yet"
          series={[{ name: "Requests/s", color: "#12a189", values: history.map((s) => s.qps) }]} />
        <dl className="traffic-stats">
          <div><dt>p50</dt><dd>{fmtMs(latest?.p50)}</dd></div>
          <div><dt>p99</dt><dd>{fmtMs(latest?.p99)}</dd></div>
          <div><dt>Last minute</dt><dd>{fmtInt(latest?.count ?? 0)}</dd></div>
        </dl>
      </Card>

      <Card className="span-2" icon={<IconBook size={16} />} title="Connect" subtitle="Pre-filled for this index. Set NEEDLEDB_API_KEY to a key with access."
        actions={<a className="link small" href="#/docs/guides/quickstart">Quickstart</a>}>
        <CodeTabs tabs={connectTabs(info)} />
      </Card>

      <Card icon={<IconRows size={16} />} title="Namespaces" subtitle={`${entries.length} in this index`}>
        <ul className="ns-list">
          {entries.map(([ns, s]) => (
            <li key={ns}>
              <div className="ns-head"><b>{ns === "" ? "Default" : ns}</b><span>{fmtInt(s.vectorCount)}</span></div>
              <div className="ns-bar"><i style={{ width: `${total ? (s.vectorCount / total) * 100 : 0}%`, background: colorFor(info.name) }} /></div>
              <div className="ns-meta">
                {s.indexType === "hnsw" ? "HNSW graph" : "Flat, exact"}
                {s.tombstones ? ` · ${fmtInt(s.tombstones)} tombstones` : ""}
                {s.building ? " · rebuilding" : ""}
              </div>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

const SAMPLE_CATEGORIES = ["Outdoor gear", "Kitchen", "Books", "Audio"];

function GetStarted({ info, canWrite, isAdmin, onSeeded }: { info: IndexInfo; canWrite: boolean; isAdmin: boolean; onSeeded: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(0);
  const total = 240;

  async function seed() {
    setBusy(true);
    setDone(0);
    try {
      const d = info.dimension;
      const centres = SAMPLE_CATEGORIES.map(() => randomUnitVector(d));
      const records = Array.from({ length: total }, (_, i) => {
        const c = i % SAMPLE_CATEGORIES.length;
        const noise = randomUnitVector(d);
        const v = centres[c].map((x, j) => x + 0.6 * noise[j]);
        let norm = 0;
        for (const x of v) norm += x * x;
        norm = Math.sqrt(norm) || 1;
        return {
          id: `sample-${String(i + 1).padStart(3, "0")}`,
          values: v.map((x) => Math.round((x / norm) * 1e5) / 1e5),
          metadata: {
            title: `${SAMPLE_CATEGORIES[c]} sample ${i + 1}`,
            category: SAMPLE_CATEGORIES[c],
            price: Math.round(5 + Math.random() * 195),
            in_stock: Math.random() > 0.3,
            sample: true,
          },
        };
      });
      const batch = d > 2000 ? 40 : 120;
      for (let i = 0; i < records.length; i += batch) {
        await api.upsert(info.name, records.slice(i, i + batch), "");
        setDone(Math.min(total, i + batch));
      }
      toast(`Inserted ${total} sample vectors`, "good");
      onSeeded();
    } catch (err) {
      toast((err as Error).message, "bad");
    } finally {
      setBusy(false);
    }
  }

  const upsert = `from needledb import NeedleDB

index = NeedleDB("${window.location.origin}").Index("${info.name}")
index.upsert([
    ("doc-1", embedding, {"title": "First document", "category": "docs"}),   # ${info.dimension} floats
])`;
  const query = `res = index.query(vector=embedding, top_k=5, include_metadata=True,
                  filter={"category": "docs"})`;

  return (
    <div className="onboarding">
      <div className="onboarding-hero">
        <span className="onboarding-icon"><IconRocket size={22} /></span>
        <div>
          <h2>Get vectors into {info.name}</h2>
          <p>This index takes {info.dimension}-dimensional vectors compared by {METRIC_LABEL[info.metric].toLowerCase()}. Three steps to your first search.</p>
        </div>
      </div>

      <ol className="steps">
        <li className="step">
          <span className="step-num">1</span>
          <div className="step-body">
            <b>Get an API key</b>
            <p>Use the server's <code>NEEDLEDB_API_KEY</code>, or create a key scoped to this index.</p>
            {isAdmin && <a className="btn btn-secondary btn-sm" href="#/keys?new=1"><IconKey size={15} />Create a key</a>}
          </div>
        </li>
        <li className="step">
          <span className="step-num">2</span>
          <div className="step-body">
            <b>Upsert vectors</b>
            <p>Any ids, any metadata. Writes are durable before they're acknowledged.</p>
            <CodeTabs tabs={[{ label: "Python", lang: "python", code: upsert }, {
              label: "cURL", lang: "bash",
              code: `curl ${info.host}/vectors/upsert \\\n  -H "Api-Key: $NEEDLEDB_API_KEY" -H "Content-Type: application/json" \\\n  -d '{"vectors": [{"id": "doc-1", "values": [/* ${info.dimension} floats */], "metadata": {"title": "First document"}}]}'`,
            }]} />
          </div>
        </li>
        <li className="step">
          <span className="step-num">3</span>
          <div className="step-body">
            <b>Search</b>
            <p>Nearest neighbours, optionally narrowed by a metadata filter.</p>
            <CodeTabs tabs={[{ label: "Python", lang: "python", code: query }]} />
          </div>
        </li>
      </ol>

      {canWrite && (
        <div className="sample-cta">
          <div>
            <b>No embeddings handy?</b>
            <p>Insert {total} sample vectors in four clusters with titles, categories and prices, so you can try Explore and Query right away. Every record is tagged <code>sample: true</code> for easy removal.</p>
          </div>
          <Button variant="primary" icon={<IconUpload size={16} />} onClick={() => void seed()} disabled={busy}>
            {busy ? `Inserting ${done}/${total}…` : "Insert sample data"}
          </Button>
        </div>
      )}
    </div>
  );
}

function SettingsPanel({ info, onSaved, onDeleted }: { info: IndexInfo; onSaved: (info: IndexInfo) => void; onDeleted: () => void }) {
  const toast = useToast();
  const [ef, setEf] = useState(info.hnsw.ef_search);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [confirm, setConfirm] = useState("");
  const [deleting, setDeleting] = useState(false);

  async function save() {
    setSaving(true);
    setError(undefined);
    try {
      onSaved(await api.configure(info.name, ef));
      toast(`Search width set to ${ef}`, "good");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    setDeleting(true);
    try {
      await api.deleteIndex(info.name);
      toast(`Deleted ${info.name}`);
      onDeleted();
    } catch (err) {
      setError((err as Error).message);
      setDeleting(false);
    }
  }

  return (
    <>
      <Card icon={<IconSliders size={16} />} title="Search width"
        subtitle="How many graph candidates each query explores. Wider finds more of the true nearest neighbours and takes longer."
        actions={<a className="link small" href="#/docs/guides/index-structures">Tuning guide</a>}>
        <div className="form narrow">
          <div className="range-row">
            <input type="range" min={8} max={1024} step={8} value={Math.min(ef, 1024)} aria-label="ef_search"
              onChange={(e) => setEf(Number(e.target.value))} />
            <input type="number" min={1} max={10000} value={ef} className="range-number" aria-label="ef_search value"
              onChange={(e) => setEf(Number(e.target.value))} />
          </div>
          <div className="range-scale"><span>Faster</span><span>More accurate</span></div>
          <p className="muted small">Applies to the next query. A request's own <code>efSearch</code> overrides it.</p>
          <ErrorNote error={error} />
          <div className="actions-end">
            <Button variant="primary" onClick={save} disabled={saving || ef === info.hnsw.ef_search || ef < 1}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      </Card>

      <Card icon={<IconTrash size={16} />} title="Delete index" className="card-danger"
        subtitle={<>Removes every vector and namespace in <b>{info.name}</b> from disk. This can't be undone.</>}>
        <div className="form narrow">
          <Field label={`Type “${info.name}” to confirm`} htmlFor="confirm-delete">
            <input id="confirm-delete" value={confirm} autoComplete="off" onChange={(e) => setConfirm(e.target.value)} />
          </Field>
          <div className="actions-end">
            <Button variant="danger-solid" icon={<IconTrash size={16} />} disabled={confirm !== info.name || deleting} onClick={remove}>
              {deleting ? "Deleting…" : "Delete index"}
            </Button>
          </div>
        </div>
      </Card>
    </>
  );
}
