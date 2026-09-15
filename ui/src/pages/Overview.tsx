import { useEffect, useState } from "react";
import { api, type AuditEvent } from "../api";
import { AreaChart, DotMatrix, Legend, Sparkline, StackBar, TrendFill } from "../charts";
import { IconActivity, IconArrowRight, IconBolt, IconCheck, IconChevronsUpDown, IconChip, IconClock, IconIndexes, IconPlus, IconSearch, IconShield } from "../icons";
import { colorFor, fmtBytes, fmtCompact, fmtDuration, fmtInt, fmtMs, go, structureLabel, usePoll } from "../lib";
import { useSession } from "../session";
import { Badge, Button, Card, Delta, Empty, ErrorNote, IndexAvatar, Menu, MenuItem, PageHeader, Skeleton } from "../ui";
import { ActivityFeed } from "./Activity";

const TEAL = "#12a189";
const BLUE = "#2f6bff";
const ORANGE = "#f08a24";
const VIOLET = "#8b5cf6";
const RANGES = { "1m": 30, "5m": 150, "15m": 450 } as const;
const RANGE_LABEL: Record<Range, string> = { "1m": "Last minute", "5m": "Last 5 minutes", "15m": "Last 15 minutes" };
type Range = keyof typeof RANGES;
type Sample = { t: number; qps: number; p50: number | null; p99: number | null; memory: number; perIndex: Record<string, number> };

const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const rate = (v: number) => `${v.toFixed(v < 1 ? 2 : v < 10 ? 1 : 0)} req/s`;

