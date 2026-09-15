import { type FormEvent, useEffect, useMemo, useState } from "react";
import { api, type IndexInfo, type QueryResult } from "../api";
import { IconBolt, IconClock, IconSearch, IconSparkles, IconTarget } from "../icons";
import { fmtMs, go, parseObject, parseVector, randomUnitVector, titleOf } from "../lib";
import { Badge, Button, Card, Choice, CopyButton, Empty, ErrorNote, Field, IconButton, Kbd, MetadataChips, NamespaceSelect } from "../ui";

type Mode = "id" | "vector";

const PLAN_HELP: Record<string, string> = {
  exact: "Exact scan of every vector",
  hnsw: "HNSW graph search",
  "filtered-exact": "Filtered first, then an exact scan of the matches",
  "filtered-hnsw": "Graph search restricted to matches, widened for the filter",
  empty: "The namespace is empty",
  "filtered-empty": "Nothing matched the filter",
};

export default function QueryPanel({ info, namespaces, params, active }: {
  info: IndexInfo;
  namespaces: string[];
  params: URLSearchParams;
  active: boolean;
}) {
  const [mode, setMode] = useState<Mode>("id");
  const [vectorText, setVectorText] = useState("");
  const [recordId, setRecordId] = useState("");
  const [namespace, setNamespace] = useState("");
  const [topK, setTopK] = useState("10");
  const [ef, setEf] = useState("");
  const [filterText, setFilterText] = useState("");
  const [includeMetadata, setIncludeMetadata] = useState(true);
  const [result, setResult] = useState<QueryResult>();
  const [roundTrip, setRoundTrip] = useState<number>();
  const [lastBody, setLastBody] = useState<Record<string, unknown>>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const vector = useMemo(() => parseVector(vectorText, info.dimension), [vectorText, info.dimension]);
  const filter = useMemo(() => parseObject(filterText, "filter"), [filterText]);

  // "Find similar" elsewhere in the app arrives here with ?id=…
  const fromId = params.get("id");
  const fromNamespace = params.get("namespace") ?? "";
  useEffect(() => {
    if (!active || !fromId) return;
    setMode("id");
    setRecordId(fromId);
    setNamespace(fromNamespace);
    void run({ id: fromId, namespace: fromNamespace });
    go(`/indexes/${encodeURIComponent(info.name)}/query`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, fromId, fromNamespace]);

  async function run(byId?: { id: string; namespace: string }) {
    const body: Record<string, unknown> = {
      topK: Math.min(10000, Math.max(1, Number(topK) || 10)),
      includeMetadata,
      namespace: byId?.namespace ?? namespace,
    };
    if (byId || mode === "id") {
      const id = (byId?.id ?? recordId).trim();
      if (!id) return setError("Enter the id of a stored record — its neighbours are the results.");
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

  const suggestions = useMemo(() => {
    const seen = new Map<string, string | number | boolean>();
    for (const m of result?.matches ?? []) {
      const title = titleOf(m.metadata)?.field;
      for (const [k, v] of Object.entries(m.metadata ?? {})) {
        if (k === title || seen.has(k) || Array.isArray(v) || (typeof v === "string" && v.length > 32)) continue;
        seen.set(k, v);
      }
    }
    return Array.from(seen.entries()).slice(0, 5);
  }, [result]);

  const scores = (result?.matches ?? []).map((m) => m.score ?? 0);
  const best = info.metric === "euclidean" ? Math.min(...scores) : Math.max(...scores);
  const worst = info.metric === "euclidean" ? Math.max(...scores) : Math.min(...scores);
  const bar = (s: number | null) => (s == null || !scores.length ? 0 : best === worst ? 100 : 10 + 90 * ((s - worst) / (best - worst)));

  const curl = lastBody
    ? `curl ${info.host}/query \\\n  -H "Api-Key: $NEEDLEDB_API_KEY" -H "Content-Type: application/json" \\\n  -d '${JSON.stringify(lastBody)}'`
    : "";

  return (
    <div className="split">
      <Card icon={<IconSearch size={16} />} title="Search">
        <form className="form" onSubmit={submit} onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void run();
        }}>
          <Choice label="Search by" value={mode} onChange={setMode} options={[
            { value: "id", label: "Stored record" },
            { value: "vector", label: "Vector" },
          ]} />

          {mode === "id" ? (
            <Field label="Record id" htmlFor="q-id" hint="Returns the records closest to this one.">
              <input id="q-id" value={recordId} placeholder="doc-42" autoComplete="off" onChange={(e) => setRecordId(e.target.value)} />
            </Field>
          ) : (
            <Field label="Vector" htmlFor="q-vector"
              aside={<button type="button" className="link" onClick={() => setVectorText(JSON.stringify(randomUnitVector(info.dimension)))}>Random</button>}
              hint={vectorText && !vector.ok ? <span className="bad">{vector.message}</span> : vector.ok ? `${info.dimension} numbers` : `A JSON array of ${info.dimension} numbers.`}>
              <textarea id="q-vector" rows={4} spellCheck={false} value={vectorText} placeholder="[0.012, -0.044, …]" onChange={(e) => setVectorText(e.target.value)} />
            </Field>
          )}

          <div className="form-row three">
            <Field label="Namespace" htmlFor="q-ns">
              <NamespaceSelect id="q-ns" value={namespace} namespaces={namespaces} onChange={setNamespace} />
            </Field>
            <Field label="Results" htmlFor="q-topk">
              <input id="q-topk" type="number" min={1} max={10000} value={topK} onChange={(e) => setTopK(e.target.value)} />
            </Field>
            <Field label="ef_search" htmlFor="q-ef">
              <input id="q-ef" type="number" min={1} max={10000} value={ef} placeholder={String(info.hnsw.ef_search)} onChange={(e) => setEf(e.target.value)} />
            </Field>
          </div>

          <Field label="Filter" htmlFor="q-filter"
            hint={filterText && !filter.ok ? <span className="bad">{filter.message}</span> : <>Operators <code>$eq $ne $gt $gte $lt $lte $in $nin $exists $and $or</code></>}>
            <textarea id="q-filter" rows={3} spellCheck={false} value={filterText} onChange={(e) => setFilterText(e.target.value)}
              placeholder={'{"genre": {"$in": ["drama", "comedy"]}}'} />
            {suggestions.length > 0 && (
              <div className="presets">
                {suggestions.map(([k, v]) => (
                  <button key={k} type="button" onClick={() => setFilterText(JSON.stringify({ [k]: v }))}>
                    <b>{k}</b>{String(v)}
                  </button>
                ))}
              </div>
            )}
          </Field>

          <label className="check"><input type="checkbox" checked={includeMetadata} onChange={(e) => setIncludeMetadata(e.target.checked)} /> Include metadata</label>

          <ErrorNote error={error} />
          <div className="actions-end">
            <span className="muted small"><Kbd>⌘</Kbd> <Kbd>↵</Kbd></span>
            <Button variant="primary" type="submit" disabled={busy} icon={<IconSearch size={16} />}>{busy ? "Searching…" : "Search"}</Button>
          </div>
        </form>
      </Card>

      <div className="stack">
        <Card icon={<IconTarget size={16} />} title={result ? `${result.matches.length} ${result.matches.length === 1 ? "result" : "results"}` : "Results"}
          actions={result && (
            <div className="meta-pills">
              <span className="meta-pill" title="Measured on the server"><IconBolt size={14} />{fmtMs(result.usage.latencyMs)}</span>
              {roundTrip != null && <span className="meta-pill" title="Including the network"><IconClock size={14} />{fmtMs(roundTrip)}</span>}
              <span title={PLAN_HELP[result.usage.plan]}><Badge tone="accent">{result.usage.plan}</Badge></span>
            </div>
          )} flush>
          {!result ? (
            <Empty icon={<IconTarget size={24} />} title="Find nearest neighbours">
              Search by a stored record or a vector. Results show similarity, metadata, and how the query was planned.
            </Empty>
          ) : result.matches.length === 0 ? (
            <Empty icon={<IconTarget size={24} />} title="No matches">{PLAN_HELP[result.usage.plan] ?? "Try another namespace or a looser filter."}</Empty>
          ) : (
            <ol className="results">
              {result.matches.map((m, i) => {
                const title = titleOf(m.metadata);
                return (
                  <li key={m.id} className="result" style={{ animationDelay: `${Math.min(i, 14) * 18}ms` }}>
                    <span className="result-rank">{i + 1}</span>
                    <div className="result-main">
                      <div className="result-title">{title ? title.text : <span className="mono">{m.id}</span>}</div>
                      <div className="result-sub">
                        {title && <span className="mono result-id">{m.id}</span>}
                        {includeMetadata && <MetadataChips metadata={m.metadata} omit={title ? [title.field] : []} limit={2} />}
                      </div>
                    </div>
                    <div className="result-score">
                      <span>{m.score == null ? "—" : m.score.toFixed(4)}</span>
                      <div className="bar"><i style={{ width: `${bar(m.score)}%` }} /></div>
                    </div>
                    <IconButton label="Find similar" onClick={() => {
                      setMode("id");
                      setRecordId(m.id);
                      void run({ id: m.id, namespace: result.namespace });
                    }}><IconSparkles size={17} /></IconButton>
                  </li>
                );
              })}
            </ol>
          )}
        </Card>

        {lastBody && (
          <Card icon={<IconBolt size={16} />} title="Request" subtitle={`POST /indexes/${info.name}/query`} actions={<CopyButton text={curl} label="Copy as cURL" />}>
            <pre className="code">{JSON.stringify(lastBody, (k, v) => (k === "vector" && Array.isArray(v) ? `[${v.length} numbers]` : v), 2)}</pre>
          </Card>
        )}
      </div>
    </div>
  );
}
