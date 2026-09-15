import { useEffect, useState } from "react";
import { api, type AuditEvent } from "../api";
import { AreaChart, DotMatrix, Legend, Sparkline, StackBar } from "../charts";
import { IconActivity, IconArrowRight, IconBolt, IconChip, IconIndexes, IconPlus, IconSearch, IconShield } from "../icons";
import { colorFor, fmtBytes, fmtCompact, fmtDuration, fmtInt, fmtMs, go, structureLabel, usePoll } from "../lib";
import { useSession } from "../session";
import { Badge, Button, Card, Delta, Empty, ErrorNote, IndexAvatar, PageHeader, Segmented, Skeleton } from "../ui";
import { ActivityFeed } from "./Activity";

const TEAL = "#12a189";
const BLUE = "#2f6bff";
const ORANGE = "#f08a24";
const RANGES = { "1m": 30, "5m": 150, "15m": 450 } as const;
type Range = keyof typeof RANGES;
type Sample = { t: number; qps: number; p50: number | null; p99: number | null; perIndex: Record<string, number> };

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

function Kpi({ label, value, delta, invert, spark, color, note }: {
  label: string;
  value: string;
  delta?: number | null;
  invert?: boolean;
  spark?: (number | null)[];
  color?: string;
  note?: string;
}) {
  return (
    <div className="kpi">
      <span className="kpi-label">{label}</span>
      <div className="kpi-row">
        <span className="kpi-value">{value}</span>
        {spark && <Sparkline values={spark} color={color} width={96} height={36} />}
      </div>
      {note ? <span className="kpi-note">{note}</span> : <Delta value={delta ?? null} invert={invert} suffix="vs 1 min ago" />}
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
      t: Date.now(), qps: r.all.qps, p50: r.all.p50Ms, p99: r.all.p99Ms,
      perIndex: Object.fromEntries(Object.entries(r.indexes).map(([k, v]) => [k, v.qps])),
    }]);
  }, [stats]);

  if (!stats) {
    return (
      <>
        <PageHeader title="Overview" subtitle="Connecting to live metrics…" />
        {error ? <ErrorNote error={error} /> : (
          <div className="overview-top"><Skeleton height={176} radius={16} /><Skeleton height={176} radius={16} /></div>
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
        <div className="card kpis">
          <Kpi label="Requests per second" value={r.all.qps.toFixed(1)} delta={change(history, (s) => s.qps)}
            spark={visible.map((s) => s.qps)} color={TEAL} />
          <Kpi label="p50 latency" value={fmtMs(r.all.p50Ms)} delta={change(history, (s) => s.p50)} invert
            spark={visible.map((s) => s.p50)} color={BLUE} />
          <Kpi label="p99 latency" value={fmtMs(r.all.p99Ms)} delta={change(history, (s) => s.p99)} invert
            spark={visible.map((s) => s.p99)} color={ORANGE} />
          <Kpi label="Index memory" value={fmtBytes(t.memoryBytes)} note={`Server process ${fmtBytes(stats.process.rssBytes)}`} />
        </div>
      </div>

      <div className="overview-grid">
        <Card className="span-2" icon={<IconActivity size={16} />} title={metric === "requests" ? "Throughput" : "Latency"}
          actions={<>
            <Segmented label="Metric" value={metric} onChange={setMetric}
              options={[{ value: "requests", label: "Requests" }, { value: "latency", label: "Latency" }]} />
            <Segmented label="Range" value={range} onChange={setRange}
              options={[{ value: "1m", label: "1m" }, { value: "5m", label: "5m" }, { value: "15m", label: "15m" }]} />
          </>}>
          <div className="chart-head">
            <div>
              <span className="chart-figure">
                {metric === "requests" ? (mean(visible.map((s) => s.qps)) ?? 0).toFixed(1) : fmtMs(mean(visible.map((s) => s.p99)))}
              </span>
              <span className="chart-unit">{metric === "requests" ? "requests per second, average" : "p99, average"}</span>
            </div>
            <Legend series={metric === "requests"
              ? [{ name: "Requests/s", color: TEAL }]
              : [{ name: "p50", color: BLUE }, { name: "p99", color: ORANGE }]} />
          </div>
          {metric === "requests" ? (
            <AreaChart times={times} height={232} format={(v) => v.toFixed(v < 10 ? 1 : 0)}
              series={[{ name: "Requests/s", color: TEAL, values: visible.map((s) => s.qps) }]} />
          ) : (
            <AreaChart times={times} height={232} format={fmtMs}
              series={[
                { name: "p50", color: BLUE, values: visible.map((s) => s.p50) },
                { name: "p99", color: ORANGE, values: visible.map((s) => s.p99) },
              ]} />
          )}
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
