import { useState } from "react";
import { api, ApiError, type IndexInfo, type IndexStats } from "../api";
import { Badge, Button, CopyButton, Empty, ErrorNote, Field, Loading, Panel, Tile } from "../components";
import { fmtBytes, fmtInt, go, structureLabel, usePoll } from "../lib";
import BrowsePanel from "./BrowsePanel";
import QueryPanel from "./QueryPanel";
import UpsertPanel from "./UpsertPanel";

const TABS = [
  ["overview", "Overview"],
  ["query", "Query"],
  ["browse", "Browse"],
  ["upsert", "Upsert"],
  ["settings", "Settings"],
] as const;

export default function IndexPage({ name, tab, params, onChanged, onDeleted }: {
  name: string;
  tab: string;
  params: URLSearchParams;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const info = usePoll(() => api.index(name), 3000, [name]);
  const stats = usePoll(() => api.describeStats(name), 3000, [name]);

  if (!info.data) {
    const missing = info.error instanceof ApiError && info.error.status === 404;
    return (
      <>
        <header className="page-head"><div><p className="eyebrow"><a href="#/indexes">Indexes</a> /</p><h1 className="mono">{name}</h1></div></header>
        {missing ? (
          <Panel><Empty title={`No index named “${name}”`} action={<a className="btn" href="#/indexes">All indexes</a>}>It may have been deleted.</Empty></Panel>
        ) : info.error ? <ErrorNote error={info.error} /> : <Loading />}
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

  return (
    <>
      <header className="page-head">
        <div>
          <p className="eyebrow"><a href="#/indexes">Indexes</a> /</p>
          <h1 className="mono">{index.name}</h1>
          <div className="chips">
            <Badge>{index.dimension}-d</Badge>
            <Badge>{index.metric}</Badge>
            <Badge>{structureLabel(index)}</Badge>
            <Badge tone={index.status.state === "Ready" ? "good" : "warn"}>{index.status.state}</Badge>
          </div>
        </div>
      </header>

      <nav className="tabs" aria-label="Index sections">
        {TABS.map(([id, label]) => (
          <a key={id} href={`#/indexes/${encodeURIComponent(name)}/${id}`} className={tab === id ? "active" : ""}
            aria-current={tab === id ? "page" : undefined}>{label}</a>
        ))}
      </nav>

      {/* Panels stay mounted so a half-written query survives switching tabs. */}
      <div hidden={tab !== "overview"} className="stack"><IndexOverview info={index} stats={stats.data} /></div>
      <div hidden={tab !== "query"}><QueryPanel info={index} namespaces={namespaces} params={params} active={tab === "query"} /></div>
      <div hidden={tab !== "browse"}><BrowsePanel info={index} namespaces={namespaces} active={tab === "browse"} onChanged={refresh} /></div>
      <div hidden={tab !== "upsert"}><UpsertPanel info={index} namespaces={namespaces} onDone={refresh} /></div>
      <div hidden={tab !== "settings"} className="stack">
        <SettingsPanel key={index.hnsw.ef_search} info={index} onSaved={(next) => { info.setData(next); onChanged(); }} onDeleted={onDeleted} />
      </div>
    </>
  );
}

function IndexOverview({ info, stats }: { info: IndexInfo; stats?: IndexStats }) {
  const namespaces = Object.entries(stats?.namespaces ?? {});
  const origin = window.location.origin;
  const python = `from needledb import NeedleDB

db = NeedleDB("${origin}", api_key="…")
index = db.Index("${info.name}")

index.upsert([("doc-1", embedding, {"lang": "en"})])
index.query(vector=embedding, top_k=10, filter={"lang": "en"}, include_metadata=True)`;

  return (
    <>
      <div className="tiles">
        <Tile label="Vectors" value={fmtInt(info.vectorCount)} hint={`${info.namespaceCount} ${info.namespaceCount === 1 ? "namespace" : "namespaces"}`} />
        <Tile label="Memory" value={fmtBytes(info.memoryBytes)} hint="estimated" />
        <Tile label="On disk" value={fmtBytes(info.storageBytes)} />
        <Tile label="ef_search" value={info.hnsw.ef_search} hint="default query width" />
      </div>

      <div className="grid-2">
        <Panel title="Namespaces">
          {namespaces.length ? (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Namespace</th><th className="num">Vectors</th><th>Structure</th><th className="num">Tombstones</th><th>State</th></tr></thead>
                <tbody>
                  {namespaces.map(([ns, s]) => (
                    <tr key={ns}>
                      <td className="mono">{ns === "" ? <span className="muted">(default)</span> : ns}</td>
                      <td className="num">{fmtInt(s.vectorCount)}</td>
                      <td>{s.indexType === "hnsw" ? "HNSW" : "Flat"}</td>
                      <td className="num">{fmtInt(s.tombstones)}</td>
                      <td><Badge tone={s.building ? "warn" : "good"}>{s.building ? "Rebuilding" : "Ready"}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty title="No vectors yet" action={<a className="btn btn-primary" href={`#/indexes/${encodeURIComponent(info.name)}/upsert`}>Upsert vectors</a>}>
              Namespaces appear when you write to them.
            </Empty>
          )}
        </Panel>

        <Panel title="Configuration">
          <dl className="kv">
            <dt>Dimension</dt><dd>{info.dimension}</dd>
            <dt>Metric</dt><dd>{info.metric}{info.metric === "euclidean" ? " (squared L2, lower is closer)" : ""}</dd>
            <dt>Structure</dt><dd>{info.index_type}</dd>
            <dt>HNSW</dt><dd className="mono">m={info.hnsw.m} ef_construction={info.hnsw.ef_construction} ef_search={info.hnsw.ef_search}</dd>
            <dt>Created</dt><dd>{new Date(info.created_at).toLocaleString()}</dd>
            <dt>Host</dt><dd className="mono">{info.host}</dd>
          </dl>
        </Panel>
      </div>

      <Panel title="Connect" note="Python SDK — the official Pinecone client also works against the host above" actions={<CopyButton text={python} />}>
        <pre className="code panel-code">{python}</pre>
      </Panel>
    </>
  );
}

function SettingsPanel({ info, onSaved, onDeleted }: {
  info: IndexInfo;
  onSaved: (info: IndexInfo) => void;
  onDeleted: () => void;
}) {
  const [ef, setEf] = useState(String(info.hnsw.ef_search));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<Error>();
  const [confirm, setConfirm] = useState("");
  const [deleting, setDeleting] = useState(false);

  async function save() {
    setSaving(true);
    setError(undefined);
    try {
      onSaved(await api.configure(info.name, Number(ef)));
    } catch (err) {
      setError(err as Error);
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    setDeleting(true);
    setError(undefined);
    try {
      await api.deleteIndex(info.name);
      onDeleted();
    } catch (err) {
      setError(err as Error);
      setDeleting(false);
    }
  }

  return (
    <>
      <Panel title="Search width">
        <div className="form-stack narrow">
          <Field label="Default ef_search" htmlFor="ef-search"
            hint="How many graph candidates each query explores. Higher finds more of the true nearest neighbours and costs latency. Takes effect on the next query; a query's own efSearch overrides it.">
            <input id="ef-search" type="number" min={1} max={10000} value={ef} onChange={(e) => setEf(e.target.value)} />
          </Field>
          <div className="row-end">
            <Button variant="primary" onClick={save} disabled={saving || Number(ef) === info.hnsw.ef_search}>{saving ? "Saving…" : "Save"}</Button>
          </div>
        </div>
      </Panel>
      <ErrorNote error={error} />
      <Panel title="Delete index" className="danger">
        <div className="form-stack narrow">
          <p className="muted">
            Removes every vector and namespace in <b className="mono">{info.name}</b> from disk. This can’t be undone.
          </p>
          <Field label={`Type ${info.name} to confirm`} htmlFor="confirm-delete">
            <input id="confirm-delete" className="mono" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" />
          </Field>
          <div className="row-end">
            <Button variant="danger" className="armed" disabled={confirm !== info.name || deleting} onClick={remove}>
              {deleting ? "Deleting…" : "Delete index"}
            </Button>
          </div>
        </div>
      </Panel>
      <div className="row-end"><Button variant="ghost" onClick={() => go("/indexes")}>Back to indexes</Button></div>
    </>
  );
}
