import { useState } from "react";
import { api, ApiError, type IndexInfo, type IndexStats } from "../api";
import { IconChevronRight, IconChip, IconDisk, IconGauge, IconIndexes, IconTrash } from "../icons";
import { fmtBytes, fmtInt, go, structureLabel, usePoll } from "../lib";
import { useSession } from "../session";
import { Badge, Button, Card, Choice, CopyButton, Empty, ErrorNote, Field, PageHeader, Skeleton, Stat, useToast } from "../ui";
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

  const tabs = [
    ["overview", "Overview"],
    ["query", "Query"],
    ["browse", "Browse"],
    ...(can("write") ? [["upsert", "Upsert"]] : []),
    ...(can("admin") ? [["settings", "Settings"]] : []),
  ] as [string, string][];
  const current = tabs.some(([id]) => id === tab) ? tab : "overview";
  const crumbs = <a href="#/indexes" className="crumb">Indexes <IconChevronRight size={13} /></a>;

  if (!info.data) {
    const missing = info.error instanceof ApiError && info.error.status === 404;
    return (
      <>
        <PageHeader eyebrow={crumbs} title={name} />
        {missing ? (
          <Card>
            <Empty icon={<IconIndexes size={24} />} title={`There's no index named “${name}”`}
              action={<Button onClick={() => go("/indexes")}>All indexes</Button>}>
              It may have been deleted, or your key may not have access to it.
            </Empty>
          </Card>
        ) : info.error ? <ErrorNote error={info.error} /> : <Skeleton height={320} radius={22} />}
      </>
    );
  }

  const index = info.data;
  const namespaces = Object.keys(stats.data?.namespaces ?? {});
  const refresh = () => {
    void info.reload();
    void stats.reload();
    onChanged();
  };
  const ready = index.status.state === "Ready";

  return (
    <>
      <PageHeader eyebrow={crumbs} title={index.name}
        subtitle={<>{index.dimension} dimensions · {index.metric} · {structureLabel(index)}</>}
        actions={<Badge tone={ready ? "good" : "warn"} dot>{ready ? "Ready" : "Rebuilding graph"}</Badge>}>
      </PageHeader>

      <nav className="tabs" aria-label="Index sections">
        {tabs.map(([id, label]) => (
          <a key={id} href={`#/indexes/${encodeURIComponent(name)}/${id}`} className={current === id ? "active" : ""}
            aria-current={current === id ? "page" : undefined}>{label}</a>
        ))}
      </nav>

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
        <Stat icon={<IconIndexes size={16} />} label="Vectors" value={fmtInt(info.vectorCount)}
          hint={`${info.namespaceCount} ${info.namespaceCount === 1 ? "namespace" : "namespaces"}`} />
        <Stat icon={<IconChip size={16} />} label="Memory" value={fmtBytes(info.memoryBytes)} hint="Vectors and graph links" />
        <Stat icon={<IconDisk size={16} />} label="On disk" value={fmtBytes(info.storageBytes)} hint="Durable log and records" />
        <Stat icon={<IconGauge size={16} />} label="Search width" value={info.hnsw.ef_search} hint="Default ef_search" />
      </div>

      <div className="grid-2">
        <Card title="Namespaces" subtitle="Partitions inside this index" flush>
          {namespaces.length ? (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Namespace</th><th className="num">Vectors</th><th>Structure</th><th className="num">Tombstones</th><th /></tr></thead>
                <tbody>
                  {namespaces.map(([ns, s]) => (
                    <tr key={ns}>
                      <td>{ns === "" ? <span className="muted">Default</span> : <span className="mono">{ns}</span>}</td>
                      <td className="num">{fmtInt(s.vectorCount)}</td>
                      <td>{s.indexType === "hnsw" ? "HNSW graph" : "Flat, exact"}</td>
                      <td className="num">{fmtInt(s.tombstones)}</td>
                      <td className="num">{s.building ? <Badge tone="warn" dot>Rebuilding</Badge> : <Badge tone="good" dot>Ready</Badge>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty title="No vectors yet">Namespaces appear as soon as you write to them.</Empty>
          )}
        </Card>

        <Card title="Configuration">
          <dl className="kv">
            <dt>Dimension</dt><dd>{info.dimension}</dd>
            <dt>Metric</dt><dd>{info.metric}{info.metric === "euclidean" ? " — squared distance, lower is closer" : ""}</dd>
            <dt>Structure</dt><dd>{info.index_type}</dd>
            <dt>HNSW</dt><dd className="mono">m {info.hnsw.m} · ef_construction {info.hnsw.ef_construction} · ef_search {info.hnsw.ef_search}</dd>
            <dt>Created</dt><dd>{new Date(info.created_at).toLocaleString()}</dd>
            <dt>Host</dt><dd className="mono">{info.host}</dd>
          </dl>
        </Card>
      </div>

      <Card title="Connect" subtitle="Use the NeedleDB SDK, the official Pinecone client, or plain HTTP."
        actions={<CopyButton text={snippets[lang]} />}>
        <div className="stack tight">
          <Choice label="Language" value={lang} onChange={setLang} options={[
            { value: "python", label: "NeedleDB SDK" },
            { value: "pinecone", label: "Pinecone client" },
            { value: "curl", label: "cURL" },
          ]} />
          <pre className="code">{snippets[lang]}</pre>
        </div>
      </Card>
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
      <Card title="Search width" subtitle="How many graph candidates each query explores. Wider finds more of the true nearest neighbours and takes longer.">
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

      <Card title="Delete index" className="card-danger"
        subtitle={<>Removes every vector and namespace in <b>{info.name}</b> from disk. This can't be undone.</>}>
        <div className="form narrow">
          <Field label={`Type “${info.name}” to confirm`} htmlFor="confirm-delete">
            <input id="confirm-delete" className="mono" value={confirm} autoComplete="off" onChange={(e) => setConfirm(e.target.value)} />
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
