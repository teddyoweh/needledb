import { type FormEvent, useEffect, useState } from "react";
import { api, type IndexInfo, type IndexType, type Metric } from "../api";
import { IconGrid, IconIndexes, IconPlus, IconRows, IconSearch } from "../icons";
import { fmtBytes, fmtInt, go, structureLabel } from "../lib";
import { useSession } from "../session";
import { Badge, Button, Card, Choice, Empty, ErrorNote, Field, IndexAvatar, PageHeader, Segmented, Sheet, Skeleton, useToast } from "../ui";
import IndexCard from "./IndexCard";

const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,43}[a-z0-9])?$/;

const MODELS = [
  { dimension: 384, label: "MiniLM" },
  { dimension: 768, label: "BERT · nomic" },
  { dimension: 1024, label: "Cohere · Voyage" },
  { dimension: 1536, label: "OpenAI small" },
  { dimension: 3072, label: "OpenAI large" },
];

const STRUCTURE_HELP: Record<IndexType, string> = {
  auto: "Exact search until 20,000 vectors, then an HNSW graph is built in the background and swapped in. The right default.",
  flat: "Always exact — 100% recall. Best below about 50,000 vectors per namespace.",
  hnsw: "An HNSW graph from the first vector. The fastest option for large collections.",
};

export default function Indexes({ indexes, error, openNew, onChanged }: {
  indexes?: IndexInfo[];
  error?: Error;
  openNew: boolean;
  onChanged: () => void;
}) {
  const { can } = useSession();
  const admin = can("admin");
  const [creating, setCreating] = useState(openNew && admin);
  const [view, setView] = useState<"table" | "cards">("table");
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (openNew && admin) setCreating(true);
  }, [openNew, admin]);

  function close() {
    setCreating(false);
    if (openNew) go("/indexes");
  }

  const shown = (indexes ?? []).filter((i) => i.name.includes(query.trim().toLowerCase()));
  const vectors = (indexes ?? []).reduce((a, i) => a + i.vectorCount, 0);

  return (
    <>
      <PageHeader
        title="Indexes"
        subtitle={indexes ? `${indexes.length} ${indexes.length === 1 ? "index" : "indexes"} · ${fmtInt(vectors)} vectors` : "Each index holds vectors of one dimension and metric."}
        actions={admin && <Button variant="primary" icon={<IconPlus size={17} />} onClick={() => setCreating(true)}>New index</Button>}
      />

      {indexes && indexes.length > 0 && (
        <div className="toolbar">
          <div className="search-field wide">
            <IconSearch size={16} />
            <input aria-label="Search indexes" placeholder="Search indexes" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <Segmented label="View" value={view} onChange={setView} options={[
            { value: "table", label: <><IconRows size={15} /> Table</> },
            { value: "cards", label: <><IconGrid size={15} /> Cards</> },
          ]} />
        </div>
      )}

      {!indexes ? (
        error ? <ErrorNote error={error} /> : <Skeleton height={280} radius={16} />
      ) : indexes.length === 0 ? (
        <Card>
          <Empty icon={<IconIndexes size={24} />} title="No indexes yet"
            action={admin && <Button variant="primary" icon={<IconPlus size={17} />} onClick={() => setCreating(true)}>Create your first index</Button>}>
            An index is where vectors live. Choose the dimension your embedding model produces — anything from 1 to 65,536.
          </Empty>
        </Card>
      ) : view === "table" ? (
        <Card flush>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>Index</th><th className="num">Dimension</th><th>Metric</th><th>Structure</th><th className="num">Vectors</th><th className="num">Memory</th><th className="num">On disk</th><th>Status</th></tr>
              </thead>
              <tbody>
                {shown.map((i) => (
                  <tr key={i.name} className="rowlink" onClick={() => go(`/indexes/${encodeURIComponent(i.name)}`)}>
                    <td>
                      <div className="entity">
                        <IndexAvatar name={i.name} />
                        <div><b>{i.name}</b><span>{i.namespaceCount} {i.namespaceCount === 1 ? "namespace" : "namespaces"}</span></div>
                      </div>
                    </td>
                    <td className="num">{i.dimension}</td>
                    <td>{i.metric}</td>
                    <td>{structureLabel(i)}</td>
                    <td className="num">{fmtInt(i.vectorCount)}</td>
                    <td className="num">{fmtBytes(i.memoryBytes)}</td>
                    <td className="num">{fmtBytes(i.storageBytes)}</td>
                    <td><Badge tone={i.status.state === "Ready" ? "good" : "warn"}>{i.status.state === "Ready" ? "Ready" : "Rebuilding"}</Badge></td>
                  </tr>
                ))}
                {shown.length === 0 && <tr><td colSpan={8} className="table-empty">No indexes match “{query}”.</td></tr>}
              </tbody>
            </table>
          </div>
        </Card>
      ) : (
        <div className="index-grid">
          {shown.map((i) => <IndexCard key={i.name} info={i} />)}
          {admin && (
            <button type="button" className="index-card index-card-new" onClick={() => setCreating(true)}>
              <span className="new-plus"><IconPlus size={22} /></span>
              <b>New index</b>
              <span>Any dimension · cosine, dot product or euclidean</span>
            </button>
          )}
        </div>
      )}

      <CreateIndexSheet open={creating} onClose={close}
        onCreated={(name) => {
          onChanged();
          setCreating(false);
          go(`/indexes/${encodeURIComponent(name)}`);
        }} />
    </>
  );
}

