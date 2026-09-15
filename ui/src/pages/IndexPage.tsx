import { useState } from "react";
import { api, ApiError, type IndexInfo, type IndexStats } from "../api";
import {
  IconBook,
  IconCheck,
  IconChip,
  IconClock,
  IconDisk,
  IconGauge,
  IconGlobe,
  IconIndexes,
  IconRows,
  IconSearch,
  IconSliders,
  IconTarget,
  IconTrash,
} from "../icons";
import { fmtBytes, fmtInt, go, structureLabel, usePoll } from "../lib";
import { useSession } from "../session";
import {
  Badge,
  Button,
  Card,
  CopyButton,
  Empty,
  ErrorNote,
  Field,
  PageHeader,
  PropertyList,
  Segmented,
  Skeleton,
  Stat,
  Tabs,
  useToast,
} from "../ui";
import BrowsePanel from "./BrowsePanel";
import QueryPanel from "./QueryPanel";
import UpsertPanel from "./UpsertPanel";

export default function IndexPage({ name, tab, params, onChanged }: {
  name: string;
  tab: string;
  params: URLSearchParams;
  onChanged: () => void;
}) {
  const { can } = useSession();
  const info = usePoll(() => api.index(name), 3000, [name]);
  const stats = usePoll(() => api.describeStats(name), 3000, [name]);
  const base = `#/indexes/${encodeURIComponent(name)}`;

  const tabs = [
    { id: "overview", label: "Overview", href: `${base}/overview` },
    { id: "query", label: "Query", href: `${base}/query` },
    { id: "browse", label: "Browse", href: `${base}/browse` },
    ...(can("write") ? [{ id: "upsert", label: "Upsert", href: `${base}/upsert` }] : []),
    ...(can("admin") ? [{ id: "settings", label: "Settings", href: `${base}/settings` }] : []),
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
  const namespaces = Object.keys(stats.data?.namespaces ?? {});
  const ready = index.status.state === "Ready";
  const refresh = () => {
    void info.reload();
    void stats.reload();
    onChanged();
  };

  return (
    <>
      <PageHeader title={index.name}
        subtitle={`${fmtInt(index.vectorCount)} vectors across ${index.namespaceCount} ${index.namespaceCount === 1 ? "namespace" : "namespaces"}`}
        actions={<>
          <CopyButton text={index.host} label="Copy host" size="md" />
          <Button variant="primary" icon={<IconSearch size={16} />} onClick={() => go(`/indexes/${encodeURIComponent(name)}/query`)}>Query</Button>
        </>}>
        <PropertyList items={[
          { icon: <IconCheck size={15} />, label: "Status", value: <Badge tone={ready ? "good" : "warn"} dot>{ready ? "Ready" : "Rebuilding graph"}</Badge> },
          { icon: <IconTarget size={15} />, label: "Dimension", value: index.dimension },
          { icon: <IconGauge size={15} />, label: "Metric", value: index.metric },
          { icon: <IconIndexes size={15} />, label: "Structure", value: structureLabel(index) },
          { icon: <IconSliders size={15} />, label: "Search width", value: `ef_search ${index.hnsw.ef_search}` },
          { icon: <IconClock size={15} />, label: "Created", value: new Date(index.created_at).toLocaleDateString(undefined, { dateStyle: "medium" }) },
        ]} />
      </PageHeader>

      <Tabs label="Index sections" items={tabs} current={current} />

      {/* Panels stay mounted so a half-written query survives switching tabs. */}
      <div hidden={current !== "overview"} className="stack"><IndexOverview info={index} stats={stats.data} /></div>
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

function IndexOverview({ info, stats }: { info: IndexInfo; stats?: IndexStats }) {
  const [lang, setLang] = useState<"python" | "pinecone" | "curl">("python");
  const namespaces = Object.entries(stats?.namespaces ?? {});
  const snippets = {
    python: `from needledb import NeedleDB

db = NeedleDB("${window.location.origin}", api_key=NEEDLEDB_API_KEY)
index = db.Index("${info.name}")

index.upsert([("doc-1", embedding, {"title": "Hello"})])
res = index.query(vector=embedding, top_k=10, include_metadata=True)`,
    pinecone: `from pinecone import Pinecone

pc = Pinecone(api_key=NEEDLEDB_API_KEY)
index = pc.Index(host="${info.host}")

res = index.query(vector=embedding, top_k=10, include_metadata=True)`,
    curl: `curl ${info.host}/query \\
  -H "Api-Key: $NEEDLEDB_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"vector": [...], "topK": 10, "includeMetadata": true}'`,
  };

  return (
    <>
      <div className="stats">
        <Stat icon={<IconIndexes size={15} />} label="Vectors" value={fmtInt(info.vectorCount)}
          hint={`${info.namespaceCount} ${info.namespaceCount === 1 ? "namespace" : "namespaces"}`} />
        <Stat icon={<IconChip size={15} />} label="Memory" value={fmtBytes(info.memoryBytes)} hint="Vectors and graph links" />
        <Stat icon={<IconDisk size={15} />} label="On disk" value={fmtBytes(info.storageBytes)} hint="Durable log and records" />
        <Stat icon={<IconGlobe size={15} />} label="Host" value={<span className="stat-host">{new URL(info.host).host}</span>} hint={`/indexes/${info.name}`} />
      </div>

      <div className="grid-2">
        <Card icon={<IconRows size={16} />} title="Namespaces" subtitle="Partitions inside this index" flush>
          {namespaces.length ? (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Namespace</th><th className="num">Vectors</th><th>Structure</th><th className="num">Tombstones</th><th>Status</th></tr></thead>
                <tbody>
                  {namespaces.map(([ns, s]) => (
                    <tr key={ns}>
                      <td>{ns === "" ? <span className="muted">Default</span> : <b>{ns}</b>}</td>
                      <td className="num">{fmtInt(s.vectorCount)}</td>
                      <td>{s.indexType === "hnsw" ? "HNSW graph" : "Flat, exact"}</td>
                      <td className="num">{fmtInt(s.tombstones)}</td>
                      <td>{s.building ? <Badge tone="warn">Rebuilding</Badge> : <Badge tone="good">Ready</Badge>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty icon={<IconRows size={22} />} title="No vectors yet">Namespaces appear as soon as you write to them.</Empty>
          )}
        </Card>

        <Card icon={<IconBook size={16} />} title="Connect" subtitle="The NeedleDB SDK, the Pinecone client, or plain HTTP"
          actions={<CopyButton text={snippets[lang]} />}>
          <div className="stack tight">
            <Segmented label="Language" value={lang} onChange={setLang} options={[
              { value: "python", label: "NeedleDB SDK" },
              { value: "pinecone", label: "Pinecone" },
              { value: "curl", label: "cURL" },
            ]} />
            <pre className="code">{snippets[lang]}</pre>
          </div>
        </Card>
      </div>
    </>
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
        subtitle="How many graph candidates each query explores. Wider finds more of the true nearest neighbours and takes longer.">
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
