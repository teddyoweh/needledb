import { type PointerEvent, type ReactNode, useRef, useState } from "react";
import { smooth } from "../charts";
import { CodeBlock } from "../code";
import { BrandMark } from "../icons";
import { BENCHMARKS, type BenchmarkSet, type BenchPoint, type BenchSystem } from "./benchmarkData";
import { C, Callout, DocTable, H2, H3 } from "./parts";

// ---- identity & formatting ------------------------------------------------------------------

type Identity = { name: string; color: string; logo?: string; dashed?: boolean };

// A colour per system, checked for colourblind separation and contrast against the page.
const IDENTITY: Record<string, Identity> = {
  "needledb-server": { name: "NeedleDB", color: "#2f6bff" },
  "needledb-docker": { name: "NeedleDB", color: "#2f6bff" },
  "needledb-embedded": { name: "Embedded", color: "#2f6bff" },
  "qdrant-docker": { name: "Qdrant", color: "#dc244c", logo: "qdrant" },
  "pgvector-docker": { name: "pgvector", color: "#0d9488", logo: "postgresql" },
  "faiss-hnsw": { name: "Raw FAISS", color: "#c2670a", logo: "meta", dashed: true },
  "numpy-exact": { name: "Brute force", color: "#7c5cd6", dashed: true },
};

const who = (s: BenchSystem): Identity => IDENTITY[s.key] ?? { name: s.name, color: "#999999" };
const isOurs = (s: BenchSystem) => s.key.startsWith("needledb");

