import { useEffect, useState } from "react";
import { api } from "../api";
import { AreaChart, Legend } from "../charts";
import { IconActivity, IconBolt, IconChip, IconClock, IconIndexes, IconPlus } from "../icons";
import { fmtBytes, fmtCompact, fmtDuration, fmtInt, fmtMs, go, usePoll } from "../lib";
import { useSession } from "../session";
import { Button, Card, Empty, ErrorNote, PageHeader, Skeleton, Stat } from "../ui";
import IndexCard from "./IndexCard";

const BLUE = "#0071e3";
const ORANGE = "#ff9f0a";

type Sample = { t: number; qps: number; p50: number | null; p99: number | null; perIndex: Record<string, number> };

function OverviewSkeleton() {
  return (
    <>
      <div className="stats">{[0, 1, 2, 3].map((i) => <Skeleton key={i} height={132} radius={20} />)}</div>
      <div className="grid-2">{[0, 1].map((i) => <Skeleton key={i} height={300} radius={22} />)}</div>
    </>
  );
}

export default function Overview() {
  const { can } = useSession();
  const { data: stats, error } = usePoll(api.stats, 2000);
  const [history, setHistory] = useState<Sample[]>([]);

  useEffect(() => {
    if (!stats) return;
    const r = stats.requests;
    setHistory((h) => [...h.slice(-149), {
      t: Date.now(), qps: r.all.qps, p50: r.all.p50Ms, p99: r.all.p99Ms,
      perIndex: Object.fromEntries(Object.entries(r.indexes).map(([k, v]) => [k, v.qps])),
    }]);
  }, [stats]);

  if (!stats) {
    return (
      <>
        <PageHeader title="Overview" subtitle="Connecting to live metrics…" />
        {error ? <ErrorNote error={error} /> : <OverviewSkeleton />}
      </>
    );
  }

  const { requests: r, totals: t } = stats;
  const times = history.map((s) => s.t);
  const routes = Object.entries(r.routes).sort((a, b) => b[1].count - a[1].count);

  return (
    <>
      <PageHeader
        title="Overview"
        subtitle={`${t.indexes} ${t.indexes === 1 ? "index" : "indexes"} · ${fmtInt(t.vectors)} vectors · up ${fmtDuration(r.uptimeSeconds)}`}
        actions={<span className="live"><i />Live</span>}
      />

      <div className="stats">
        <Stat icon={<IconIndexes size={16} />} label="Vectors" value={fmtCompact(t.vectors)}
          hint={`${fmtInt(t.vectors)} stored`} />
        <Stat icon={<IconBolt size={16} />} label="Queries per second" value={r.all.qps.toFixed(1)} color={BLUE}
          hint="Last 60 seconds" spark={history.map((s) => s.qps)} />
        <Stat icon={<IconClock size={16} />} label="p99 latency" value={fmtMs(r.all.p99Ms)} color={ORANGE}
          hint={`p50 ${fmtMs(r.all.p50Ms)}`} spark={history.map((s) => s.p99)} />
        <Stat icon={<IconChip size={16} />} label="Index memory" value={fmtBytes(t.memoryBytes)}
          hint={`${fmtBytes(t.storageBytes)} on disk`} />
      </div>

      <div className="grid-2">
        <Card title="Throughput" subtitle="Requests per second" actions={<Legend series={[{ name: "Requests", color: BLUE }]} />}>
          <AreaChart times={times} format={(v) => v.toFixed(v < 10 ? 1 : 0)}
            series={[{ name: "Requests/s", color: BLUE, values: history.map((s) => s.qps) }]} />
        </Card>
        <Card title="Latency" subtitle="Measured on the server"
          actions={<Legend series={[{ name: "p50", color: BLUE }, { name: "p99", color: ORANGE }]} />}>
          <AreaChart times={times} format={fmtMs}
            series={[
              { name: "p50", color: BLUE, values: history.map((s) => s.p50) },
              { name: "p99", color: ORANGE, values: history.map((s) => s.p99) },
            ]} />
        </Card>
      </div>

      <section className="section">
        <div className="section-head">
          <h2>Indexes</h2>
          {can("admin") && stats.indexes.length > 0 && (
            <Button size="sm" variant="ghost" icon={<IconPlus size={16} />} onClick={() => go("/indexes?new=1")}>New index</Button>
          )}
        </div>
        {stats.indexes.length ? (
          <div className="index-grid">
            {stats.indexes.map((i) => (
              <IndexCard key={i.name} info={i} qps={r.indexes[i.name]?.qps}
                spark={history.map((s) => s.perIndex[i.name] ?? 0)} />
            ))}
          </div>
        ) : (
          <Card>
            <Empty icon={<IconIndexes size={24} />} title="No indexes yet"
              action={can("admin") && <Button variant="primary" icon={<IconPlus size={17} />} onClick={() => go("/indexes?new=1")}>Create an index</Button>}>
              Create an index for your embeddings, then upsert from the SDK or this app.
            </Empty>
          </Card>
        )}
      </section>

      <Card title="Routes" subtitle={r.errors ? `${r.errors} server errors in the last minute` : "Every API route used in the last minute"} flush>
        {routes.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>Route</th><th className="num">Requests</th><th className="num">QPS</th><th className="num">p50</th><th className="num">p95</th><th className="num">p99</th></tr>
              </thead>
              <tbody>
                {routes.map(([route, x]) => (
                  <tr key={route}>
                    <td className="mono">{route}</td>
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
            Requests from the SDK, the Pinecone client or this app show up here with live percentiles.
          </Empty>
        )}
      </Card>
    </>
  );
}
