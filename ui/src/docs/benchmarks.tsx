import { useState } from "react";
import { CodeBlock } from "../code";
import { BENCHMARKS, type BenchmarkSet, type BenchSystem } from "./benchmarkData";
import { C, Callout, DocTable, H2, H3 } from "./parts";

type Verdict = { tone: "win" | "loss" | "even"; label: string };

const gb = (bytes: number | null) => (bytes == null ? "—" : `${(bytes / 2 ** 30).toFixed(2)} GB`);
const ms = (v: number) => (v < 10 ? `${v.toFixed(2)} ms` : `${v.toFixed(1)} ms`);
const count = (v: number | null) => (v == null ? "—" : Math.round(v).toLocaleString("en-US"));
const seconds = (v: number) => `${v.toFixed(v < 10 ? 1 : 0)} s`;

/** How `ours` compares with `theirs`; within 10% is a tie (one run, shared machine). */
function versus(ours: number | null, theirs: number | null, higherIsBetter: boolean): Verdict | null {
  if (ours == null || theirs == null || ours <= 0 || theirs <= 0) return null;
  const factor = higherIsBetter ? ours / theirs : theirs / ours;
  if (factor >= 1.1) return { tone: "win", label: factor >= 2 ? `${factor.toFixed(1)}× better` : `${Math.round((factor - 1) * 100)}% better` };
  if (factor <= 1 / 1.1) return { tone: "loss", label: `${Math.round((1 - factor) * 100)}% behind` };
  return { tone: "even", label: "about even" };
}

type Metric = {
  id: string;
  title: string;
  unit: string;
  higherIsBetter: boolean;
  value: (s: BenchSystem) => number | null;
  format: (v: number | null) => string;
};

function metrics(set: BenchmarkSet): Metric[] {
  return [
    { id: "qps", title: "Queries per second, 1 client", unit: "higher is better", higherIsBetter: true, value: (s) => s.operating.qps, format: count },
    { id: "concurrent", title: `Queries per second, ${set.clients} clients`, unit: "higher is better", higherIsBetter: true, value: (s) => s.concurrentQps, format: count },
    { id: "p99", title: "p99 latency, 1 client", unit: "lower is better", higherIsBetter: false, value: (s) => s.operating.p99Ms, format: (v) => (v == null ? "—" : ms(v)) },
    { id: "build", title: "Build time for 100,000 vectors", unit: "lower is better", higherIsBetter: false, value: (s) => s.buildSeconds, format: (v) => (v == null ? "—" : seconds(v)) },
    { id: "memory", title: "Memory", unit: "lower is better", higherIsBetter: false, value: (s) => s.memoryBytes, format: gb },
  ];
}

const NEXT_STEPS: Record<string, string> = {
  qps: "Serve more of the request path outside Python: a compiled HTTP front end for queries, as the query fast path already does for routing.",
  concurrent: "Micro-batch concurrent queries into one FAISS call, so a burst of requests shares a single thread hop and all cores.",
  p99: "Pin search threads and keep FAISS's thread pool from oversubscribing cores under load.",
  build: "Parallel graph construction during bulk loads, and a streaming binary upsert that skips JSON entirely.",
  memory: "Quantized indexes (SQ8, then PQ) — 4–8× less memory for vectors — are next on the roadmap.",
};

function Verdicts({ ours, rivals, metric }: { ours: BenchSystem; rivals: BenchSystem[]; metric: Metric }) {
  return (
    <div className="bench-vs">
      {rivals.map((rival) => {
        const verdict = versus(metric.value(ours), metric.value(rival), metric.higherIsBetter);
        return verdict && (
          <span key={rival.key} className={`vs vs-${verdict.tone}`} title={`${rival.name}: ${metric.format(metric.value(rival))}`}>
            {verdict.label} vs {rival.name.replace(/ \(.*\)$/, "")}
          </span>
        );
      })}
    </div>
  );
}

function Bars({ metric, systems, highlight }: { metric: Metric; systems: BenchSystem[]; highlight: string }) {
  const rows = systems.filter((s) => metric.value(s) != null);
  const max = Math.max(...rows.map((s) => metric.value(s) ?? 0), 1);
  return (
    <figure className="bench-bars">
      <figcaption><b>{metric.title}</b><span>{metric.unit}</span></figcaption>
      {rows.map((s) => {
        const v = metric.value(s) ?? 0;
        return (
          <div key={s.key} className={`bench-bar ${s.key === highlight ? "ours" : ""}`}>
            <span className="bench-bar-name">{s.name}</span>
            <span className="bench-bar-track"><i style={{ width: `${Math.max(1.5, (v / max) * 100)}%`, background: s.color }} /></span>
            <span className="bench-bar-value">{metric.format(v)}</span>
          </div>
        );
      })}
    </figure>
  );
}