const count = (v: number | null) => (v == null ? "—" : Math.round(v).toLocaleString("en-US"));
const ms = (v: number | null) => (v == null ? "—" : v < 10 ? `${v.toFixed(2)} ms` : `${v.toFixed(1)} ms`);
const secs = (v: number | null) => (v == null ? "—" : `${v.toFixed(v < 10 ? 1 : 0)} s`);
const gb = (v: number | null) => (v == null ? "—" : `${(v / 2 ** 30).toFixed(2)} GB`);
const compact = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1).replace(/\.0$/, "")}k` : `${Math.round(v)}`);

function Mark({ system, size = 16 }: { system: BenchSystem; size?: number }) {
  const id = who(system);
  if (isOurs(system)) return <BrandMark size={size} />;
  if (id.logo) return <img className="bench-logo" src={`brands/${id.logo}.svg`} width={size} height={size} alt="" />;
  return <span className="bench-dot" style={{ width: size * 0.6, height: size * 0.6, background: id.color }} />;
}

// ---- comparisons ----------------------------------------------------------------------------

type Metric = {
  id: string;
  title: string;
  unit: string;
  higherIsBetter: boolean;
  verb: string;
  value: (s: BenchSystem) => number | null;
  format: (v: number | null) => string;
};

const metricsFor = (set: BenchmarkSet): Metric[] => [
  { id: "concurrent", title: `Throughput, ${set.clients} clients`, unit: "queries / s", higherIsBetter: true, verb: "faster", value: (s) => s.concurrentQps, format: count },
  { id: "qps", title: "Throughput, one client", unit: "queries / s", higherIsBetter: true, verb: "faster", value: (s) => s.operating.qps, format: count },
  { id: "p50", title: "Median latency", unit: "", higherIsBetter: false, verb: "lower", value: (s) => s.operating.p50Ms, format: ms },
  { id: "p99", title: "Tail latency, p99", unit: "", higherIsBetter: false, verb: "lower", value: (s) => s.operating.p99Ms, format: ms },
  { id: "build", title: `Time to index ${set.n.toLocaleString("en-US")} vectors`, unit: "", higherIsBetter: false, verb: "faster", value: (s) => s.buildSeconds, format: secs },
  { id: "memory", title: "Memory", unit: "", higherIsBetter: false, verb: "less", value: (s) => s.memoryBytes, format: gb },
];

type Relation = { tone: "win" | "loss" | "even"; text: string };

/** Within 10% is "on par": one run on a shared machine can't separate closer results. */
function relation(metric: Metric, ours: BenchSystem, rival: BenchSystem): Relation | null {
  const a = metric.value(ours);
  const b = metric.value(rival);
  if (a == null || b == null || a <= 0 || b <= 0) return null;
  const factor = metric.higherIsBetter ? a / b : b / a;
  const name = who(rival).name;
  if (factor >= 1.1) return { tone: "win", text: `${factor >= 1.95 ? `${factor.toFixed(1)}×` : `${Math.round((factor - 1) * 100)}%`} ${metric.verb} than ${name}` };
  if (factor <= 1 / 1.1) return { tone: "loss", text: `${Math.round((1 - factor) * 100)}% behind ${name}` };
  return { tone: "even", text: `on par with ${name}` };
}

function Relations({ metric, ours, rivals }: { metric: Metric; ours: BenchSystem; rivals: BenchSystem[] }) {
  return (
    <>
      {rivals.map((rival) => {
        const r = relation(metric, ours, rival);
        return r && <span key={rival.key} className={`rel rel-${r.tone}`}>{r.text}</span>;
      })}
    </>
  );
}

// ---- hero ---------------------------------------------------------------------------------------

function Hero({ set, ours, rivals, faiss }: { set: BenchmarkSet; ours: BenchSystem; rivals: BenchSystem[]; faiss?: BenchSystem }) {
  const m = metricsFor(set);
  const concurrent = m.find((x) => x.id === "concurrent")!;
  const build = m.find((x) => x.id === "build")!;
  const narrow = ours.filtered["0.1%"];
  return (
    <div className="bench-hero">
      <div className="bench-hero-eyebrow">
        <BrandMark size={22} />
        <span><b>{set.n.toLocaleString("en-US")}</b> OpenAI embeddings · <b>{set.dimension.toLocaleString("en-US")}</b> dimensions · at 95% recall</span>
      </div>
      <div className="bench-hero-stats">
        <div className="bench-hero-stat">
          <b>{count(ours.concurrentQps)}</b>
          <span>queries per second with {set.clients} concurrent clients</span>
          <div className="bench-hero-rel"><Relations metric={concurrent} ours={ours} rivals={rivals} /></div>
        </div>
        <div className="bench-hero-stat">
          <b>{narrow ? `${Math.round(narrow.recall * 100)}%` : "—"}</b>
          <span>recall when a filter keeps just 0.1% of the data</span>
          {faiss && <div className="bench-hero-rel"><span className="rel rel-win">raw FAISS keeps {Math.round(faiss.filtered["0.1%"].recall * 100)}%</span></div>}
        </div>
        <div className="bench-hero-stat">
          <b>{secs(ours.buildSeconds)}</b>
          <span>to index {set.n.toLocaleString("en-US")} vectors, durably</span>
          <div className="bench-hero-rel"><Relations metric={build} ours={ours} rivals={rivals} /></div>
        </div>
      </div>
    </div>
  );
}

// ---- head to head ---------------------------------------------------------------------------------

function HeadToHead({ metric, ours, systems }: { metric: Metric; ours: BenchSystem; systems: BenchSystem[] }) {
  const rows = systems.filter((s) => metric.value(s) != null);
  if (!rows.length || metric.value(ours) == null) return null;
  const values = rows.map((s) => metric.value(s)!);
  const max = Math.max(...values);
  const best = metric.higherIsBetter ? Math.max(...values) : Math.min(...values);
  return (
    <section className="h2h">
      <header>
        <span className="h2h-title">{metric.title}</span>
        <span className="h2h-note">{metric.higherIsBetter ? "higher is better" : "lower is better"}</span>
      </header>
      <div className="h2h-lead"><b>{metric.format(metric.value(ours))}</b>{metric.unit && <span>{metric.unit}</span>}</div>
      <div className="h2h-rel"><Relations metric={metric} ours={ours} rivals={rows.filter((s) => s.key !== ours.key)} /></div>
      <ul className="h2h-bars">
        {rows.map((s, i) => {
          const v = metric.value(s)!;
          return (
            <li key={s.key} className={s.key === ours.key ? "ours" : ""}>
              <span className="h2h-name"><Mark system={s} size={14} />{who(s).name}</span>
              <span className="h2h-track">
                <i style={{
                  width: `${Math.max(2.5, (v / max) * 100)}%`,
                  background: `linear-gradient(90deg, color-mix(in oklab, ${who(s).color} 52%, #fff), ${who(s).color})`,
                  animationDelay: `${i * 70}ms`,
                }} />
              </span>
              <span className="h2h-value">{metric.format(v)}{v === best && rows.length > 1 && <em>best</em>}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ---- charts -------------------------------------------------------------------------------------------

