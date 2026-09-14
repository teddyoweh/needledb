import { type FormEvent, useState } from "react";
import { api, type IndexInfo, type IndexType, type Metric } from "../api";
import { Button, ErrorNote, Field, IndexTable, Loading, Panel, Segmented } from "../components";

const DIMENSIONS = [384, 768, 1024, 1536, 3072];
const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,43}[a-z0-9])?$/;

const STRUCTURE_HELP: Record<IndexType, string> = {
  auto: "Exact search until 20,000 vectors, then an HNSW graph is built in the background and swapped in.",
  flat: "Always exact (100% recall). Best below ~50k vectors per namespace.",
  hnsw: "An HNSW graph from the first vector. The fastest option at scale.",
};

export default function Indexes({ indexes, error, openNew, onCreated }: {
  indexes?: IndexInfo[];
  error?: Error;
  openNew: boolean;
  onCreated: (name: string) => void;
}) {
  const [creating, setCreating] = useState(openNew);
  return (
    <>
      <header className="page-head">
        <div>
          <h1>Indexes</h1>
          <p className="sub">Each index has one dimension and one metric, and holds any number of namespaces.</p>
        </div>
        {!creating && <Button variant="primary" onClick={() => setCreating(true)}>New index</Button>}
      </header>
      {creating && <CreateIndex onCreated={onCreated} onCancel={() => setCreating(false)} />}
      <Panel>
        {indexes ? <IndexTable indexes={indexes} onCreate={() => setCreating(true)} /> : error ? <ErrorNote error={error} /> : <Loading />}
      </Panel>
    </>
  );
}

function CreateIndex({ onCreated, onCancel }: { onCreated: (name: string) => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [dimension, setDimension] = useState("1536");
  const [metric, setMetric] = useState<Metric>("cosine");
  const [structure, setStructure] = useState<IndexType>("auto");
  const [m, setM] = useState("32");
  const [efConstruction, setEfConstruction] = useState("200");
  const [efSearch, setEfSearch] = useState("128");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error>();

  const nameOk = NAME_RE.test(name);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const info = await api.createIndex({
        name,
        dimension: Number(dimension),
        metric,
        index_type: structure,
        hnsw: { m: Number(m), ef_construction: Number(efConstruction), ef_search: Number(efSearch) },
      });
      onCreated(info.name);
    } catch (err) {
      setError(err as Error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="New index">
      <form className="form-grid" onSubmit={submit}>
        <Field label="Name" htmlFor="ix-name" hint={name && !nameOk ? "Use 1–45 lowercase letters, digits and hyphens." : "Lowercase letters, digits and hyphens."}>
          <input id="ix-name" className="mono" value={name} placeholder="products" autoFocus required
            onChange={(e) => setName(e.target.value.toLowerCase())} />
        </Field>
        <Field label="Dimension" htmlFor="ix-dim" hint="Match your embedding model. Any size from 1 to 65,536.">
          <input id="ix-dim" type="number" min={1} max={65536} required value={dimension} onChange={(e) => setDimension(e.target.value)} />
          <div className="presets">
            {DIMENSIONS.map((d) => (
              <button key={d} type="button" className={Number(dimension) === d ? "on" : ""} onClick={() => setDimension(String(d))}>{d}</button>
            ))}
          </div>
        </Field>
        <Field label="Metric">
          <Segmented label="Metric" value={metric} onChange={setMetric} options={[
            { value: "cosine", label: "Cosine" },
            { value: "dotproduct", label: "Dot product" },
            { value: "euclidean", label: "Euclidean" },
          ]} />
        </Field>
        <Field label="Structure" hint={STRUCTURE_HELP[structure]}>
          <Segmented label="Structure" value={structure} onChange={setStructure} options={[
            { value: "auto", label: "Auto" },
            { value: "flat", label: "Flat" },
            { value: "hnsw", label: "HNSW" },
          ]} />
        </Field>
        {structure !== "flat" && (
          <div className="hnsw-fields">
            <Field label="m" htmlFor="ix-m" hint="Links per node. More links, better recall, more memory.">
              <input id="ix-m" type="number" min={4} max={128} value={m} onChange={(e) => setM(e.target.value)} />
            </Field>
            <Field label="ef_construction" htmlFor="ix-efc" hint="Build-time search width. Higher builds a better graph, slower.">
              <input id="ix-efc" type="number" min={16} max={2000} value={efConstruction} onChange={(e) => setEfConstruction(e.target.value)} />
            </Field>
            <Field label="ef_search" htmlFor="ix-efs" hint="Default query width. You can change it any time.">
              <input id="ix-efs" type="number" min={1} max={10000} value={efSearch} onChange={(e) => setEfSearch(e.target.value)} />
            </Field>
          </div>
        )}
        <ErrorNote error={error} />
        <div className="form-actions">
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button variant="primary" type="submit" disabled={busy || !nameOk}>{busy ? "Creating…" : "Create index"}</Button>
        </div>
      </form>
    </Panel>
  );
}
