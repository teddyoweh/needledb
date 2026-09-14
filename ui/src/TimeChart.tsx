import { type MouseEvent, useLayoutEffect, useRef, useState } from "react";

export type Series = { name: string; color: string; values: (number | null)[] };

function niceMax(v: number) {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const m = v / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
}

/** A small live line chart: one y-axis, recessive grid, crosshair tooltip. */
export function TimeChart({ times, series, format, height = 176, empty = "No traffic yet" }: {
  times: number[];
  series: Series[];
  format: (v: number) => string;
  height?: number;
  empty?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(560);
  const [hover, setHover] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => setWidth(Math.max(240, Math.floor(entries[0].contentRect.width))));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const pad = { l: 60, r: 10, t: 10, b: 22 };
  const w = width - pad.l - pad.r;
  const h = height - pad.t - pad.b;
  const n = times.length;
  const present = series.flatMap((s) => s.values.filter((v): v is number => v != null));
  const max = niceMax(present.length ? Math.max(...present) : 0);
  const x = (i: number) => pad.l + (n <= 1 ? w : (i / (n - 1)) * w);
  const y = (v: number) => pad.t + h - (v / max) * h;
  const ticks = [0, max / 2, max];
  const spanSeconds = n > 1 ? Math.round((times[n - 1] - times[0]) / 1000) : 0;

  function path(values: (number | null)[]) {
    let d = "";
    let pen = false;
    values.forEach((v, i) => {
      if (v == null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  }

  function onMove(e: MouseEvent<SVGSVGElement>) {
    if (n === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const i = Math.round(((e.clientX - rect.left - pad.l) / Math.max(w, 1)) * (n - 1));
    setHover(Math.min(n - 1, Math.max(0, i)));
  }

  return (
    <div className="chart" ref={ref}>
      <div className="legend">
        {series.map((s) => (
          <span key={s.name}><i style={{ background: s.color }} />{s.name}</span>
        ))}
      </div>
      <svg width={width} height={height} onMouseMove={onMove} onMouseLeave={() => setHover(null)}
        role="img" aria-label={`${series.map((s) => s.name).join(" and ")} over time`}>
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} className="grid" />
            <text x={pad.l - 8} y={y(t)} className="axis" textAnchor="end" dominantBaseline="middle">{format(t)}</text>
          </g>
        ))}
        {spanSeconds > 0 && <text x={pad.l} y={height - 5} className="axis">{spanSeconds}s ago</text>}
        <text x={width - pad.r} y={height - 5} className="axis" textAnchor="end">now</text>
        {series.map((s) => (
          <path key={s.name} d={path(s.values)} style={{ stroke: s.color }} className="line" />
        ))}
        {hover != null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={pad.t + h} className="crosshair" />
            {series.map((s) => {
              const v = s.values[hover];
              return v == null ? null : <circle key={s.name} cx={x(hover)} cy={y(v)} r={4} style={{ fill: s.color }} className="dot" />;
            })}
          </g>
        )}
      </svg>
      {hover != null && (
        <div className="tooltip" style={{ left: Math.min(x(hover) + 12, width - 160), top: 30 }}>
          {series.map((s) => {
            const v = s.values[hover];
            return (
              <div key={s.name}><i style={{ background: s.color }} />{s.name}<b>{v == null ? "—" : format(v)}</b></div>
            );
          })}
          <div className="muted">{new Date(times[hover]).toLocaleTimeString()}</div>
        </div>
      )}
      {!present.length && <div className="chart-empty">{empty}</div>}
    </div>
  );
}
