import { type MouseEvent, useId, useLayoutEffect, useRef, useState } from "react";

export type Series = { name: string; color: string; values: (number | null)[] };

const nonNull = (v: number | null): v is number => v != null;

function niceMax(v: number) {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const m = v / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
}

/** Monotone cubic curve through the points: smooth, and never overshoots the data. */
export function smooth(points: [number, number][]): string {
  const n = points.length;
  if (n === 0) return "";
  if (n < 3) return points.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
  const dx: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = points[i + 1][0] - points[i][0];
    slope[i] = dx[i] ? (points[i + 1][1] - points[i][1]) / dx[i] : 0;
  }
  const tangent: number[] = [slope[0]];
  for (let i = 1; i < n - 1; i++) tangent[i] = slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2;
  tangent[n - 1] = slope[n - 2];
  for (let i = 0; i < n - 1; i++) {
    if (slope[i] === 0) {
      tangent[i] = tangent[i + 1] = 0;
      continue;
    }
    const a = tangent[i] / slope[i];
    const b = tangent[i + 1] / slope[i];
    const h = a * a + b * b;
    if (h > 9) {
      const t = 3 / Math.sqrt(h);
      tangent[i] = t * a * slope[i];
      tangent[i + 1] = t * b * slope[i];
    }
  }
  let d = `M${points[0][0].toFixed(1)},${points[0][1].toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[i + 1];
    const step = dx[i] / 3;
    d += `C${(x0 + step).toFixed(1)},${(y0 + tangent[i] * step).toFixed(1)} ${(x1 - step).toFixed(1)},${(y1 - tangent[i + 1] * step).toFixed(1)} ${x1.toFixed(1)},${y1.toFixed(1)}`;
  }
  return d;
}

/** Carry the last known value across gaps, so a quiet moment doesn't break the line. */
function hold(values: (number | null)[]) {
  let last: number | null = null;
  return values.map((v) => (v != null ? (last = v) : last));
}

/** Exponential smoothing: follows the trend, ignores the jitter. */
function ease(values: (number | null)[], alpha: number) {
  let prev: number | null = null;
  return values.map((v) => {
    if (v == null) return prev;
    prev = prev == null ? v : prev + alpha * (v - prev);
    return prev;
  });
}

const BUCKETS_MS = [2_000, 4_000, 6_000, 10_000, 12_000, 20_000, 30_000, 60_000, 120_000, 300_000];

/**
 * Average samples into fixed time buckets (aligned to the clock, so they don't shift
 * as new samples arrive), then ease between buckets.
 */
function calm(times: number[], series: Series[], target: number) {
  const n = times.length;
  if (n < 2) return { times, series: series.map((s) => ({ ...s, values: hold(s.values) })) };
  const span = times[n - 1] - times[0];
  const step = BUCKETS_MS.find((ms) => span / ms <= target) ?? BUCKETS_MS[BUCKETS_MS.length - 1];
  const slot = new Map<number, number>();
  const keys: number[] = [];
  for (const t of times) {
    const k = Math.floor(t / step);
    if (!slot.has(k)) {
      slot.set(k, keys.length);
      keys.push(k);
    }
  }
  return {
    times: keys.map((k) => Math.min((k + 1) * step, times[n - 1])),
    series: series.map((s) => {
      const sums = keys.map(() => 0);
      const counts = keys.map(() => 0);
      hold(s.values).forEach((v, i) => {
        if (v == null) return;
        const b = slot.get(Math.floor(times[i] / step))!;
        sums[b] += v;
        counts[b] += 1;
      });
      return { ...s, values: ease(sums.map((sum, b) => (counts[b] ? sum / counts[b] : null)), 0.5) };
    }),
  };
}

/**
 * A live area chart in the style of a finance dashboard: a calm curve, a soft fill,
 * dashed guides, and a value pill on the latest point that follows the cursor.
 * `floor` is the smallest top of scale, so tiny values stay near the baseline.
 */
export function AreaChart({ times, series, format, height = 220, empty = "Waiting for traffic", floor = 0, points = 60 }: {
  times: number[];
  series: Series[];
  format: (v: number) => string;
  height?: number;
  empty?: string;
  floor?: number;
  points?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const gradientId = useId().replace(/:/g, "");
  const [width, setWidth] = useState(560);
  const [hover, setHover] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(Math.max(240, Math.floor(el.getBoundingClientRect().width)));
    const observer = new ResizeObserver((entries) => setWidth(Math.max(240, Math.floor(entries[0].contentRect.width))));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const view = calm(times, series, points);
  const pad = { l: 2, r: 14, t: 40, b: 8 };
  const w = width - pad.l - pad.r;
  const h = height - pad.t - pad.b;
  const n = view.times.length;
  const present = view.series.flatMap((s) => s.values.filter(nonNull));
  const max = niceMax(Math.max(floor, present.length ? Math.max(...present) * 1.25 : 0));
  const x = (i: number) => pad.l + (n <= 1 ? w : (i / (n - 1)) * w);
  const y = (v: number) => pad.t + h - (v / max) * h;
  const baseline = pad.t + h;
  const active = hover != null && hover < n ? hover : n - 1;
  const activeValues = view.series.map((s) => s.values[active] ?? null);
  const highest = Math.max(...activeValues.filter(nonNull), 0);

  function onMove(e: MouseEvent<SVGSVGElement>) {
    if (n === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const i = Math.round((((e.clientX - rect.left) * (width / rect.width) - pad.l) / Math.max(w, 1)) * (n - 1));
    setHover(Math.min(n - 1, Math.max(0, i)));
  }

  return (
    <div className="chart" ref={ref}>
      <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none"
        onMouseMove={onMove} onMouseLeave={() => setHover(null)} role="img"
        aria-label={`${series.map((s) => s.name).join(" and ")} over time`}>
        <defs>
          {view.series.map((s, i) => (
            <linearGradient key={s.name} id={`${gradientId}-${i}`} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={s.color} stopOpacity={i === 0 ? 0.24 : 0.12} />
              <stop offset="100%" stopColor={s.color} stopOpacity={0} />
            </linearGradient>
          ))}
        </defs>
        {[0, 0.5, 1].map((f) => (
          <line key={f} x1={pad.l} x2={width - pad.r} y1={y(f * max)} y2={y(f * max)} className="grid" />
        ))}
        {view.series.map((s, i) => {
          const run = s.values.map((v, j) => (v == null ? null : ([x(j), y(v)] as [number, number]))).filter((p): p is [number, number] => p !== null);
          if (run.length === 0) return null;
          const line = smooth(run);
          const area = run.length > 1 ? `${line}L${run[run.length - 1][0].toFixed(1)},${baseline}L${run[0][0].toFixed(1)},${baseline}Z` : "";
          return (
            <g key={s.name}>
              {area && <path d={area} fill={`url(#${gradientId}-${i})`} />}
              <path d={line} className="line" style={{ stroke: s.color }} />
            </g>
          );
        })}
        {hover != null && n > 0 && <line x1={x(active)} x2={x(active)} y1={pad.t - 4} y2={baseline} className="crosshair" />}
        {n > 0 && view.series.map((s) => {
          const v = s.values[active];
          if (v == null) return null;
          return (
            <g key={s.name}>
              <circle cx={x(active)} cy={y(v)} r={11} style={{ fill: s.color, opacity: 0.14 }} />
              <circle cx={x(active)} cy={y(v)} r={5.5} className="marker-ring" />
              <circle cx={x(active)} cy={y(v)} r={3.5} style={{ fill: s.color }} />
            </g>
          );
        })}
      </svg>
      {present.length > 0 && n > 0 && activeValues.some(nonNull) && (
        <div className="chart-pill" style={{ left: `${(Math.min(Math.max(x(active), 64), width - 64) / width) * 100}%`, top: y(highest) }}>
          {hover != null && <small>{new Date(view.times[active]).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</small>}
          {view.series.map((s, i) => activeValues[i] == null ? null : (
            <span key={s.name}>{series.length > 1 && <i style={{ background: s.color }} />}{series.length > 1 ? `${s.name} ` : ""}{format(activeValues[i]!)}</span>
          ))}
        </div>
      )}
      {!present.length && <div className="chart-empty">{empty}</div>}
    </div>
  );
}