function Legend({ systems }: { systems: BenchSystem[] }) {
  return (
    <div className="bench-legend">
      {systems.map((s) => {
        const id = who(s);
        return (
          <span key={s.key} className={isOurs(s) ? "on" : ""}>
            <i className={id.dashed ? "dash" : ""} style={{ background: id.color }} />
            {id.name}
          </span>
        );
      })}
    </div>
  );
}

/** A dark card that names a system and lists its numbers, following the cursor. */
function Tip({ x, y, width, height, children, place = "above" }: {
  x: number;
  y: number;
  width: number;
  height: number;
  children: ReactNode;
  place?: "above" | "right";
}) {
  const style = place === "above"
    ? { left: `${(Math.min(Math.max(x, 96), width - 96) / width) * 100}%`, top: `${(y / height) * 100}%`, transform: "translate(-50%, calc(-100% - 14px))" }
    : { left: `${(Math.min(x + 14, width - 210) / width) * 100}%`, top: `${(y / height) * 100}%` };
  return <div className="bench-tip" style={style}>{children}</div>;
}

function TipRow({ system, value, detail, faint }: { system: BenchSystem; value: string; detail?: string; faint?: boolean }) {
  return (
    <div className={`tip-row${faint ? " faint" : ""}`}>
      <i style={{ background: who(system).color }} />
      <span>{who(system).name}</span>
      <b>{value}</b>
      {detail && <em>{detail}</em>}
    </div>
  );
}

function usePlotPointer(width: number, height: number) {
  const ref = useRef<SVGSVGElement>(null);
  const toPlot = (e: PointerEvent<SVGSVGElement>) => {
    const rect = ref.current!.getBoundingClientRect();
    return [((e.clientX - rect.left) / rect.width) * width, ((e.clientY - rect.top) / rect.height) * height] as const;
  };
  return { ref, toPlot };
}

function logTicks(lo: number, hi: number) {
  const out: number[] = [];
  for (let e = Math.floor(lo); e <= Math.ceil(hi); e++) {
    for (const m of [1, 2, 5]) {
      const v = m * 10 ** e;
      if (Math.log10(v) >= lo && Math.log10(v) <= hi) out.push(v);
    }
  }
  return out;
}

