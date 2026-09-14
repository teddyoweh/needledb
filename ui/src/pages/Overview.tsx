import { useEffect, useState } from "react";
import { api } from "../api";
import { Badge, Empty, ErrorNote, IndexTable, Loading, Panel, Tile } from "../components";
import { fmtBytes, fmtDuration, fmtInt, fmtMs, usePoll } from "../lib";
import { TimeChart } from "../TimeChart";

type Sample = { t: number; qps: number; p50: number | null; p99: number | null };

export default function Overview() {
  const { data: stats, error } = usePoll(api.stats, 2000);
  const [history, setHistory] = useState<Sample[]>([]);

  useEffect(() => {
    if (!stats) return;
    const all = stats.requests.all;
    setHistory((h) => [...h.slice(-179), { t: Date.now(), qps: all.qps, p50: all.p50Ms, p99: all.p99Ms }]);
  }, [stats]);

  if (!stats) {
    return (
      <>
        <header className="page-head"><h1>Overview</h1></header>
        {error ? <ErrorNote error={error} /> : <Loading />}
      </>
    );
  }

  const { requests, totals, process } = stats;
  const routes = Object.entries(requests.routes).sort((a, b) => b[1].count - a[1].count);
  const times = history.map((s) => s.t);

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Overview</h1>
          <p className="sub"><span className="mono">{stats.dataDir}</span> · up {fmtDuration(requests.uptimeSeconds)}</p>
        </div>
        <Badge tone={stats.authEnabled ? "good" : "warn"}>{stats.authEnabled ? "API key required" : "No auth"}</Badge>
      </header>

      <div className="tiles">
        <Tile label="Vectors" value={fmtInt(totals.vectors)} hint={`${totals.indexes} ${totals.indexes === 1 ? "index" : "indexes"}`} />
        <Tile label="Queries / s" value={requests.all.qps.toFixed(1)} hint={`p99 ${fmtMs(requests.all.p99Ms)} · last 60 s`} />
        <Tile label="Index memory" value={fmtBytes(totals.memoryBytes)} hint="vectors + graph links, estimated" />
        <Tile label="On disk" value={fmtBytes(totals.storageBytes)} hint="SQLite log and records" />
        <Tile label="Process RSS" value={fmtBytes(process.rssBytes)} hint={`${process.cpuCount} cores · pid ${process.pid}`} />
      </div>

      <div className="grid-2">
        <Panel title="Throughput" note="requests per second, 60 s rolling">
          <TimeChart times={times} format={(v) => v.toFixed(v < 10 ? 1 : 0)}
            series={[{ name: "Requests / s", color: "var(--series-1)", values: history.map((s) => s.qps) }]} />
        </Panel>
        <Panel title="Latency" note="server-side, 60 s rolling">
          <TimeChart times={times} format={fmtMs}
            series={[
              { name: "p50", color: "var(--series-1)", values: history.map((s) => s.p50) },
              { name: "p99", color: "var(--series-2)", values: history.map((s) => s.p99) },
            ]} />
        </Panel>
      </div>

      <Panel title="Indexes">
        <IndexTable indexes={stats.indexes} traffic={requests.indexes} />
      </Panel>

      <Panel title="Routes" note={requests.errors ? `${requests.errors} server errors in the last minute` : "last 60 s"}>
        {routes.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Route</th><th className="num">Requests</th><th className="num">QPS</th><th className="num">p50</th><th className="num">p95</th><th className="num">p99</th></tr>
              </thead>
              <tbody>
                {routes.map(([route, t]) => (
                  <tr key={route}>
                    <td className="mono">{route}</td>
                    <td className="num">{fmtInt(t.count)}</td>
                    <td className="num">{t.qps.toFixed(1)}</td>
                    <td className="num">{fmtMs(t.p50Ms)}</td>
                    <td className="num">{fmtMs(t.p95Ms)}</td>
                    <td className="num">{fmtMs(t.p99Ms)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="No traffic in the last minute">
            Requests from the SDK, curl or this dashboard's Query tab show up here with live percentiles.
          </Empty>
        )}
      </Panel>
    </>
  );
}
