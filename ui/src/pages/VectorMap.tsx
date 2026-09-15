import { type PointerEvent, type WheelEvent, useEffect, useMemo, useRef, useState } from "react";
import { api, type IndexInfo, type MapPoint, type Match, type VectorMap as MapData } from "../api";
import { IconSparkles, IconTarget, IconX } from "../icons";
import { PALETTE, fmtInt, titleOf } from "../lib";
import { Button, Empty, ErrorNote, IconButton, NamespaceSelect, Segmented, Skeleton } from "../ui";

type View = { scale: number; tx: number; ty: number };
const RESET: View = { scale: 1, tx: 0, ty: 0 };
const SAMPLES = { "500": 500, "1500": 1500, "3000": 3000 } as const;
type Sample = keyof typeof SAMPLES;
const UNSET = "Not set";

function rgba(hex: string, alpha: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/**
 * The explorer: every sampled vector as a point, laid out by its two strongest directions.
 * Colour by k-means group or any low-cardinality metadata field. Hover for a record, click
 * to thread its nearest neighbours, scroll to zoom, drag to pan. `compact` is the preview.
 */
export default function VectorMap({ info, namespaces, compact = false, onSimilar, onOpen }: {
  info: IndexInfo;
  namespaces: string[];
  compact?: boolean;
  onSimilar?: (id: string, namespace: string) => void;
  onOpen?: () => void;
}) {
  const [namespace, setNamespace] = useState(namespaces.includes("") || !namespaces.length ? "" : namespaces[0]);
  const [sample, setSample] = useState<Sample>(compact ? "500" : "1500");
  const [colorBy, setColorBy] = useState<string | null>(null);
  const [fields, setFields] = useState<string[]>([]);
  const [data, setData] = useState<MapData>();
  const [error, setError] = useState<string>();
  const [view, setView] = useState<View>(RESET);
  const [hover, setHover] = useState<number | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [neighbours, setNeighbours] = useState<Match[]>();
  const [isolated, setIsolated] = useState<string | null>(null);
  const [size, setSize] = useState({ width: 800, height: compact ? 300 : 560 });

  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ x: number; y: number; view: View; moved: boolean } | null>(null);
  const reveal = useRef(0);

  useEffect(() => {
    let cancelled = false;
    setError(undefined);
    setSelected(null);
    setNeighbours(undefined);
    setIsolated(null);
    api.vectorMap(info.name, namespace, SAMPLES[sample], colorBy)
      .then((result) => {
        if (cancelled) return;
        if (!data || data.namespace !== result.namespace || data.sampled !== result.sampled) {
          reveal.current = performance.now();
          setView(RESET);
        }
        setData(result);
        if (result.colorFields.length) setFields(result.colorFields);
      })
      .catch((err) => !cancelled && setError((err as Error).message));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info.name, namespace, sample, colorBy]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const width = Math.max(280, Math.floor(entry.contentRect.width));
      setSize({ width, height: compact ? 300 : Math.max(440, Math.min(660, Math.floor(width * 0.6))) });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [compact]);

  const points = data?.points ?? [];
  const keyOf = (p: MapPoint) => (colorBy ? p.group ?? UNSET : `Group ${p.cluster + 1}`);
  const legend = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of points) counts.set(keyOf(p), (counts.get(keyOf(p)) ?? 0) + 1);
    const entries = [...counts.entries()];
    return colorBy ? entries.sort((a, b) => b[1] - a[1]) : entries.sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, colorBy]);
  const colours = useMemo(
    () => new Map(legend.map(([k], i) => [k, k === UNSET ? "#c3c4cb" : PALETTE[i % PALETTE.length]])),
    [legend],
  );
  const colourOf = (p: MapPoint) => colours.get(keyOf(p)) ?? "#c3c4cb";
  const byId = useMemo(() => new Map(points.map((p, i) => [p.id, i])), [points]);
  const neighbourIdx = useMemo(
    () => (neighbours ?? []).map((m) => byId.get(m.id)).filter((i): i is number => i !== undefined && i !== selected),
    [neighbours, byId, selected],
  );

  const pad = compact ? 22 : 36;
  const toScreen = (x: number, y: number): [number, number] => {
    const half = Math.min(size.width, size.height) / 2 - pad;
    const stretch = (size.width / Math.min(size.width, size.height)) * 0.92;
    return [size.width / 2 + view.tx + x * half * view.scale * stretch, size.height / 2 + view.ty - y * half * view.scale];
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let frame = 0;

    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(size.width * dpr);
      canvas.height = Math.round(size.height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size.width, size.height);
      ctx.fillStyle = "#e3e3e9";
      for (let gx = 12; gx < size.width; gx += 24) for (let gy = 12; gy < size.height; gy += 24) ctx.fillRect(gx, gy, 1.2, 1.2);

      const t = still ? 1 : Math.min(1, (performance.now() - reveal.current) / 700);
      const ease = 1 - Math.pow(1 - t, 3);
      const near = new Set(neighbourIdx);
      const focus = selected !== null || isolated !== null;

      if (selected !== null && points[selected]) {
        const [sx, sy] = toScreen(points[selected].x, points[selected].y);
        neighbourIdx.forEach((i, rank) => {
          const [nx, ny] = toScreen(points[i].x, points[i].y);
          ctx.strokeStyle = `rgba(47, 107, 255, ${0.55 - rank * 0.03})`;
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.moveTo(sx, sy);
          ctx.lineTo(nx, ny);
          ctx.stroke();
        });
      }

      const radius = compact ? 2.3 : 2.9;
      points.forEach((p, i) => {
        if (i === selected || near.has(i)) return;
        const [x, y] = toScreen(p.x * ease, p.y * ease);
        const lit = !focus || (selected === null && isolated !== null && keyOf(p) === isolated);
        ctx.fillStyle = rgba(colourOf(p), lit ? 0.8 : 0.14);
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fill();
      });

      neighbourIdx.forEach((i) => {
        const [x, y] = toScreen(points[i].x, points[i].y);
        ctx.fillStyle = "#fff";
        ctx.beginPath();
        ctx.arc(x, y, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = colourOf(points[i]);
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.fill();
      });

      for (const i of [selected, hover]) {
        if (i === null || !points[i]) continue;
        const [x, y] = toScreen(points[i].x * ease, points[i].y * ease);
        ctx.fillStyle = i === selected ? "rgba(47, 107, 255, 0.16)" : "rgba(17, 17, 20, 0.08)";
        ctx.beginPath();
        ctx.arc(x, y, 14, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#fff";
        ctx.beginPath();
        ctx.arc(x, y, 7, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = i === selected ? "#2f6bff" : colourOf(points[i]);
        ctx.beginPath();
        ctx.arc(x, y, 5, 0, Math.PI * 2);
        ctx.fill();
      }
      if (t < 1) frame = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, size, view, hover, selected, neighbourIdx, isolated, colours, compact]);

  function nearest(clientX: number, clientY: number) {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const mx = clientX - rect.left;
    const my = clientY - rect.top;
    let best: number | null = null;
    let bestDist = 144;
    points.forEach((p, i) => {
      const [x, y] = toScreen(p.x, p.y);
      const d = (x - mx) ** 2 + (y - my) ** 2;
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    });
    return best;
  }

  async function select(i: number | null) {
    setSelected(i);
    setNeighbours(undefined);
    if (i === null) return;
    try {
      const res = await api.query(info.name, { id: points[i].id, topK: 12, namespace, includeMetadata: true });
      setNeighbours(res.matches.filter((m) => m.id !== points[i].id));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function onPointerDown(e: PointerEvent<HTMLCanvasElement>) {
    if (compact) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, view, moved: false };
  }

  function onPointerMove(e: PointerEvent<HTMLCanvasElement>) {
    const d = drag.current;
    if (d) {
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
      if (d.moved) {
        setView({ ...d.view, tx: d.view.tx + dx, ty: d.view.ty + dy });
        return;
      }
    }
    setHover(nearest(e.clientX, e.clientY));
  }

  function onPointerUp(e: PointerEvent<HTMLCanvasElement>) {
    const d = drag.current;
    drag.current = null;
    if (compact) {
      onOpen?.();
      return;
    }
    if (d && !d.moved) void select(nearest(e.clientX, e.clientY));
  }

  function onWheel(e: WheelEvent<HTMLCanvasElement>) {
    if (compact) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left - size.width / 2;
    const my = e.clientY - rect.top - size.height / 2;
    const factor = Math.exp(-e.deltaY * 0.0015);
    setView((v) => {
      const scale = Math.min(14, Math.max(0.6, v.scale * factor));
      const k = scale / v.scale;
      return { scale, tx: mx - (mx - v.tx) * k, ty: my - (my - v.ty) * k };
    });
  }

  const hovered = hover !== null ? points[hover] : undefined;
  const hoverPos = hovered ? toScreen(hovered.x, hovered.y) : null;
  const chosen = selected !== null ? points[selected] : undefined;
  const explained = data ? Math.round((data.explained[0] + data.explained[1]) * 100) : 0;

  const canvas = (
    <div className={`map-canvas ${compact ? "compact" : ""}`} ref={wrapRef} style={{ height: size.height }}>
      <canvas ref={canvasRef} style={{ width: size.width, height: size.height }}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
        onPointerLeave={() => { setHover(null); drag.current = null; }}
        onWheel={onWheel} onDoubleClick={() => setView(RESET)}
        role="img" aria-label={`Map of ${data?.sampled ?? 0} vectors in ${info.name}`} />
      {hovered && hoverPos && (
        <div className="map-tip" style={{ left: Math.min(hoverPos[0] + 14, size.width - 260), top: Math.max(8, hoverPos[1] - 58) }}>
          <i style={{ background: colourOf(hovered) }} />
          <div>
            <b>{hovered.label ?? hovered.id}</b>
            <span>{hovered.label ? `${hovered.id} · ` : ""}{keyOf(hovered)}</span>
          </div>
        </div>
      )}
      {!data && !error && <div className="map-overlay"><Skeleton height="100%" radius={14} /></div>}
      {data && data.total === 0 && (
        <div className="map-overlay">
          <Empty icon={<IconTarget size={22} />} title="Nothing to map yet">Upsert vectors and they appear here, grouped by similarity.</Empty>
        </div>
      )}
    </div>
  );

  if (compact) {
    return (
      <div className="map-compact">
        {canvas}
        {data && data.total > 0 && (
          <div className="map-caption">
            <span>{fmtInt(data.sampled)} of {fmtInt(data.total)} vectors · {legend.length} groups</span>
            <span className="map-legend-mini">{legend.map(([k]) => <i key={k} style={{ background: colours.get(k) }} title={k} />)}</span>
          </div>
        )}
        <ErrorNote error={error} />
      </div>
    );
  }

  return (
    <div className="explorer">
      <div className="explorer-main">
        <div className="explorer-toolbar">
          <NamespaceSelect id="map-ns" value={namespace} namespaces={namespaces} onChange={setNamespace} />
          <select aria-label="Colour points by" value={colorBy ?? ""} onChange={(e) => setColorBy(e.target.value || null)}>
            <option value="">Colour: similarity groups</option>
            {fields.map((f) => <option key={f} value={f}>Colour: {f}</option>)}
          </select>
          <Segmented label="Sample size" value={sample} onChange={setSample} options={[
            { value: "500", label: "500" }, { value: "1500", label: "1.5k" }, { value: "3000", label: "3k" },
          ]} />
          <span className="explorer-meta">
            {data ? `${fmtInt(data.sampled)} of ${fmtInt(data.total)} vectors · axes explain ${explained}% of the spread` : "Projecting…"}
          </span>
          <Button size="sm" onClick={() => setView(RESET)}>Reset view</Button>
        </div>
        <ErrorNote error={error} />
        {canvas}
        <div className="explorer-hint">Scroll to zoom · drag to pan · click a point to thread its nearest neighbours · double-click to reset</div>
      </div>

      <aside className="explorer-side">
        {chosen ? (
          <>
            <div className="explorer-side-head">
              <span className="swatch" style={{ background: colourOf(chosen) }} />
              <span className="explorer-kicker">{keyOf(chosen)}</span>
              <IconButton label="Clear selection" onClick={() => void select(null)}><IconX size={16} /></IconButton>
            </div>
            <h3 className="explorer-title">{chosen.label ?? chosen.id}</h3>
            <div className="explorer-id">{chosen.id}</div>
            {onSimilar && (
              <Button variant="primary" block icon={<IconSparkles size={16} />} onClick={() => onSimilar(chosen.id, namespace)}>
                Open in query
              </Button>
            )}
            <div className="explorer-section">Nearest neighbours</div>
            {!neighbours ? (
              <div className="stack tight">{[0, 1, 2, 3].map((i) => <Skeleton key={i} height={38} radius={9} />)}</div>
            ) : (
              <ol className="neighbours">
                {neighbours.map((m, rank) => {
                  const idx = byId.get(m.id);
                  const title = titleOf(m.metadata);
                  return (
                    <li key={m.id}>
                      <button type="button" disabled={idx === undefined} onClick={() => idx !== undefined && void select(idx)}
                        title={idx === undefined ? "Outside this sample" : "Select on the map"}>
                        <span className="neighbour-rank">{rank + 1}</span>
                        <span className="neighbour-text"><b>{title?.text ?? m.id}</b>{title && <span>{m.id}</span>}</span>
                        <span className="neighbour-score">{m.score?.toFixed(3)}</span>
                      </button>
                    </li>
                  );
                })}
              </ol>
            )}
          </>
        ) : (
          <>
            <div className="explorer-section first">{colorBy ? `By ${colorBy}` : "Similarity groups"}</div>
            <p className="explorer-note">
              {colorBy
                ? `Each colour is a value of “${colorBy}”. Click one to isolate it.`
                : "Colours come from clustering the sample. Click a group to isolate it, or a point to explore its neighbourhood."}
            </p>
            <ul className="groups">
              {legend.map(([k, count]) => (
                <li key={k}>
                  <button type="button" className={isolated === k ? "on" : ""} onClick={() => setIsolated((g) => (g === k ? null : k))}>
                    <span className="swatch" style={{ background: colours.get(k) }} />
                    <span className="group-name">{k}</span>
                    <span className="group-bar"><i style={{ width: `${(count / Math.max(1, points.length)) * 100}%`, background: colours.get(k) }} /></span>
                    <span className="group-count">{fmtInt(count)}</span>
                  </button>
                </li>
              ))}
              {!legend.length && <li className="muted small">No points yet.</li>}
            </ul>
          </>
        )}
      </aside>
    </div>
  );
}