export function Legend({ series }: { series: Pick<Series, "name" | "color">[] }) {
  return (
    <div className="legend">
      {series.map((s) => <span key={s.name}><i style={{ background: s.color }} />{s.name}</span>)}
    </div>
  );
}

/** A bar chart drawn in dots: each column is a time bucket, lit to its share of the peak. */
export function DotMatrix({ values, columns = 24, rows = 8, color = "#12a189" }: {
  values: (number | null)[];
  columns?: number;
  rows?: number;
  color?: string;
}) {
  const buckets = Array.from({ length: columns }, (_, c) => {
    if (!values.length) return null;
    const start = Math.floor((c * values.length) / columns);
    const end = Math.max(start + 1, Math.floor(((c + 1) * values.length) / columns));
    const slice = values.slice(start, end).filter(nonNull);
    return slice.length ? slice.reduce((a, b) => a + b, 0) / slice.length : null;
  });
  const max = Math.max(0, ...buckets.map((b) => b ?? 0));
  const size = 10;
  const step = 14;
  const width = columns * step - (step - size);
  const height = rows * step - (step - size);
  return (
    <svg className="dotmatrix" viewBox={`0 0 ${width} ${height}`} width="100%" role="img" aria-label="Requests per second over time">
      {buckets.map((b, c) => {
        const level = b == null || max === 0 ? 0 : Math.max(b > 0 ? 1 : 0, Math.round((b / max) * rows));
        return Array.from({ length: rows }, (_, r) => {
          const on = r < level;
          return (
            <rect key={`${c}-${r}`} x={c * step} y={height - size - r * step} width={size} height={size} rx={2.5}
              style={{ fill: on ? color : "#eceef1", opacity: on ? 0.3 + 0.7 * ((r + 1) / level) : 1 }} />
          );
        });
      })}
    </svg>
  );
}

