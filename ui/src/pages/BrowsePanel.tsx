import { type FormEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, type IndexInfo, type VectorRecord } from "../api";
import { Button, CopyButton, Empty, ErrorNote, Field, Loading, NamespaceSelect, Panel } from "../components";
import { fmtInt, go } from "../lib";

export default function BrowsePanel({ info, namespaces, active, onChanged }: {
  info: IndexInfo;
  namespaces: string[];
  active: boolean;
  onChanged: () => void;
}) {
  const [namespace, setNamespace] = useState("");
  const [prefixInput, setPrefixInput] = useState("");
  const [prefix, setPrefix] = useState("");
  const [ids, setIds] = useState<string[]>([]);
  const [next, setNext] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState<string>();
  const [record, setRecord] = useState<VectorRecord | null>();
  const [armed, setArmed] = useState(false);

  async function load(token?: string) {
    setLoading(true);
    setError(undefined);
    try {
      const page = await api.list(info.name, { namespace, prefix: prefix || undefined, limit: 100, paginationToken: token });
      const pageIds = page.vectors.map((v) => v.id);
      setIds((prev) => (token ? [...prev, ...pageIds] : pageIds));
      setNext(page.pagination.next);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!active) return;
    setSelected(undefined);
    setRecord(undefined);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, namespace, prefix, info.name]);

  async function open(id: string) {
    setSelected(id);
    setArmed(false);
    setRecord(undefined);
    try {
      const res = await api.fetch(info.name, [id], namespace);
      setRecord(res.vectors[id] ?? null);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function remove() {
    if (!selected) return;
    if (!armed) {
      setArmed(true);
      return;
    }
    try {
      await api.deleteVectors(info.name, [selected], namespace);
      setIds((prev) => prev.filter((id) => id !== selected));
      setSelected(undefined);
      setRecord(undefined);
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function applyPrefix(e: FormEvent) {
    e.preventDefault();
    setPrefix(prefixInput.trim());
  }

  return (
    <div className="split">
      <Panel title="Records" note={ids.length ? `${fmtInt(ids.length)}${next ? "+" : ""} shown` : undefined}>
        <form className="form-stack tight" onSubmit={applyPrefix}>
          <div className="row">
            <Field label="Namespace" htmlFor="b-ns">
              <NamespaceSelect id="b-ns" value={namespace} namespaces={namespaces} onChange={setNamespace} />
            </Field>
            <Field label="ID prefix" htmlFor="b-prefix">
              <input id="b-prefix" className="mono" value={prefixInput} placeholder="doc#" onChange={(e) => setPrefixInput(e.target.value)} />
            </Field>
          </div>
        </form>
        <ErrorNote error={error} />
        {loading && !ids.length ? (
          <Loading />
        ) : ids.length ? (
          <>
            <ul className="idlist">
              {ids.map((id) => (
                <li key={id}>
                  <button type="button" className={id === selected ? "on" : ""} onClick={() => void open(id)}>{id}</button>
                </li>
              ))}
            </ul>
            {next && (
              <div className="list-more">
                <Button onClick={() => void load(next)} disabled={loading}>{loading ? "Loading…" : "Load 100 more"}</Button>
              </div>
            )}
          </>
        ) : (
          <Empty title={prefix ? `No ids start with “${prefix}”` : "This namespace is empty"} />
        )}
      </Panel>

      <Panel title={selected ? <span className="mono">{selected}</span> : "Record"}
        actions={record && selected ? (
          <>
            <Button onClick={() => go(`/indexes/${encodeURIComponent(info.name)}/query?id=${encodeURIComponent(selected)}&namespace=${encodeURIComponent(namespace)}`)}>
              Find similar
            </Button>
            <CopyButton text={JSON.stringify(record)} label="Copy JSON" />
            <Button variant="danger" className={armed ? "armed" : ""} onClick={() => void remove()}>
              {armed ? "Click again to delete" : "Delete"}
            </Button>
          </>
        ) : undefined}>
        {!selected ? (
          <Empty title="Select a record">Its metadata and vector appear here, with a shortcut to search for its neighbours.</Empty>
        ) : record === undefined ? (
          <Loading />
        ) : record === null ? (
          <Empty title="Record not found">It may have just been deleted.</Empty>
        ) : (
          <RecordView record={record} />
        )}
      </Panel>
    </div>
  );
}

function RecordView({ record }: { record: VectorRecord }) {
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  for (const v of record.values) {
    sum += v * v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return (
    <div className="stack pad">
      <div>
        <div className="section-label">Metadata</div>
        {record.metadata ? <pre className="code">{JSON.stringify(record.metadata, null, 2)}</pre> : <p className="muted">No metadata.</p>}
      </div>
      <div>
        <div className="section-label">Vector</div>
        <dl className="kv compact">
          <dt>Dimensions</dt><dd>{record.values.length}</dd>
          <dt>L2 norm</dt><dd className="mono">{Math.sqrt(sum).toFixed(6)}</dd>
          <dt>Range</dt><dd className="mono">{min.toFixed(4)} … {max.toFixed(4)}</dd>
        </dl>
        <VectorStrip values={record.values} />
        <div className="strip-legend"><span>negative</span><span>0</span><span>positive</span></div>
        <pre className="code">[{record.values.slice(0, 16).map((v) => v.toFixed(5)).join(", ")}{record.values.length > 16 ? `, … ${record.values.length - 16} more` : ""}]</pre>
      </div>
    </div>
  );
}

function hexToRgb(value: string): [number, number, number] {
  const hex = value.trim().replace("#", "");
  const n = parseInt(hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Each dimension as a colour cell on a diverging scale: negative ← grey 0 → positive. */
function VectorStrip({ values }: { values: number[] }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useLayoutEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(canvas.clientWidth * dpr));
      canvas.height = Math.max(1, Math.round(canvas.clientHeight * dpr));
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const css = getComputedStyle(canvas);
      const neg = hexToRgb(css.getPropertyValue("--neg"));
      const pos = hexToRgb(css.getPropertyValue("--pos"));
      const mid = hexToRgb(css.getPropertyValue("--mid"));
      let maxAbs = 1e-12;
      for (const v of values) maxAbs = Math.max(maxAbs, Math.abs(v));
      const cols = Math.min(values.length, canvas.width);
      const colWidth = canvas.width / cols;
      for (let c = 0; c < cols; c++) {
        const start = Math.floor((c * values.length) / cols);
        const end = Math.max(start + 1, Math.floor(((c + 1) * values.length) / cols));
        let s = 0;
        for (let i = start; i < end; i++) s += values[i];
        const v = s / (end - start) / maxAbs;
        const target = v < 0 ? neg : pos;
        const t = Math.min(1, Math.abs(v));
        const mix = (i: number) => Math.round(mid[i] + (target[i] - mid[i]) * t);
        ctx.fillStyle = `rgb(${mix(0)}, ${mix(1)}, ${mix(2)})`;
        ctx.fillRect(Math.floor(c * colWidth), 0, Math.ceil(colWidth), canvas.height);
      }
    };
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [values]);

  return <canvas ref={ref} className="strip" role="img" aria-label={`${values.length} dimensions on a negative-to-positive colour scale`} />;
}
