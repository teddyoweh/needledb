import { type MouseEvent, useId, useLayoutEffect, useRef, useState } from "react";

export type Series = { name: string; color: string; values: (number | null)[] };

function niceMax(v: number) {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const m = v / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
}

/** Monotone cubic curve through the points (no overshoot), split where values are missing. */
function smooth(points: [number, number][]): string {
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

function runs(values: (number | null)[], x: (i: number) => number, y: (v: number) => number) {
  const out: [number, number][][] = [];
  let current: [number, number][] = [];
  values.forEach((v, i) => {
    if (v == null) {
      if (current.length) out.push(current);
      current = [];
    } else {
      current.push([x(i), y(v)]);
    }
  });
  if (current.length) out.push(current);
  return out;
}

/** A live area chart: one y-axis, soft fill, crosshair tooltip. */
export function AreaChart({ times, series, format, height = 210, empty = "Waiting for traffic" }: {
  times: number[];
  series: Series[];
  format: (v: number) => string;
  height?: number;
  empty?: string;
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

  const pad = { l: 52, r: 6, t: 12, b: 24 };
  const w = width - pad.l - pad.r;
  const h = height - pad.t - pad.b;
  const n = times.length;
  const present = series.flatMap((s) => s.values.filter((v): v is number => v != null));
  const max = niceMax(present.length ? Math.max(...present) * 1.1 : 0);
  const x = (i: number) => pad.l + (n <= 1 ? w : (i / (n - 1)) * w);
  const y = (v: number) => pad.t + h - (v / max) * h;
  const span = n > 1 ? Math.round((times[n - 1] - times[0]) / 1000) : 0;

  function onMove(e: MouseEvent<SVGSVGElement>) {
    if (n === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const scale = width / rect.width;
    const i = Math.round((((e.clientX - rect.left) * scale - pad.l) / Math.max(w, 1)) * (n - 1));
    setHover(Math.min(n - 1, Math.max(0, i)));
  }

  return (
    <div className="chart" ref={ref}>
      <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none"
        onMouseMove={onMove} onMouseLeave={() => setHover(null)} role="img"
        aria-label={`${series.map((s) => s.name).join(" and ")} over the last ${span} seconds`}>
        <defs>
          {series.map((s, i) => (
            <linearGradient key={s.name} id={`${gradientId}-${i}`} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={s.color} stopOpacity={i === 0 ? 0.16 : 0.08} />
              <stop offset="100%" stopColor={s.color} stopOpacity={0} />
            </linearGradient>
          ))}
        </defs>
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={pad.l} x2={width - pad.r} y1={y(f * max)} y2={y(f * max)} className="grid" />
            <text x={pad.l - 10} y={y(f * max)} className="axis" textAnchor="end" dominantBaseline="middle">{format(f * max)}</text>
          </g>
        ))}
        {span > 0 && <text x={pad.l} y={height - 4} className="axis">{span >= 120 ? `${Math.round(span / 60)} min ago` : `${span}s ago`}</text>}
        <text x={width - pad.r} y={height - 4} className="axis" textAnchor="end">now</text>
        {series.map((s, i) =>
          runs(s.values, x, y).map((run, r) => {
            const line = smooth(run);
            const area = run.length > 1 ? `${line}L${run[run.length - 1][0].toFixed(1)},${pad.t + h}L${run[0][0].toFixed(1)},${pad.t + h}Z` : "";
            return (
              <g key={`${s.name}-${r}`}>
                {area && <path d={area} fill={`url(#${gradientId}-${i})`} />}
                <path d={line} className="line" style={{ stroke: s.color }} />
              </g>
            );
          }),
        )}
        {hover != null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={pad.t + h} className="crosshair" />
            {series.map((s) => {
              const v = s.values[hover];
              return v == null ? null : <circle key={s.name} cx={x(hover)} cy={y(v)} r={4.5} style={{ fill: s.color }} className="point" />;
            })}
          </g>
        )}
      </svg>
      {hover != null && (
        <div className="tooltip" style={{ left: `${(Math.min(x(hover) + 14, width - 170) / width) * 100}%`, top: 8 }}>
          <div className="tooltip-time">{new Date(times[hover]).toLocaleTimeString()}</div>
          {series.map((s) => {
            const v = s.values[hover];
            return (
              <div key={s.name} className="tooltip-row"><i style={{ background: s.color }} />{s.name}<b>{v == null ? "—" : format(v)}</b></div>
            );
          })}
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
    const slice = values.slice(start, end).filter((v): v is number => v != null);
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

/** A tiny trend line for stat tiles and cards. */
export function Sparkline({ values, color = "#0071e3", width = 88, height = 30 }: {
  values: (number | null)[];
  color?: string;
  width?: number;
  height?: number;
}) {
  const id = useId().replace(/:/g, "");
  const present = values.filter((v): v is number => v != null);
  if (present.length < 2) return <svg width={width} height={height} aria-hidden="true" />;
  const max = Math.max(...present);
  const min = Math.min(...present);
  const range = max - min || 1;
  const x = (i: number) => (i / (values.length - 1)) * (width - 2) + 1;
  const y = (v: number) => height - 3 - ((v - min) / range) * (height - 6);
  const line = runs(values, x, y).map(smooth).join("");
  const last = present[present.length - 1];
  return (
    <svg width={width} height={height} aria-hidden="true" className="sparkline">
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.2} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={`${line}L${width - 1},${height}L1,${height}Z`} fill={`url(#${id})`} />
      <path d={line} fill="none" stroke={color} strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={x(values.length - 1)} cy={y(last)} r={2.5} fill={color} />
    </svg>
  );
}