function CreateIndexSheet({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (name: string) => void }) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [dimension, setDimension] = useState("1536");
  const [metric, setMetric] = useState<Metric>("cosine");
  const [structure, setStructure] = useState<IndexType>("auto");
  const [advanced, setAdvanced] = useState(false);
  const [m, setM] = useState("32");
  const [efConstruction, setEfConstruction] = useState("200");
  const [efSearch, setEfSearch] = useState("128");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!open) return;
    setName("");
    setError(undefined);
    setBusy(false);
  }, [open]);

  const nameOk = NAME_RE.test(name);
  const dim = Number(dimension);
  const dimOk = Number.isInteger(dim) && dim >= 1 && dim <= 65536;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!nameOk || !dimOk) return;
    setBusy(true);
    setError(undefined);
    try {
      const info = await api.createIndex({
        name, dimension: dim, metric, index_type: structure,
        hnsw: { m: Number(m), ef_construction: Number(efConstruction), ef_search: Number(efSearch) },
      });
      toast(`Created ${info.name}`, "good");
      onCreated(info.name);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title="New index" subtitle="You can change search width later; dimension and metric are fixed."
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button variant="primary" type="submit" form="create-index" disabled={busy || !nameOk || !dimOk}>
          {busy ? "Creating…" : "Create index"}
        </Button>
      </>}>
      <form id="create-index" className="form" onSubmit={submit}>
        <Field label="Name" htmlFor="ix-name"
          hint={name && !nameOk ? <span className="bad">Use 1–45 lowercase letters, digits and hyphens.</span> : "Lowercase letters, digits and hyphens. Used in the API path."}>
          <input id="ix-name" value={name} placeholder="products" autoFocus autoComplete="off"
            onChange={(e) => setName(e.target.value.toLowerCase().replace(/\s+/g, "-"))} />
        </Field>

        <Field label="Dimension" htmlFor="ix-dim" hint={dimOk ? "Must match your embedding model." : <span className="bad">Choose a whole number from 1 to 65,536.</span>}>
          <input id="ix-dim" type="number" min={1} max={65536} value={dimension} onChange={(e) => setDimension(e.target.value)} />
          <div className="presets">
            {MODELS.map((model) => (
              <button key={model.dimension} type="button" className={dim === model.dimension ? "on" : ""}
                onClick={() => setDimension(String(model.dimension))}>
                <b>{model.dimension}</b>{model.label}
              </button>
            ))}
          </div>
        </Field>

        <Field label="Metric">
          <Choice label="Metric" value={metric} onChange={setMetric} options={[
            { value: "cosine", label: "Cosine" },
            { value: "dotproduct", label: "Dot product" },
            { value: "euclidean", label: "Euclidean" },
          ]} />
        </Field>

        <Field label="Structure" hint={STRUCTURE_HELP[structure]}>
          <Choice label="Structure" value={structure} onChange={setStructure} options={[
            { value: "auto", label: "Auto" },
            { value: "flat", label: "Flat" },
            { value: "hnsw", label: "HNSW" },
          ]} />
        </Field>

        {structure !== "flat" && (
          <div className="disclosure">
            <button type="button" className="disclosure-toggle" aria-expanded={advanced} onClick={() => setAdvanced((a) => !a)}>
              {advanced ? "Hide" : "Show"} graph settings
            </button>
            {advanced && (
              <div className="form-row three">
                <Field label="m" htmlFor="ix-m" hint="Links per node">
                  <input id="ix-m" type="number" min={4} max={128} value={m} onChange={(e) => setM(e.target.value)} />
                </Field>
                <Field label="ef_construction" htmlFor="ix-efc" hint="Build width">
                  <input id="ix-efc" type="number" min={16} max={2000} value={efConstruction} onChange={(e) => setEfConstruction(e.target.value)} />
                </Field>
                <Field label="ef_search" htmlFor="ix-efs" hint="Query width">
                  <input id="ix-efs" type="number" min={1} max={10000} value={efSearch} onChange={(e) => setEfSearch(e.target.value)} />
                </Field>
              </div>
            )}
          </div>
        )}
        <ErrorNote error={error} />
      </form>
    </Sheet>
  );
}