function SpeedRecall({ systems }: { systems: BenchSystem[] }) {
  const W = 720;
  const H = 330;
  const pad = { l: 48, r: 18, t: 26, b: 42 };
  const [hover, setHover] = useState<{ s: BenchSystem; p: BenchPoint } | null>(null);
  const { ref, toPlot } = usePlotPointer(W, H);
  const all = systems.flatMap((s) => s.sweep.filter((p) => p.qps > 0).map((p) => ({ s, p })));
  const minRecall = Math.min(0.85, Math.floor(Math.min(...all.map((d) => d.p.recall)) * 20) / 20);
  const lo = Math.log10(Math.min(...all.map((d) => d.p.qps)) * 0.75);
  const hi = Math.log10(Math.max(...all.map((d) => d.p.qps)) * 1.3);
  const x = (r: number) => pad.l + ((r - minRecall) / (1 - minRecall)) * (W - pad.l - pad.r);
  const y = (q: number) => pad.t + (1 - (Math.log10(q) - lo) / (hi - lo)) * (H - pad.t - pad.b);
  const recallTicks = [0.85, 0.9, 0.95, 1].filter((r) => r >= minRecall);

  function onMove(e: PointerEvent<SVGSVGElement>) {
    const [mx, my] = toPlot(e);
    let best: { s: BenchSystem; p: BenchPoint } | null = null;
    let bestDist = 900;
    for (const d of all) {
      const dist = (x(d.p.recall) - mx) ** 2 + (y(d.p.qps) - my) ** 2;
      if (dist < bestDist) {
        bestDist = dist;
        best = d;
      }
    }
    setHover(best);
  }

  const order = [...systems].sort((a, b) => Number(isOurs(a)) - Number(isOurs(b)));
  return (
    <figure className="bench-figure">
      <div className="bench-figure-head">
        <div><b>Throughput against recall</b><span>One client · each point is one search width</span></div>
        <Legend systems={systems} />
      </div>
      <div className="bench-plot">
        <svg ref={ref} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Queries per second against recall@10"
          onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
          <defs>
            <linearGradient id="bench-ours" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="#2f6bff" stopOpacity="0.16" />
              <stop offset="100%" stopColor="#2f6bff" stopOpacity="0" />
            </linearGradient>
          </defs>
          <rect x={x(0.95)} y={pad.t} width={W - pad.r - x(0.95)} height={H - pad.t - pad.b} rx={8} className="zone" />
          <text x={x(0.95) + 8} y={pad.t + 15} className="zone-label">95%+ recall</text>
          {logTicks(lo, hi).map((t) => (
            <g key={t}>
              <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} className="gridline" />
              <text x={pad.l - 10} y={y(t)} className="axis" textAnchor="end" dominantBaseline="middle">{compact(t)}</text>
            </g>
          ))}
          {recallTicks.map((r) => (
            <text key={r} x={x(r)} y={H - pad.b + 20} className="axis" textAnchor="middle">{`${Math.round(r * 100)}%`}</text>
          ))}
          <text x={W - pad.r} y={H - 4} className="axis-title" textAnchor="end">recall@10</text>
          <text x={pad.l - 10} y={12} className="axis-title" textAnchor="end">qps</text>
          {order.map((s) => {
            const id = who(s);
            const pts = [...s.sweep].filter((p) => p.qps > 0).sort((a, b) => a.recall - b.recall);
            const ours = isOurs(s);
            const line = pts.length > 1 ? smooth(pts.map((p) => [x(p.recall), y(p.qps)])) : "";
            return (
              <g key={s.key} opacity={hover && hover.s.key !== s.key ? 0.32 : 1}>
                {line && ours && (
                  <path d={`${line}L${x(pts[pts.length - 1].recall).toFixed(1)},${H - pad.b}L${x(pts[0].recall).toFixed(1)},${H - pad.b}Z`} fill="url(#bench-ours)" />
                )}
                {line && (
                  <path d={line} fill="none" stroke={id.color}
                    strokeWidth={ours ? 3 : 2} strokeDasharray={id.dashed ? "5 4" : undefined} strokeLinecap="round" />
                )}
                {pts.map((p, i) => (
                  <circle key={i} cx={x(p.recall)} cy={y(p.qps)} r={ours ? 4 : 3} fill={id.color} stroke="#f3f3f6" strokeWidth={1.5} />
                ))}
              </g>
            );
          })}
          {hover && (
            <g>
              <line x1={x(hover.p.recall)} x2={x(hover.p.recall)} y1={y(hover.p.qps)} y2={H - pad.b} className="guide" />
              <circle cx={x(hover.p.recall)} cy={y(hover.p.qps)} r={6} fill={who(hover.s).color} stroke="#fff" strokeWidth={2.5} />
            </g>
          )}
        </svg>
        {hover && (
          <Tip x={x(hover.p.recall)} y={y(hover.p.qps)} width={W} height={H}>
            <b><Mark system={hover.s} size={15} />{who(hover.s).name}</b>
            <div className="tip-lead" style={{ color: who(hover.s).color }}>{count(hover.p.qps)} <span>queries / s</span></div>
            <dl>
              <dt>recall@10</dt><dd>{(hover.p.recall * 100).toFixed(1)}%</dd>
              <dt>search width</dt><dd>{hover.p.ef ?? "exact"}</dd>
              <dt>p50 · p99</dt><dd>{ms(hover.p.p50Ms)} · {ms(hover.p.p99Ms)}</dd>
            </dl>
          </Tip>
        )}
      </div>
    </figure>
  );
}

