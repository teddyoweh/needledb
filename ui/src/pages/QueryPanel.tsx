import { type FormEvent, useEffect, useMemo, useState } from "react";
import { api, type IndexInfo, type QueryResult } from "../api";
import { Badge, Button, CopyButton, Empty, ErrorNote, Field, MetadataChips, NamespaceSelect, Panel, Segmented } from "../components";
import { fmtMs, go, parseObject, parseVector, randomUnitVector } from "../lib";

type Mode = "vector" | "id";

const PLAN_HELP: Record<string, string> = {
  exact: "exact scan",
  hnsw: "HNSW graph",
  "filtered-exact": "filter first, then exact scan of the matches",
  "filtered-hnsw": "HNSW restricted to matches, widened for selectivity",
  empty: "namespace is empty",
  "filtered-empty": "nothing matched the filter",
};

export default function QueryPanel({ info, namespaces, params, active }: {
  info: IndexInfo;
  namespaces: string[];
  params: URLSearchParams;
  active: boolean;
}) {
  const [mode, setMode] = useState<Mode>("vector");
  const [vectorText, setVectorText] = useState("");
  const [recordId, setRecordId] = useState("");
  const [namespace, setNamespace] = useState("");
  const [topK, setTopK] = useState("10");
  const [ef, setEf] = useState("");
  const [filterText, setFilterText] = useState("");
  const [includeMetadata, setIncludeMetadata] = useState(true);
  const [includeValues, setIncludeValues] = useState(false);
  const [result, setResult] = useState<QueryResult>();
  const [roundTrip, setRoundTrip] = useState<number>();
  const [lastBody, setLastBody] = useState<Record<string, unknown>>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const vector = useMemo(() => parseVector(vectorText, info.dimension), [vectorText, info.dimension]);
  const filter = useMemo(() => parseObject(filterText, "filter"), [filterText]);

  // Arriving from Browse ("Find similar") runs a query by that record's id.
  const fromId = params.get("id");
  const fromNamespace = params.get("namespace") ?? "";
  useEffect(() => {
    if (!active || !fromId) return;
    setMode("id");
    setRecordId(fromId);
    setNamespace(fromNamespace);
    void run({ mode: "id", id: fromId, namespace: fromNamespace });
    go(`/indexes/${encodeURIComponent(info.name)}/query`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, fromId, fromNamespace]);

  async function run(override?: { mode: Mode; id: string; namespace: string }) {
    const useMode = override?.mode ?? mode;
    const body: Record<string, unknown> = {
      topK: Math.min(10000, Math.max(1, Number(topK) || 10)),
      includeMetadata,
      includeValues,
      namespace: override?.namespace ?? namespace,
    };
    if (useMode === "id") {
      const id = (override?.id ?? recordId).trim();
      if (!id) return setError("Enter the id of a stored record.");
      body.id = id;
    } else {
      if (!vector.ok) return setError(vector.message);
      body.vector = vector.value;
    }
    if (!filter.ok) return setError(filter.message);
    if (filter.value) body.filter = filter.value;
    if (ef.trim()) body.efSearch = Number(ef);

    setBusy(true);
    setError(undefined);
    const started = performance.now();
    try {
      const res = await api.query(info.name, body);
      setRoundTrip(performance.now() - started);
      setResult(res);
      setLastBody(body);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    void run();
  }

  const fieldSamples = useMemo(() => {
    const seen = new Map<string, unknown>();
    for (const m of result?.matches ?? []) {
      for (const [k, v] of Object.entries(m.metadata ?? {})) {
        if (!seen.has(k) && !Array.isArray(v)) seen.set(k, v);
      }
    }
    return Array.from(seen.entries()).slice(0, 6);
  }, [result]);

  const scores = (result?.matches ?? []).map((m) => m.score ?? 0);
  const best = info.metric === "euclidean" ? Math.min(...scores) : Math.max(...scores);
  const worst = info.metric === "euclidean" ? Math.max(...scores) : Math.min(...scores);
  const barWidth = (s: number | null) => {
    if (s == null || !scores.length) return 0;
    if (best === worst) return 100;
    return 12 + 88 * ((s - worst) / (best - worst));
  };

  const shownBody = lastBody && JSON.stringify(lastBody, (k, v) => (k === "vector" && Array.isArray(v) ? `[…${v.length} numbers]` : v));
  const curl = lastBody
    ? `curl -s ${window.location.origin}/indexes/${info.name}/query \\\n  -H "Api-Key: $NEEDLEDB_API_KEY" -H "Content-Type: application/json" \\\n  -d '${JSON.stringify(lastBody)}'`
    : "";

  return (
    <div className="split">
      <Panel title="Query">
        <form className="form-stack" onSubmit={submit} onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void run();
        }}>
          <Segmented label="Query by" value={mode} onChange={setMode} options={[
            { value: "vector", label: "Vector" },
            { value: "id", label: "Stored record" },
          ]} />

          {mode === "vector" ? (
            <Field label="Vector" htmlFor="q-vector"
              hint={<span className={vectorText && !vector.ok ? "bad" : ""}>{vector.ok ? `${info.dimension} numbers ✓` : vector.message}</span>}>
              <textarea id="q-vector" rows={5} spellCheck={false} value={vectorText} placeholder={`[0.012, -0.044, …]  (${info.dimension} numbers)`}
                onChange={(e) => setVectorText(e.target.value)} />
              <div className="row-start">
                <Button onClick={() => setVectorText(JSON.stringify(randomUnitVector(info.dimension)))}>Random unit vector</Button>
              </div>
            </Field>
          ) : (
            <Field label="Record id" htmlFor="q-id" hint="Finds the records nearest to this one.">
              <input id="q-id" className="mono" value={recordId} onChange={(e) => setRecordId(e.target.value)} placeholder="doc-42" />
            </Field>
          )}

          <div className="row">
            <Field label="Namespace" htmlFor="q-ns">
              <NamespaceSelect id="q-ns" value={namespace} namespaces={namespaces} onChange={setNamespace} />
            </Field>
            <Field label="Top K" htmlFor="q-topk">
              <input id="q-topk" type="number" min={1} max={10000} value={topK} onChange={(e) => setTopK(e.target.value)} />
            </Field>
            <Field label="efSearch" htmlFor="q-ef">
              <input id="q-ef" type="number" min={1} max={10000} value={ef} placeholder={String(info.hnsw.ef_search)} onChange={(e) => setEf(e.target.value)} />
            </Field>
          </div>

          <Field label="Metadata filter" htmlFor="q-filter"
            hint={filterText && !filter.ok ? <span className="bad">{filter.message}</span> : <>Operators: <code>$eq $ne $gt $gte $lt $lte $in $nin $exists $and $or</code></>}>
            <textarea id="q-filter" rows={3} spellCheck={false} value={filterText} onChange={(e) => setFilterText(e.target.value)}
              placeholder={'{"genre": {"$in": ["drama", "comedy"]}, "year": {"$gte": 2020}}'} />
            {!!fieldSamples.length && (
              <div className="presets">
                {fieldSamples.map(([k, v]) => (
                  <button key={k} type="button" title="Filter on this value"
                    onClick={() => setFilterText(JSON.stringify({ [k]: v }))}>
                    {k} = {String(v)}
                  </button>
                ))}
              </div>
            )}
          </Field>

          <div className="row-start">
            <label className="check"><input type="checkbox" checked={includeMetadata} onChange={(e) => setIncludeMetadata(e.target.checked)} /> Metadata</label>
            <label className="check"><input type="checkbox" checked={includeValues} onChange={(e) => setIncludeValues(e.target.checked)} /> Values</label>
          </div>

          <ErrorNote error={error} />
          <div className="row-end">
            <span className="muted small">⌘ Enter</span>
            <Button variant="primary" type="submit" disabled={busy}>{busy ? "Searching…" : "Run query"}</Button>
          </div>
        </form>
      </Panel>

      <div className="stack">
        <Panel title="Results"
          note={result && (
            <span className="result-head">
              <span><b>{result.matches.length}</b> matches</span>
              <span>server <b>{fmtMs(result.usage.latencyMs)}</b></span>
              {roundTrip != null && <span>round trip <b>{fmtMs(roundTrip)}</b></span>}
              <span title={PLAN_HELP[result.usage.plan]}><Badge tone="accent">{result.usage.plan}</Badge></span>
            </span>
          )}>
          {!result ? (
            <Empty title="Run a query to see its nearest neighbours">
              Paste an embedding, generate a random vector, or pick a stored record — each result shows its score, metadata and how the query was planned.
            </Empty>
          ) : result.matches.length === 0 ? (
            <Empty title="No matches">{PLAN_HELP[result.usage.plan] ?? "Try another namespace or a looser filter."}</Empty>
          ) : (
            <div className="table-wrap">
              <table>
                <thead><tr><th className="num">#</th><th>ID</th><th>Score</th>{includeMetadata && <th>Metadata</th>}</tr></thead>
                <tbody>
                  {result.matches.map((m, i) => (
                    <tr key={m.id}>
                      <td className="num muted">{i + 1}</td>
                      <td className="mono id-cell">
                        <button type="button" className="link" title="Find records similar to this one"
                          onClick={() => {
                            setMode("id");
                            setRecordId(m.id);
                            void run({ mode: "id", id: m.id, namespace: result.namespace });
                          }}>{m.id}</button>
                      </td>
                      <td>
                        <div className="score">
                          <span>{m.score == null ? "—" : m.score.toFixed(4)}</span>
                          <div className="bar"><i style={{ width: `${barWidth(m.score)}%` }} /></div>
                        </div>
                        {m.values && <div className="values-preview mono">[{m.values.slice(0, 4).map((v) => v.toFixed(3)).join(", ")}, …]</div>}
                      </td>
                      {includeMetadata && <td><MetadataChips metadata={m.metadata} /></td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        {lastBody && (
          <Panel title="Request" note="as sent to the API" actions={<CopyButton text={curl} label="Copy as curl" />}>
            <pre className="code panel-code">{`POST /indexes/${info.name}/query\n${shownBody}`}</pre>
          </Panel>
        )}
      </div>
    </div>
  );
}