/** One horizontal bar split by share. */
export function StackBar({ segments }: { segments: { label: string; value: number; color: string }[] }) {
  const total = segments.reduce((a, s) => a + s.value, 0);
  return (
    <div className="stackbar" role="img"
      aria-label={segments.map((s) => `${s.label} ${total ? Math.round((s.value / total) * 100) : 0}%`).join(", ")}>
      {total === 0
        ? <span className="stackbar-empty" />
        : segments.filter((s) => s.value > 0).map((s) => (
          <span key={s.label} title={s.label} style={{ flexGrow: s.value, background: s.color }} />
        ))}
    </div>
  );
}

/** A small, calm trend line for tiles and table rows, measured from zero. */
export function Sparkline({ values, color = "#2f6bff", width = 88, height = 30, floor = 0 }: {
  values: (number | null)[];
  color?: string;
  width?: number;
  height?: number;
  floor?: number;
}) {
  const id = useId().replace(/:/g, "");
  const eased = ease(hold(values), 0.22);
  const start = eased.findIndex(nonNull);
  const present = start < 0 ? [] : (eased.slice(start) as number[]);
  if (present.length < 2) return <svg width={width} height={height} aria-hidden="true" />;
  const max = Math.max(floor, ...present) * 1.2 || 1;
  const x = (i: number) => 2 + (i / (present.length - 1)) * (width - 6);
  const y = (v: number) => height - 2 - (v / max) * (height - 6);
  const line = smooth(present.map((v, i) => [x(i), y(v)]));
  const last = present[present.length - 1];
  return (
    <svg width={width} height={height} aria-hidden="true" className="sparkline">
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.22} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={`${line}L${x(present.length - 1)},${height}L${x(0)},${height}Z`} fill={`url(#${id})`} />
      <path d={line} fill="none" stroke={color} strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={x(present.length - 1)} cy={y(last)} r={2.5} fill={color} />
    </svg>
  );
}

/** A trend that fills the corner of a metric card, fading in from the left. */
export function TrendFill({ values, color, floor = 0 }: { values: (number | null)[]; color: string; floor?: number }) {
  const id = useId().replace(/:/g, "");
  const eased = ease(hold(values), 0.18);
  const start = eased.findIndex(nonNull);
  const present = start < 0 ? [] : (eased.slice(start) as number[]);
  if (present.length < 2) return null;
  const max = Math.max(floor, ...present) * 1.25 || 1;
  const W = 200;
  const H = 100;
  const line = smooth(present.map((v, i) => [(i / (present.length - 1)) * W, H - 2 - (v / max) * (H - 8)]));
  return (
    <svg className="trend-fill" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.26} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={`${line}L${W},${H}L0,${H}Z`} fill={`url(#${id})`} />
      <path d={line} fill="none" stroke={color} strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