function SweepChart({ set }: { set: BenchmarkSet }) {
  const W = 680;
  const H = 300;
  const pad = { l: 56, r: 16, t: 14, b: 38 };
  const points = set.systems.flatMap((s) => s.sweep);
  const minRecall = Math.min(0.85, ...points.map((p) => p.recall));
  const qpsValues = points.map((p) => p.qps).filter((v) => v > 0);
  const lo = Math.log10(Math.min(...qpsValues) * 0.8);
  const hi = Math.log10(Math.max(...qpsValues) * 1.25);
  const x = (recall: number) => pad.l + ((recall - minRecall) / (1 - minRecall)) * (W - pad.l - pad.r);
  const y = (qps: number) => pad.t + (1 - (Math.log10(qps) - lo) / (hi - lo)) * (H - pad.t - pad.b);
  const ticks = [10, 30, 100, 300, 1000, 3000, 10000].filter((t) => Math.log10(t) >= lo && Math.log10(t) <= hi);
  const recallTicks = [0.85, 0.9, 0.95, 1].filter((r) => r >= minRecall);
  return (
    <figure className="bench-chart">
      <div className="bench-chart-scroll">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Queries per second against recall for each system">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} className="bench-grid" />
              <text x={pad.l - 8} y={y(t)} className="bench-axis" textAnchor="end" dominantBaseline="middle">{t >= 1000 ? `${t / 1000}k` : t}</text>
            </g>
          ))}
          {recallTicks.map((r) => (
            <g key={r}>
              <line x1={x(r)} x2={x(r)} y1={pad.t} y2={H - pad.b} className={`bench-grid ${r === 0.95 ? "target" : ""}`} />
              <text x={x(r)} y={H - pad.b + 18} className="bench-axis" textAnchor="middle">{r.toFixed(2)}</text>
            </g>
          ))}
          <text x={(pad.l + W - pad.r) / 2} y={H - 4} className="bench-axis" textAnchor="middle">recall@10 →</text>
          {set.systems.map((s) => {
            const pts = [...s.sweep].sort((a, b) => a.recall - b.recall);
            return (
              <g key={s.key}>
                {pts.length > 1 && (
                  <polyline points={pts.map((p) => `${x(p.recall).toFixed(1)},${y(p.qps).toFixed(1)}`).join(" ")}
                    fill="none" stroke={s.color} strokeWidth={s.key.startsWith("needledb") ? 2.6 : 1.8} strokeLinejoin="round" />
                )}
                {pts.map((p, i) => (
                  <circle key={i} cx={x(p.recall)} cy={y(p.qps)} r={3.4} fill={s.color} stroke="#fff" strokeWidth={1.4}>
                    <title>{`${s.name} · ef ${p.ef ?? "—"} · recall ${p.recall.toFixed(3)} · ${count(p.qps)} qps · p99 ${ms(p.p99Ms)}`}</title>
                  </circle>
                ))}
              </g>
            );
          })}
        </svg>
      </div>
      <figcaption className="bench-legend">
        {set.systems.map((s) => <span key={s.key}><i style={{ background: s.color }} />{s.name}</span>)}
        <span className="muted">Up and to the right is better · dashed line: 95% recall · 1 client</span>
      </figcaption>
    </figure>
  );
}

