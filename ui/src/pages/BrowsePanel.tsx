import { type FormEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, type IndexInfo, type Metadata, type VectorRecord } from "../api";
import { IconRows, IconSearch, IconSparkles, IconTrash } from "../icons";
import { fmtInt, go, titleOf } from "../lib";
import { useSession } from "../session";
import { Button, Card, CopyButton, Empty, ErrorNote, NamespaceSelect, Skeleton, useToast } from "../ui";

export default function BrowsePanel({ info, namespaces, active, onChanged }: {
  info: IndexInfo;
  namespaces: string[];
  active: boolean;
  onChanged: () => void;
}) {
  const { can } = useSession();
  const toast = useToast();
  const [namespace, setNamespace] = useState("");
  const [prefixInput, setPrefixInput] = useState("");
  const [prefix, setPrefix] = useState("");
  const [ids, setIds] = useState<string[]>([]);
  const [meta, setMeta] = useState<Record<string, Metadata | null>>({});
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
      if (pageIds.length) {
        const fetched = await api.fetch(info.name, pageIds, namespace, false);
        setMeta((prev) => ({ ...prev, ...Object.fromEntries(pageIds.map((id) => [id, fetched.vectors[id]?.metadata ?? null])) }));
      }
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
      toast(`Deleted ${selected}`);
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

  const title = record ? titleOf(record.metadata) : undefined;

  return (
    <div className="split">
      <Card title="Records" subtitle={ids.length ? `${fmtInt(ids.length)}${next ? "+" : ""} shown, sorted by id` : undefined} flush>
        <form className="browse-filters" onSubmit={applyPrefix}>
          <NamespaceSelect id="b-ns" value={namespace} namespaces={namespaces} onChange={setNamespace} />
          <div className="input-icon">
            <IconSearch size={16} />
            <input className="mono" aria-label="Id prefix" placeholder="Id prefix, then ↵" value={prefixInput} onChange={(e) => setPrefixInput(e.target.value)} />
          </div>
        </form>
        <ErrorNote error={error} />
        {loading && !ids.length ? (
          <div className="stack tight pad">{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} height={44} radius={12} />)}</div>
        ) : ids.length ? (
          <>
            <ul className="record-list">
              {ids.map((id) => {
                const t = titleOf(meta[id]);
                return (
                  <li key={id}>
                    <button type="button" className={id === selected ? "on" : ""} onClick={() => void open(id)}>
                      <span className="record-title">{t ? t.text : <span className="mono">{id}</span>}</span>
                      {t && <span className="record-id mono">{id}</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
            {next && (
              <div className="list-more">
                <Button size="sm" onClick={() => void load(next)} disabled={loading}>{loading ? "Loading…" : "Load 100 more"}</Button>
              </div>
            )}
          </>
        ) : (
          <Empty icon={<IconRows size={22} />} title={prefix ? `No ids start with “${prefix}”` : "This namespace is empty"} />
        )}
      </Card>

      <Card title={record ? (title ? title.text : record.id) : "Record"}
        subtitle={record && title ? <span className="mono">{record.id}</span> : undefined}
        actions={record && selected && (
          <>
            <Button size="sm" icon={<IconSparkles size={15} />}
              onClick={() => go(`/indexes/${encodeURIComponent(info.name)}/query?id=${encodeURIComponent(selected)}&namespace=${encodeURIComponent(namespace)}`)}>
              Find similar
            </Button>
            <CopyButton text={JSON.stringify(record)} label="JSON" />
            {can("write") && (
              <Button size="sm" variant={armed ? "danger-solid" : "danger"} icon={<IconTrash size={15} />} onClick={() => void remove()}>
                {armed ? "Confirm" : "Delete"}
              </Button>
            )}
          </>
        )}>
        {!selected ? (
          <Empty icon={<IconRows size={22} />} title="Select a record">Its metadata and vector appear here, with a shortcut to its nearest neighbours.</Empty>
        ) : record === undefined ? (
          <div className="stack tight">{[0, 1, 2].map((i) => <Skeleton key={i} height={22} />)}<Skeleton height={40} /></div>
        ) : record === null ? (
          <Empty title="Record not found">It may have just been deleted.</Empty>
        ) : (
          <RecordView record={record} titleField={title?.field} />
        )}
      </Card>
    </div>
  );
}

function RecordView({ record, titleField }: { record: VectorRecord; titleField?: string }) {
  const values = record.values ?? [];
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    sum += v * v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const entries = Object.entries(record.metadata ?? {}).filter(([k]) => k !== titleField);
  return (
    <div className="stack">
      {entries.length > 0 && (
        <dl className="kv">
          {entries.map(([k, v]) => (
            <div key={k} className="kv-row">
              <dt>{k}</dt>
              <dd>{Array.isArray(v) ? v.join(", ") : String(v)}</dd>
            </div>
          ))}
        </dl>
      )}
      <div className="vector-block">
        <div className="vector-head">
          <span><b>{values.length}</b> dimensions</span>
          <span>norm <b>{Math.sqrt(sum).toFixed(4)}</b></span>
          <span>range <b>{min.toFixed(3)} … {max.toFixed(3)}</b></span>
        </div>
        <VectorStrip values={values} />
        <div className="strip-legend"><span>negative</span><span>0</span><span>positive</span></div>
      </div>
    </div>
  );
}

/** Each dimension as a colour cell on a diverging scale: blue below zero, orange above. */
function VectorStrip({ values }: { values: number[] }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useLayoutEffect(() => {
    const canvas = ref.current;
    if (!canvas || !values.length) return;
    const neg = [0, 113, 227];
    const pos = [255, 159, 10];
    const mid = [236, 236, 240];
    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(canvas.clientWidth * dpr));
      canvas.height = Math.max(1, Math.round(canvas.clientHeight * dpr));
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
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
        const t = Math.min(1, Math.abs(v) * 1.4);
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
