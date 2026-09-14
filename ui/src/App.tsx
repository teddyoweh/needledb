import { useEffect, useState } from "react";
import { api, onUnauthorized } from "./api";
import { KeyDialog, NeedleMark } from "./components";
import { fmtCompact, go, useHashRoute, usePoll } from "./lib";
import IndexPage from "./pages/IndexPage";
import Indexes from "./pages/Indexes";
import Overview from "./pages/Overview";

export default function App() {
  const { parts, params } = useHashRoute();
  const [askKey, setAskKey] = useState(false);
  useEffect(() => onUnauthorized(() => setAskKey(true)), []);

  const indexes = usePoll(api.indexes, 5000);
  const health = usePoll(api.health, 30000);
  const section = parts[0] ?? "";
  const current = section === "indexes" ? parts[1] : undefined;

  let page;
  if (section === "indexes" && current) {
    page = (
      <IndexPage key={current} name={current} tab={parts[2] ?? "overview"} params={params}
        onChanged={indexes.reload}
        onDeleted={() => {
          void indexes.reload();
          go("/indexes");
        }} />
    );
  } else if (section === "indexes") {
    page = (
      <Indexes indexes={indexes.data?.indexes} error={indexes.error} openNew={params.get("new") === "1"}
        onCreated={(name) => {
          void indexes.reload();
          go(`/indexes/${encodeURIComponent(name)}`);
        }} />
    );
  } else {
    page = <Overview />;
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <a className="brand" href="#/"><NeedleMark /><span>NeedleDB</span></a>
        <nav className="nav" aria-label="Main">
          <a href="#/" className={section === "" ? "active" : ""}>Overview</a>
          <a href="#/indexes" className={section === "indexes" && !current ? "active" : ""}>
            Indexes <span className="count">{indexes.data?.indexes.length ?? ""}</span>
          </a>
          {!!indexes.data?.indexes.length && (
            <div className="nav-group">
              {indexes.data.indexes.map((i) => (
                <a key={i.name} href={`#/indexes/${encodeURIComponent(i.name)}`} className={`sub ${current === i.name ? "active" : ""}`}>
                  <span className="mono">{i.name}</span>
                  <span className="count">{fmtCompact(i.vectorCount)}</span>
                </a>
              ))}
            </div>
          )}
        </nav>
        <div className="sidebar-foot">
          <button type="button" className="link" onClick={() => setAskKey(true)}>API key</button>
          <a href="/docs" target="_blank" rel="noreferrer">API reference</a>
          <span>v{health.data?.version ?? "…"}</span>
        </div>
      </aside>
      <main className="main">{page}</main>
      {askKey && <KeyDialog onClose={() => setAskKey(false)} />}
    </div>
  );
}