function mean(values: (number | null)[]) {
  const v = values.filter((x): x is number => x != null);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

/** Percent change between the last ~10 s and the same span a minute earlier. */
function change(history: Sample[], pick: (s: Sample) => number | null) {
  if (history.length < 36) return null;
  const now = mean(history.slice(-5).map(pick));
  const then = mean(history.slice(-35, -30).map(pick));
  if (now == null || then == null || then === 0) return null;
  return ((now - then) / then) * 100;
}

/** A metric card: label, value, and a trend filling its corner. */
function Metric({ label, hint, value, delta, invert, note, trend, color, floor }: {
  label: string;
  hint: string;
  value: string;
  delta?: number | null;
  invert?: boolean;
  note: string;
  trend: (number | null)[];
  color: string;
  floor?: number;
}) {
  return (
    <div className="metric">
      <div className="metric-head">
        <span className="metric-label">{label}</span>
        <span className="metric-hint">{hint}</span>
      </div>
      <div className="metric-value">{value}</div>
      <div className="metric-foot">
        {delta != null ? <Delta value={delta} invert={invert} suffix="vs 1 min ago" /> : note}
      </div>
      <TrendFill values={trend} color={color} floor={floor} />
    </div>
  );
}

export default function Overview() {
  const { can } = useSession();
  const admin = can("admin");
  const { data: stats, error } = usePoll(api.stats, 2000);
  const feed = usePoll(() => (admin ? api.events(6) : Promise.resolve({ events: [] as AuditEvent[] })), 15000, [admin]);
  const [history, setHistory] = useState<Sample[]>([]);
  const [range, setRange] = useState<Range>("5m");
  const [metric, setMetric] = useState<"requests" | "latency">("requests");
  const [filter, setFilter] = useState("");

  useEffect(() => {
    if (!stats) return;
    const r = stats.requests;
    setHistory((h) => [...h.slice(-449), {
      t: Date.now(), qps: r.all.qps, p50: r.all.p50Ms, p99: r.all.p99Ms, memory: stats.totals.memoryBytes,
      perIndex: Object.fromEntries(Object.entries(r.indexes).map(([k, v]) => [k, v.qps])),
    }]);
  }, [stats]);

  if (!stats) {
    return (
      <>
        <PageHeader title="Overview" subtitle="Connecting to live metrics…" />
        {error ? <ErrorNote error={error} /> : (
          <div className="overview-top"><Skeleton height={184} radius={16} /><Skeleton height={184} radius={16} /></div>
        )}
      </>
    );
  }

  const { requests: r, totals: t } = stats;
  const visible = history.slice(-RANGES[range]);
  const padded = [...Array<null>(Math.max(0, RANGES[range] - visible.length)).fill(null), ...visible.map((s) => s.qps)];
  const times = visible.map((s) => s.t);
  const shown = stats.indexes.filter((i) => i.name.includes(filter.trim().toLowerCase()));
  const memoryTotal = stats.indexes.reduce((a, i) => a + i.memoryBytes, 0);
  const routes = Object.entries(r.routes).sort((a, b) => b[1].count - a[1].count);
  const pick = metric === "requests" ? (s: Sample) => s.qps : (s: Sample) => s.p99;
  const windowValues = visible.map(pick).filter((v): v is number => v != null);
  const average = mean(windowValues);
  const peak = windowValues.length ? Math.max(...windowValues) : null;
  const show = (v: number | null) => (v == null ? "—" : metric === "requests" ? rate(v) : fmtMs(v));

  return (
    <>
      <PageHeader
        title="Overview"
        subtitle={`Live view of this server · up ${fmtDuration(r.uptimeSeconds)}`}
        actions={<>
          <span className="live"><i />Live</span>
          {admin && <Button variant="primary" icon={<IconPlus size={16} />} onClick={() => go("/indexes?new=1")}>New index</Button>}
        </>}
      />

      <div className="overview-top">
        <div className="hero">
          <div className="hero-label"><IconIndexes size={16} />Vectors stored</div>
          <div className="hero-value">{fmtInt(t.vectors)}</div>
          <div className="hero-foot">
            <span>{t.indexes} {t.indexes === 1 ? "index" : "indexes"} · {fmtBytes(t.storageBytes)} on disk</span>
            <a href="#/indexes">View indexes <IconArrowRight size={14} /></a>
          </div>
        </div>
        <div className="metrics">
          <Metric label="Requests" hint="Per second, all routes" value={r.all.qps.toFixed(r.all.qps < 10 ? 1 : 0)}
            delta={change(history, (s) => s.qps)} note={`${fmtInt(r.all.count)} in the last minute`}
            trend={visible.map((s) => s.qps)} color={TEAL} floor={1} />
          <Metric label="p50 latency" hint="Median request" value={fmtMs(r.all.p50Ms)}
            delta={change(history, (s) => s.p50)} invert note="Half of requests are faster"
            trend={visible.map((s) => s.p50)} color={BLUE} floor={1} />
          <Metric label="p99 latency" hint="Slowest 1% of requests" value={fmtMs(r.all.p99Ms)}
            delta={change(history, (s) => s.p99)} invert note="Tail latency"
            trend={visible.map((s) => s.p99)} color={ORANGE} floor={5} />
          <Metric label="Index memory" hint="Vectors and graph links" value={fmtBytes(t.memoryBytes)}
            note={`Server process ${fmtBytes(stats.process.rssBytes)}`}
            trend={visible.map((s) => s.memory)} color={VIOLET} />
        </div>
      </div>

      <div className="overview-grid">
        <Card className="span-2" icon={<IconActivity size={16} />} title={metric === "requests" ? "Throughput" : "Latency"}
          subtitle={metric === "requests" ? "Requests per second across every route" : "Median and tail latency across every route"}
          actions={<>
            <div className="chart-switch" role="tablist" aria-label="Metric">
              {(["requests", "latency"] as const).map((m) => (
                <button key={m} type="button" role="tab" aria-selected={metric === m} className={metric === m ? "on" : ""}
                  onClick={() => setMetric(m)}>{m === "requests" ? "Requests" : "Latency"}</button>
              ))}
            </div>
            <Menu align="end" trigger={({ open, toggle }) => (
              <button type="button" className="range-button" onClick={toggle} aria-haspopup="menu" aria-expanded={open}>
                <IconClock size={15} />{RANGE_LABEL[range]}<IconChevronsUpDown size={13} />
              </button>
            )}>
              {(close) => (
                <>
                  {(Object.keys(RANGES) as Range[]).map((k) => (
                    <MenuItem key={k} icon={k === range ? <IconCheck size={16} /> : <span className="menu-spacer" />}
                      onClick={() => { setRange(k); close(); }}>{RANGE_LABEL[k]}</MenuItem>
                  ))}
                </>
              )}
            </Menu>
          </>}>
          <div className="chart-head">
            <div>
              <span className="chart-figure">{metric === "requests" ? rate(r.all.qps) : fmtMs(r.all.p99Ms)}</span>
              <span className="chart-unit">{metric === "requests" ? "right now" : "p99 right now"}</span>
            </div>
            {metric === "latency" && <Legend series={[{ name: "p50", color: BLUE }, { name: "p99", color: ORANGE }]} />}
          </div>
          {metric === "requests" ? (
            <AreaChart times={times} height={240} format={rate} floor={1}
              series={[{ name: "Requests/s", color: TEAL, values: visible.map((s) => s.qps) }]} />
          ) : (
            <AreaChart times={times} height={240} format={fmtMs} floor={5}
              series={[
                { name: "p50", color: BLUE, values: visible.map((s) => s.p50) },
                { name: "p99", color: ORANGE, values: visible.map((s) => s.p99) },
              ]} />
          )}
          <div className="chart-foot">
            <div><span>Average{metric === "latency" ? " p99" : ""}</span><b>{show(average)}</b></div>
            <div><span>Peak{metric === "latency" ? " p99" : ""}</span><b>{show(peak)}</b></div>
            <div className="end"><span>Window</span><b>{times.length ? `${clock(times[0])} – ${clock(times[times.length - 1])}` : "—"}</b></div>
          </div>
        </Card>

        <Card icon={<IconBolt size={16} />} title="Request activity" subtitle={`Requests per second, last ${range}`}>
          <div className="chart-head">
            <div>
              <span className="chart-figure">{fmtInt(r.all.count)}</span>
              <span className="chart-unit">requests in the last minute</span>
            </div>
          </div>
          <DotMatrix values={padded} columns={22} rows={10} color={TEAL} />
          <div className="matrix-axis"><span>{range} ago</span><span>now</span></div>
        </Card>

        <Card className="span-2" icon={<IconIndexes size={16} />} title="Indexes" subtitle={`${stats.indexes.length} on this server`} flush
          actions={stats.indexes.length > 0 && (
            <div className="search-field">
              <IconSearch size={15} />
              <input aria-label="Filter indexes" placeholder="Filter indexes" value={filter} onChange={(e) => setFilter(e.target.value)} />
            </div>
          )}>
          {stats.indexes.length === 0 ? (
            <Empty icon={<IconIndexes size={24} />} title="No indexes yet"
              action={admin && <Button variant="primary" icon={<IconPlus size={16} />} onClick={() => go("/indexes?new=1")}>Create an index</Button>}>
              Create an index for your embeddings, then upsert from the SDK or this app.
            </Empty>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr><th>Index</th><th className="num">Vectors</th><th className="num">Memory</th><th className="num">QPS</th><th className="num">p99</th><th>Trend</th><th>Status</th></tr>
                </thead>
                <tbody>
                  {shown.map((i) => {
                    const traffic = r.indexes[i.name];
                    return (
                      <tr key={i.name} className="rowlink" onClick={() => go(`/indexes/${encodeURIComponent(i.name)}`)}>
                        <td>
                          <div className="entity">
                            <IndexAvatar name={i.name} />
                            <div><b>{i.name}</b><span>{i.dimension}-d · {i.metric} · {structureLabel(i)}</span></div>
                          </div>
                        </td>
                        <td className="num">{fmtInt(i.vectorCount)}</td>
                        <td className="num">{fmtBytes(i.memoryBytes)}</td>
                        <td className="num">{(traffic?.qps ?? 0).toFixed(1)}</td>
                        <td className="num">{fmtMs(traffic?.p99Ms)}</td>
                        <td><Sparkline values={visible.map((s) => s.perIndex[i.name] ?? 0)} color={colorFor(i.name)} width={96} height={28} /></td>
                        <td><Badge tone={i.status.state === "Ready" ? "good" : "warn"}>{i.status.state === "Ready" ? "Ready" : "Rebuilding"}</Badge></td>
                      </tr>
                    );
                  })}
                  {shown.length === 0 && <tr><td colSpan={7} className="table-empty">No indexes match “{filter}”.</td></tr>}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card icon={<IconChip size={16} />} title="Memory by index" subtitle={`${fmtBytes(memoryTotal)} of vectors and graph links`}>
          {memoryTotal > 0 ? (
            <>
              <StackBar segments={stats.indexes.map((i) => ({ label: i.name, value: i.memoryBytes, color: colorFor(i.name) }))} />
              <ul className="breakdown">
                {[...stats.indexes].sort((a, b) => b.memoryBytes - a.memoryBytes).map((i) => (
                  <li key={i.name}>
                    <span className="swatch" style={{ background: colorFor(i.name) }} />
                    <span className="breakdown-name">{i.name}</span>
                    <span className="breakdown-meta">{fmtCompact(i.vectorCount)} vectors</span>
                    <b>{fmtBytes(i.memoryBytes)}</b>
                    <span className="breakdown-pct">{Math.round((i.memoryBytes / memoryTotal) * 100)}%</span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <Empty icon={<IconChip size={22} />} title="Nothing in memory yet">Upsert vectors and each index's share appears here.</Empty>
          )}
        </Card>

        {admin && (
          <Card icon={<IconShield size={16} />} title="Recent activity" actions={<a className="link small" href="#/security">View all</a>} flush>
            <ActivityFeed events={feed.data?.events} />
          </Card>
        )}

        <Card className={admin ? "span-2" : "span-3"} icon={<IconActivity size={16} />} title="API routes"
          subtitle={r.errors ? `${r.errors} server errors in the last minute` : "Last 60 seconds"} flush>
          {routes.length ? (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr><th>Route</th><th className="num">Requests</th><th className="num">QPS</th><th className="num">p50</th><th className="num">p95</th><th className="num">p99</th></tr>
                </thead>
                <tbody>
                  {routes.map(([route, x]) => (
                    <tr key={route}>
                      <td><span className="route">{route}</span></td>
                      <td className="num">{fmtInt(x.count)}</td>
                      <td className="num">{x.qps.toFixed(1)}</td>
                      <td className="num">{fmtMs(x.p50Ms)}</td>
                      <td className="num">{fmtMs(x.p95Ms)}</td>
                      <td className="num">{fmtMs(x.p99Ms)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty icon={<IconActivity size={22} />} title="Quiet for the last minute">
              Requests from the SDK, the Pinecone client or this app appear here with live percentiles.
            </Empty>
          )}
        </Card>
      </div>
    </>
  );
}