const FILTERS = ["50%", "10%", "1%", "0.1%"] as const;

function FilterRecall({ systems }: { systems: BenchSystem[] }) {
  const W = 720;
  const H = 290;
  const pad = { l: 48, r: 132, t: 18, b: 42 };
  const [column, setColumn] = useState<number | null>(null);
  const { ref, toPlot } = usePlotPointer(W, H);
  const x = (i: number) => pad.l + (i / (FILTERS.length - 1)) * (W - pad.l - pad.r);
  const y = (r: number) => pad.t + (1 - r) * (H - pad.t - pad.b);
  const order = [...systems].sort((a, b) => Number(isOurs(a)) - Number(isOurs(b)));
  const labelled = systems.filter((s) => isOurs(s) || s.key === "faiss-hnsw");

  return (
    <figure className="bench-figure">
      <div className="bench-figure-head">
        <div><b>Recall as the filter narrows</b><span>Share of the corpus the filter keeps · recall@10 against exact filtered results</span></div>
        <Legend systems={systems} />
      </div>
      <div className="bench-plot">
        <svg ref={ref} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Recall at each filter selectivity"
          onPointerMove={(e) => {
            const [mx] = toPlot(e);
            const i = Math.round(((mx - pad.l) / (W - pad.l - pad.r)) * (FILTERS.length - 1));
            setColumn(i >= 0 && i < FILTERS.length ? i : null);
          }}
          onPointerLeave={() => setColumn(null)}>
          {[0, 0.25, 0.5, 0.75, 1].map((t) => (
            <g key={t}>
              <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} className="gridline" />
              <text x={pad.l - 10} y={y(t)} className="axis" textAnchor="end" dominantBaseline="middle">{`${t * 100}%`}</text>
            </g>
          ))}
          {FILTERS.map((f, i) => (
            <text key={f} x={x(i)} y={H - pad.b + 20} className="axis" textAnchor="middle">{f} kept</text>
          ))}
          {column != null && <line x1={x(column)} x2={x(column)} y1={pad.t} y2={H - pad.b} className="guide" />}
          {order.map((s) => {
            const id = who(s);
            const pts = FILTERS.map((f, i) => [x(i), y(s.filtered[f].recall)] as [number, number]);
            return (
              <g key={s.key}>
                <path d={smooth(pts)} fill="none" stroke={id.color} strokeWidth={isOurs(s) ? 3 : 2} strokeDasharray={id.dashed ? "5 4" : undefined} strokeLinecap="round" />
                {pts.map(([px, py], i) => <circle key={i} cx={px} cy={py} r={isOurs(s) ? 4 : 3} fill={id.color} stroke="#f3f3f6" strokeWidth={1.5} />)}
              </g>
            );
          })}
          {labelled.map((s) => {
            const last = s.filtered["0.1%"].recall;
            const low = last < 0.9;
            return (
              <g key={s.key}>
                <text x={x(FILTERS.length - 1) + 12} y={y(last) - (low ? 0 : 4)} className="direct" fill={low ? "#d33a44" : who(s).color} dominantBaseline="middle">
                  {who(s).name} {Math.round(last * 100)}%
                </text>
                {low && <text x={x(FILTERS.length - 1) + 12} y={y(last) + 15} className="direct-sub" dominantBaseline="middle">misses most results</text>}
              </g>
            );
          })}
        </svg>
        {column != null && (
          <Tip x={x(column)} y={pad.t} width={W} height={H} place="right">
            <b>Filter keeps {FILTERS[column]} of the data</b>
            {[...systems]
              .sort((a, b) => b.filtered[FILTERS[column]].recall - a.filtered[FILTERS[column]].recall)
              .map((s) => (
                <TipRow key={s.key} system={s} value={`${(s.filtered[FILTERS[column]].recall * 100).toFixed(1)}%`}
                  detail={ms(s.filtered[FILTERS[column]].p50Ms)} faint={s.filtered[FILTERS[column]].recall < 0.9} />
              ))}
          </Tip>
        )}
      </div>
    </figure>
  );
}