export function BenchmarksPage() {
  const [setIndex, setSetIndex] = useState(0);
  const [mode, setMode] = useState<"docker" | "native">("docker");
  if (!BENCHMARKS.length) {
    return <Callout kind="note">No benchmark results yet. Run <C>python -m bench.run</C>, then <C>python -m bench.export_docs</C>.</Callout>;
  }
  const set = BENCHMARKS[Math.min(setIndex, BENCHMARKS.length - 1)];
  const by = Object.fromEntries(set.systems.map((s) => [s.key, s])) as Record<string, BenchSystem | undefined>;
  const ours = mode === "docker" ? by["needledb-docker"] ?? by["needledb-server"] : by["needledb-server"] ?? by["needledb-docker"];
  const rivals = [by["qdrant-docker"], by["pgvector-docker"]].filter((s): s is BenchSystem => !!s);
  const allMetrics = metrics(set);

  const behind = ours ? allMetrics.flatMap((metric) => {
    const lost = rivals
      .map((rival) => ({ rival, verdict: versus(metric.value(ours), metric.value(rival), metric.higherIsBetter) }))
      .filter((r) => r.verdict?.tone === "loss");
    return lost.length ? [{ metric, lost }] : [];
  }) : [];

  const faiss = by["faiss-hnsw"];
  const embedded = by["needledb-embedded"];

  return (
    <>
      <div className="bench-controls">
        <div className="chart-switch" role="tablist" aria-label="Dataset">
          {BENCHMARKS.map((b, i) => (
            <button key={b.dataset} type="button" role="tab" aria-selected={i === setIndex} className={i === setIndex ? "on" : ""}
              onClick={() => setSetIndex(i)}>
              {b.dimension.toLocaleString("en-US")}-d
            </button>
          ))}
        </div>
        <div className="chart-switch" role="tablist" aria-label="NeedleDB row to compare">
          <button type="button" role="tab" aria-selected={mode === "docker"} className={mode === "docker" ? "on" : ""} onClick={() => setMode("docker")}>Like for like (Docker)</button>
          <button type="button" role="tab" aria-selected={mode === "native"} className={mode === "native" ? "on" : ""} onClick={() => setMode("native")}>Native server</button>
        </div>
      </div>

      <p className="bench-lede">
        {set.n.toLocaleString("en-US")} real OpenAI <C>text-embedding-3-large</C> vectors at {set.dimension.toLocaleString("en-US")} dimensions,
        HNSW with <C>m={set.m}</C>, each system at the smallest search width reaching 95% recall@10.
        {mode === "docker"
          ? " NeedleDB, Qdrant and pgvector all run in the same Docker VM with the same limits."
          : " The native server runs on the host with every core; Qdrant and pgvector run in Docker, so this view favours NeedleDB."}
      </p>

      {ours && (
        <div className="bench-cards">
          {allMetrics.map((metric) => (
            <div key={metric.id} className="bench-card">
              <span className="bench-card-title">{metric.title}</span>
              <b className="bench-card-value">{metric.format(metric.value(ours))}</b>
              <Verdicts ours={ours} rivals={rivals} metric={metric} />
            </div>
          ))}
          {faiss && ours.filtered["0.1%"] && (
            <div className="bench-card">
              <span className="bench-card-title">Recall with a 0.1% filter</span>
              <b className="bench-card-value">{(ours.filtered["0.1%"].recall * 100).toFixed(1)}%</b>
              <div className="bench-vs">
                <span className="vs vs-win">raw FAISS: {(faiss.filtered["0.1%"].recall * 100).toFixed(1)}%</span>
              </div>
            </div>
          )}
        </div>
      )}

      <H2 id="throughput-and-latency">Throughput, latency, build and memory</H2>
      <div className="bench-bar-groups">
        {allMetrics.map((metric) => <Bars key={metric.id} metric={metric} systems={set.systems} highlight={ours?.key ?? ""} />)}
      </div>

      <H2 id="recall-vs-speed">Recall against speed</H2>
      <p>Every point is one search width. A faster system at the same recall sits higher; one that reaches more recall for its speed sits further right.</p>
      <SweepChart set={set} />

      <H2 id="filtered-search">Filtered search</H2>
      <p>Recall@10 against exact filtered results, and median latency. The filter keeps the stated share of the corpus. Graph indexes that ignore the filter while searching lose most of their results on narrow filters.</p>
      <div className="bench-table">
      <DocTable head={["System", "50% kept", "10% kept", "1% kept", "0.1% kept"]} rows={set.systems.map((s) => [
        <span className="bench-name"><i style={{ background: s.color }} />{s.name}</span>,
        ...(["50%", "10%", "1%", "0.1%"] as const).map((k) => (
          <span className={`bench-cell ${s.filtered[k].recall < 0.9 ? "low" : ""}`}>
            <b>{s.filtered[k].recall.toFixed(3)}</b> · {ms(s.filtered[k].p50Ms)}
          </span>
        )),
      ])} />
      </div>

      <H2 id="all-numbers">All numbers at 95% recall</H2>
      <div className="bench-table">
      <DocTable head={["System", "Transport", "Build", "Memory", "ef", "Recall", "p50", "p99", "QPS", `QPS, ${set.clients} clients`]}
        rows={set.systems.map((s) => [
          <span className="bench-name"><i style={{ background: s.color }} />{s.name}</span>,
          s.transport, seconds(s.buildSeconds), gb(s.memoryBytes), s.operating.ef ?? "—", s.operating.recall.toFixed(3),
          ms(s.operating.p50Ms), ms(s.operating.p99Ms), count(s.operating.qps),
          s.concurrentQps == null ? "—" : `${count(s.concurrentQps)}${s.clientMode ? ` (${s.clientMode})` : ""}`,
        ])} />
      </div>

      <H2 id="where-we-are-behind">Where NeedleDB is behind</H2>
      {behind.length === 0 ? (
        <p>In this view NeedleDB is ahead of, or within 10% of, Qdrant and pgvector on every measure above.</p>
      ) : (
        <ul className="bench-behind">
          {behind.map(({ metric, lost }) => (
            <li key={metric.id}>
              <b>{metric.title}.</b>{" "}
              {lost.map(({ rival, verdict }) => `${verdict!.label} ${rival.name} (${metric.format(metric.value(ours!))} vs ${metric.format(metric.value(rival))})`).join("; ")}.
              <span className="bench-next">Next: {NEXT_STEPS[metric.id]}</span>
            </li>
          ))}
        </ul>
      )}
      {faiss && embedded && (
        <p>
          Embedded in-process, NeedleDB answers at {count(embedded.operating.qps)} queries per second against raw FAISS's {count(faiss.operating.qps)} —
          the difference is the durability log, tombstones and metadata that FAISS alone doesn't have.
        </p>
      )}

      <H2 id="pinecone">What about Pinecone?</H2>
      <p>
        Pinecone isn't in these numbers. It's a managed service reached over the internet, so each query includes a network round trip and
        runs on hardware you can't choose or match locally — a laptop benchmark wouldn't say anything fair about it.
        The honest comparison is NeedleDB in the same cloud region as your Pinecone index, over HTTPS for both, with the same embeddings and recall target.
      </p>

      <H2 id="method">Method</H2>
      <ul>
        <li><b>Data.</b> DBpedia entities embedded with OpenAI <C>text-embedding-3-large</C> (Qdrant's public copies), unit-normalised, cosine similarity. The first {set.n.toLocaleString("en-US")} rows are the corpus; the next 1,000 are held-out queries. Ground truth is exact brute force.</li>
        <li><b>Latency.</b> One client, sequential, measured end to end: in-process calls for embedded engines, a real network round trip for servers.</li>
        <li><b>Concurrency.</b> {set.clients} clients for 10 seconds. Networked systems get one client process per connection; in-process engines use threads.</li>
        <li><b>Wire formats.</b> Qdrant over gRPC, Postgres over its binary protocol with prepared statements, NeedleDB over HTTP with base64 float32 vectors.</li>
        <li><b>pgvector at 3,072-d</b> uses <C>halfvec</C> (float16), because its <C>vector</C> type indexes at most 2,000 dimensions.</li>
        <li><b>One machine, one run.</b> Treat differences under 10% as noise. Runs shared the machine with unrelated CPU-heavy jobs, so absolute numbers are conservative; every system ran under the same conditions.</li>
      </ul>
      <Callout kind="note" title="Machine">
        {set.machine}{set.dockerVm ? ` · Docker VM ${set.dockerVm}` : ""}. Versions: {Object.entries(set.versions).map(([k, v]) => `${k} ${v}`).join(", ")}. Finished {set.finishedAt.slice(0, 10)}.
      </Callout>

      <H3 id="reproduce">Reproduce</H3>
      <CodeBlock lang="bash" title="Terminal" code={`pip install -e ".[bench]"
python -m bench.run --dataset dbpedia-${set.dimension} --n ${set.n} \\
    --systems numpy-exact,faiss-hnsw,needledb-embedded,needledb-server
docker compose -f bench/docker-compose.yml up -d --build
python -m bench.run --dataset dbpedia-${set.dimension} --n ${set.n} \\
    --systems needledb-docker,qdrant-docker,pgvector-docker
python -m bench.report && python -m bench.export_docs`} />
    </>
  );
}