/** Keep labels at least `gap` apart vertically while staying near their points. */
function dodge(items: { key: string; y: number }[], gap: number): Record<string, number> {
  const sorted = [...items].sort((a, b) => a.y - b.y).map((d) => ({ ...d }));
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].y - sorted[i - 1].y < gap) sorted[i].y = sorted[i - 1].y + gap;
  }
  return Object.fromEntries(sorted.map((d) => [d.key, d.y]));
}

function Scaling({ set, systems }: { set: BenchmarkSet; systems: BenchSystem[] }) {
  const rows = systems.filter((s) => s.concurrentQps != null && s.operating.qps > 0);
  if (!rows.length) return null;
  const W = 720;
  const H = 280;
  const pad = { l: 150, r: 210, t: 26, b: 34 };
  const values = rows.flatMap((s) => [s.operating.qps, s.concurrentQps!]);
  const lo = Math.log10(Math.min(...values) * 0.8);
  const hi = Math.log10(Math.max(...values) * 1.2);
  const y = (q: number) => pad.t + (1 - (Math.log10(q) - lo) / (hi - lo)) * (H - pad.t - pad.b);
  const left = pad.l;
  const right = W - pad.r;
  const leftLabels = dodge(rows.map((s) => ({ key: s.key, y: y(s.operating.qps) })), 17);
  const rightLabels = dodge(rows.map((s) => ({ key: s.key, y: y(s.concurrentQps!) })), 17);
  const order = [...rows].sort((a, b) => Number(isOurs(a)) - Number(isOurs(b)));
  return (
    <figure className="bench-figure">
      <div className="bench-figure-head"><b>How throughput scales with concurrent clients</b><span>Same search width · higher is better</span></div>
      <div className="bench-plot">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Queries per second with one and ${set.clients} clients`}>
          <text x={left} y={14} className="axis-title" textAnchor="middle">1 client</text>
          <text x={right} y={14} className="axis-title" textAnchor="middle">{set.clients} clients</text>
          <line x1={left} x2={left} y1={pad.t} y2={H - pad.b} className="gridline" />
          <line x1={right} x2={right} y1={pad.t} y2={H - pad.b} className="gridline" />
          {order.map((s) => {
            const id = who(s);
            const ours = isOurs(s);
            const gain = s.concurrentQps! / s.operating.qps;
            return (
              <g key={s.key}>
                <line x1={left} x2={right} y1={y(s.operating.qps)} y2={y(s.concurrentQps!)} stroke={id.color} strokeWidth={ours ? 3.5 : 2.2} strokeLinecap="round" strokeDasharray={id.dashed ? "5 4" : undefined} />
                <circle cx={left} cy={y(s.operating.qps)} r={ours ? 5 : 4} fill={id.color} stroke="#f3f3f6" strokeWidth={2} />
                <circle cx={right} cy={y(s.concurrentQps!)} r={ours ? 5 : 4} fill={id.color} stroke="#f3f3f6" strokeWidth={2} />
                <text x={left - 14} y={leftLabels[s.key]} className="direct" textAnchor="end" dominantBaseline="middle" fill={ours ? id.color : "#5c5d66"}>
                  {id.name} <tspan className="direct-sub">{count(s.operating.qps)}</tspan>
                </text>
                <text x={right + 14} y={rightLabels[s.key]} className="direct" dominantBaseline="middle" fill={ours ? id.color : "#5c5d66"}>
                  {count(s.concurrentQps)} <tspan className="direct-sub">qps · {gain.toFixed(1)}× from 1 client</tspan>
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </figure>
  );
}

// ---- page -------------------------------------------------------------------------------------------------

const NEXT_STEPS: Record<string, string> = {
  concurrent: "Micro-batch concurrent queries into one FAISS call, so a burst of requests shares a single thread hop and every core.",
  qps: "Move more of the request path out of Python with a compiled HTTP front end for queries.",
  p50: "The same front-end work, since most of a query's time outside FAISS is request handling.",
  p99: "Pin search threads and keep FAISS's thread pool from oversubscribing cores under load.",
  build: "Parallel graph construction during bulk loads, and a streaming binary upsert that skips JSON.",
  memory: "Vectors already serve from fp16; int8 and product quantization, for another 2–4×, are next on the roadmap.",
};

function Tabs<T extends string | number>({ label, value, options, onChange }: {
  label: string;
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="chart-switch" role="tablist" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.value)} type="button" role="tab" aria-selected={o.value === value} className={o.value === value ? "on" : ""}
          onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
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
  const ours = (mode === "docker" ? by["needledb-docker"] ?? by["needledb-server"] : by["needledb-server"] ?? by["needledb-docker"])!;
  const rivals = [by["qdrant-docker"], by["pgvector-docker"]].filter((s): s is BenchSystem => !!s);
  const faiss = by["faiss-hnsw"];
  const embedded = by["needledb-embedded"];
  const contenders = [ours, ...rivals];
  const withReference = faiss ? [...contenders, faiss] : contenders;
  const metrics = metricsFor(set);

  const behind = metrics.flatMap((metric) => {
    const lost = rivals.map((rival) => ({ rival, r: relation(metric, ours, rival) })).filter((d) => d.r?.tone === "loss");
    return lost.length ? [{ metric, lost }] : [];
  });

  return (
    <>
      <div className="bench-controls">
        <Tabs label="Dataset" value={setIndex} onChange={setSetIndex}
          options={BENCHMARKS.map((b, i) => ({ value: i, label: `${b.dimension.toLocaleString("en-US")} dimensions` }))} />
        <Tabs label="Which NeedleDB" value={mode} onChange={setMode}
          options={[{ value: "docker", label: "Like for like · all in Docker" }, { value: "native", label: "NeedleDB native" }]} />
      </div>

      {ours && <Hero set={set} ours={ours} rivals={rivals} faiss={faiss} />}

      <p>
        Real OpenAI <C>text-embedding-3-large</C> vectors, HNSW with <C>m={set.m}</C> for every system, each tuned to the smallest search width that reaches 95% recall@10.
        {mode === "docker"
          ? " NeedleDB, Qdrant and pgvector run in the same Docker VM with identical CPU and memory limits."
          : " NeedleDB runs natively with every core while Qdrant and pgvector run in Docker — switch to like for like for the even view."}
      </p>

      <H2 id="head-to-head">Head to head</H2>
      <div className="h2h-grid">
        {metrics.map((metric) => <HeadToHead key={metric.id} metric={metric} ours={ours} systems={contenders} />)}
      </div>

      <H2 id="recall-vs-speed">Recall against speed</H2>
      <p>Approximate indexes trade recall for speed. Up and to the right is better; the shaded band is where production search usually runs.</p>
      <SpeedRecall systems={withReference} />

      <H2 id="concurrency">Under concurrent load</H2>
      <Scaling set={set} systems={contenders} />

      <H2 id="filtered-search">Filtered search</H2>
      <p>
        Filters are where approximate indexes quietly fail: search the graph first, filter afterwards, and a narrow filter leaves almost nothing.
        NeedleDB plans each filtered query — scanning a small matching subset exactly, and widening the graph search for broad ones.
      </p>
      <FilterRecall systems={withReference} />

      {embedded && faiss && (
        <>
          <H2 id="engine">The engine, in process</H2>
          <p>
            Embedded in your Python process, NeedleDB adds a durable log, deletes, namespaces and metadata filtering on
            top of FAISS — and still comes out ahead of the raw library at the same recall, because it serves fp16
            vectors where FAISS's own defaults keep float32. The graph, the parameters and the search are the library's.
          </p>
          <div className="h2h-grid">
            {metrics.filter((m) => m.id === "qps" || m.id === "concurrent").map((metric) => (
              <HeadToHead key={metric.id} metric={metric} ours={embedded} systems={[embedded, faiss]} />
            ))}
          </div>
        </>
      )}

      <H2 id="where-we-are-behind">Where NeedleDB is behind</H2>
      {behind.length === 0 ? (
        <p>In this view NeedleDB is ahead of, or within 10% of, Qdrant and pgvector on every measure.</p>
      ) : (
        <ul className="bench-behind">
          {behind.map(({ metric, lost }) => (
            <li key={metric.id}>
              <b>{metric.title}:</b>{" "}
              {lost.map(({ rival, r }) => `${r!.text} (${metric.format(metric.value(ours))} vs ${metric.format(metric.value(rival))})`).join("; ")}.
              <span className="bench-next">Next: {NEXT_STEPS[metric.id]}</span>
            </li>
          ))}
        </ul>
      )}

      <H2 id="all-numbers">Every number</H2>
      <div className="bench-table">
        <DocTable head={["System", "Transport", "Build", "Memory", "ef", "Recall", "p50", "p99", "QPS", `QPS, ${set.clients} clients`]}
          rows={set.systems.map((s) => [
            <span className="bench-name"><Mark system={s} size={14} />{s.name}</span>,
            s.transport, secs(s.buildSeconds), gb(s.memoryBytes), s.operating.ef ?? "—", s.operating.recall.toFixed(3),
            ms(s.operating.p50Ms), ms(s.operating.p99Ms), count(s.operating.qps),
            s.concurrentQps == null ? "—" : `${count(s.concurrentQps)}${s.clientMode ? ` (${s.clientMode})` : ""}`,
          ])} />
      </div>
      <div className="bench-table">
        <DocTable head={["System", "50% kept", "10% kept", "1% kept", "0.1% kept"]} rows={set.systems.map((s) => [
          <span className="bench-name"><Mark system={s} size={14} />{s.name}</span>,
          ...FILTERS.map((k) => (
            <span className={`bench-cell ${s.filtered[k].recall < 0.9 ? "low" : ""}`}><b>{s.filtered[k].recall.toFixed(3)}</b> · {ms(s.filtered[k].p50Ms)}</span>
          )),
        ])} />
      </div>

      <H2 id="pinecone">What about Pinecone?</H2>
      <p>
        Pinecone isn't in these numbers. It's a managed service reached over the internet, so each query includes a network round trip and runs on hardware
        that can't be matched on one machine. The fair comparison is NeedleDB in the same cloud region as a Pinecone index, over HTTPS for both, with the same
        embeddings and recall target.
      </p>

      <H2 id="method">Method</H2>
      <ul>
        <li><b>Data.</b> DBpedia entities embedded with OpenAI <C>text-embedding-3-large</C> (Qdrant's public copies), unit-normalised, cosine similarity. The first {set.n.toLocaleString("en-US")} rows are the corpus; the next 1,000 are held-out queries. Ground truth is exact brute force.</li>
        <li><b>Latency.</b> One client, sequential, measured end to end: in-process calls for embedded engines, a real network round trip for servers.</li>
        <li><b>Concurrency.</b> {set.clients} clients for 10 seconds. Networked systems get one client process per connection; in-process engines use threads.</li>
        <li><b>Wire formats.</b> Qdrant over gRPC, Postgres over its binary protocol with prepared statements, NeedleDB over HTTP with base64 float32 vectors.</li>
        <li><b>Vector storage.</b> NeedleDB serves graph indexes from fp16 vectors, its default; recall is measured against exact float32 ground truth either way. pgvector stores <C>halfvec</C> at 3,072 dimensions and <C>vector</C> at 1,536; Qdrant keeps float32.</li>
        <li><b>Threads.</b> Every server gets the same 8 CPUs. NeedleDB sizes its search pool to the container's CPU quota rather than the host's cores, so it never runs more searches at once than the VM will schedule.</li>
        <li><b>pgvector at 3,072 dimensions</b> uses <C>halfvec</C> (float16), because its <C>vector</C> type indexes at most 2,000 dimensions.</li>
        <li><b>One machine, one run.</b> Differences under 10% are shown as “on par”. Runs shared the machine with unrelated CPU-heavy jobs, so absolute numbers are conservative; every system ran under the same conditions.</li>
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
