import { Fragment, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import {
  BrandMark,
  IconBook,
  IconCode,
  IconExternal,
  IconChevronRight,
  IconChevronsUpDown,
  IconCopy,
  IconHome,
  IconIndexes,
  IconKey,
  IconLogOut,
  IconOverview,
  IconPlus,
  IconReturn,
  IconSearch,
  IconShield,
  IconSparkles,
} from "./icons";
import { ROLE_LABEL, copyText, fmtCompact, fmtMs, go, useHashRoute, usePoll } from "./lib";
import IndexPage from "./pages/IndexPage";
import Indexes from "./pages/Indexes";
import Keys from "./pages/Keys";
import Overview from "./pages/Overview";
import Playground from "./pages/Playground";
import Security from "./pages/Security";
import { useSession } from "./session";
import { Avatar, Dot, Empty, Kbd, Menu, MenuDivider, MenuItem, MenuLabel, useToast } from "./ui";

type Command = { id: string; group: string; label: string; hint?: string; icon: ReactNode; run: () => void };

const TAB_LABELS: Record<string, string> = { overview: "Overview", query: "Query", browse: "Browse", upsert: "Upsert", settings: "Settings" };

function CommandPalette({ commands, onClose }: { commands: Command[]; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? commands.filter((c) => `${c.label} ${c.hint ?? ""} ${c.group}`.toLowerCase().includes(q)) : commands;
  }, [commands, query]);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function run(command?: Command) {
    if (!command) return;
    onClose();
    command.run();
  }

  let lastGroup = "";
  return (
    <div className="palette-root" role="dialog" aria-modal="true" aria-label="Command menu">
      <div className="scrim" onMouseDown={onClose} />
      <div className="palette">
        <div className="palette-input">
          <IconSearch size={20} />
          <input autoFocus placeholder="Search indexes, pages and actions" value={query} aria-label="Search"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => Math.min(matches.length - 1, a + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => Math.max(0, a - 1));
              } else if (e.key === "Enter") {
                run(matches[active]);
              } else if (e.key === "Escape") {
                onClose();
              }
            }} />
          <Kbd>esc</Kbd>
        </div>
        <div className="palette-list" ref={listRef}>
          {matches.length === 0 && <div className="palette-empty">No matches for “{query}”</div>}
          {matches.map((c, i) => {
            const header = c.group !== lastGroup ? <div className="palette-group">{c.group}</div> : null;
            lastGroup = c.group;
            return (
              <div key={c.id}>
                {header}
                <button type="button" data-index={i} className={`palette-item ${i === active ? "on" : ""}`}
                  onMouseMove={() => setActive(i)} onClick={() => run(c)}>
                  <span className="palette-icon">{c.icon}</span>
                  <span className="palette-label">{c.label}</span>
                  {c.hint && <span className="palette-hint">{c.hint}</span>}
                  {i === active && <IconReturn size={16} />}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function NavItem({ href, icon, label, active, trailing }: { href: string; icon: ReactNode; label: string; active: boolean; trailing?: ReactNode }) {
  return (
    <a href={href} className={`nav-item ${active ? "active" : ""}`} aria-current={active ? "page" : undefined}>
      {icon}
      <span className="nav-text">{label}</span>
      {trailing}
    </a>
  );
}

export default function Shell() {
  const { parts, params } = useHashRoute();
  const { me, signOut, can } = useSession();
  const toast = useToast();
  const indexes = usePoll(api.indexes, 5000);
  const health = usePoll(api.stats, 10000);
  const [palette, setPalette] = useState(false);
  const section = parts[0] ?? "";
  const current = section === "indexes" ? parts[1] : undefined;
  const principal = me.principal;
  const list = indexes.data?.indexes ?? [];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => !p);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const crumbs: { label: string; href?: string }[] =
    section === "" ? [{ label: "Overview" }]
      : section === "indexes" && current ? [
        { label: "Indexes", href: "#/indexes" },
        { label: current, href: `#/indexes/${encodeURIComponent(current)}` },
        { label: TAB_LABELS[parts[2] ?? "overview"] ?? "Overview" },
      ]
        : section === "indexes" ? [{ label: "Indexes" }]
          : section === "keys" ? [{ label: "API Keys" }]
            : section === "security" ? [{ label: "Security" }]
            : section === "playground" ? [{ label: "Playground" }]
              : [{ label: "Not found" }];

  useEffect(() => {
    document.title = `${crumbs.filter((c) => c.label !== "Overview" || crumbs.length === 1).map((c) => c.label).join(" · ")} — NeedleDB`;
  });

  const commands: Command[] = [
    { id: "p-overview", group: "Go to", label: "Overview", icon: <IconOverview size={18} />, run: () => go("/") },
    { id: "p-indexes", group: "Go to", label: "Indexes", icon: <IconIndexes size={18} />, run: () => go("/indexes") },
    { id: "p-playground", group: "Go to", label: "Playground", hint: "Search in plain language", icon: <IconSparkles size={18} />, run: () => go("/playground") },
    { id: "p-compare", group: "Go to", label: "Compare embedding models", icon: <IconSparkles size={18} />, run: () => go("/playground/compare") },
    ...(can("admin") ? [{ id: "p-keys", group: "Go to", label: "API Keys", icon: <IconKey size={18} />, run: () => go("/keys") }] : []),
    { id: "p-security", group: "Go to", label: "Security", icon: <IconShield size={18} />, run: () => go("/security") },
    ...list.map((i) => ({
      id: `i-${i.name}`, group: "Indexes", label: i.name, hint: `${i.dimension}-d · ${fmtCompact(i.vectorCount)} vectors`,
      icon: <IconIndexes size={18} />, run: () => go(`/indexes/${encodeURIComponent(i.name)}`),
    })),
    ...list.map((i) => ({
      id: `q-${i.name}`, group: "Query", label: `Query ${i.name}`, icon: <IconSearch size={18} />,
      run: () => go(`/indexes/${encodeURIComponent(i.name)}/query`),
    })),
    ...(can("admin") ? [
      { id: "a-index", group: "Actions", label: "Create an index", icon: <IconPlus size={18} />, run: () => go("/indexes?new=1") },
      { id: "a-key", group: "Actions", label: "Create an API key", icon: <IconKey size={18} />, run: () => go("/keys?new=1") },
    ] : []),
    { id: "a-guide", group: "Actions", label: "Read the documentation", icon: <IconBook size={18} />, run: () => go("/docs") },
    { id: "a-docs", group: "Actions", label: "Open the API explorer", icon: <IconCode size={18} />, run: () => window.open("/docs", "_blank", "noopener") },
    ...(principal.source !== "local" ? [{ id: "a-out", group: "Actions", label: "Sign out", icon: <IconLogOut size={18} />, run: () => void signOut() }] : []),
  ];

  let page: ReactNode;
  if (section === "indexes" && current) {
    page = <IndexPage key={current} name={current} tab={parts[2] ?? "overview"} params={params} onChanged={indexes.reload} />;
  } else if (section === "indexes") {
    page = <Indexes indexes={indexes.data?.indexes} error={indexes.error} openNew={params.get("new") === "1"} onChanged={indexes.reload} />;
  } else if (section === "keys") {
    page = can("admin") ? <Keys openNew={params.get("new") === "1"} indexes={list} />
      : <Empty icon={<IconKey size={22} />} title="Admins manage keys">Your key has {ROLE_LABEL[principal.role].toLowerCase()} access.</Empty>;
  } else if (section === "playground") {
    page = <Playground indexes={list} loaded={!!indexes.data} tab={parts[1] ?? "search"} params={params} />;
  } else if (section === "security") {
    page = <Security query={params.get("q") ?? ""} />;
  } else if (section === "") {
    page = <Overview />;
  } else {
    page = <Empty title="Page not found" action={<a className="btn btn-secondary btn-md" href="#/">Back to overview</a>} />;
  }

  const live = health.data?.requests.all;

  return (
    <div className="frame">
      <aside className="sidebar">
        <Menu className="workspace" trigger={({ open, toggle }) => (
          <button type="button" className={`workspace-button ${open ? "open" : ""}`} onClick={toggle} aria-haspopup="menu" aria-expanded={open}>
            <BrandMark size={34} />
            <span className="workspace-text">
              <b>NeedleDB</b>
              <span>{window.location.host}</span>
            </span>
            <IconChevronsUpDown size={16} />
          </button>
        )}>
          {(close) => (
            <>
              <MenuLabel>This server</MenuLabel>
              <div className="menu-server">
                <Dot tone={health.error ? "bad" : "good"} />
                <span className="mono">{window.location.origin}</span>
              </div>
              <div className="menu-meta">Version {me.version ?? "—"} · {me.security?.https ? "HTTPS" : "HTTP"}</div>
              <MenuDivider />
              <MenuItem icon={<IconCopy size={16} />} onClick={() => {
                void copyText(window.location.origin);
                toast("API endpoint copied", "good");
                close();
              }}>Copy API endpoint</MenuItem>
              <MenuItem icon={<IconBook size={16} />} onClick={() => { window.open("/docs", "_blank", "noopener"); close(); }}>API reference</MenuItem>
              <MenuItem icon={<IconShield size={16} />} onClick={() => { go("/security"); close(); }}>Security</MenuItem>
            </>
          )}
        </Menu>

        <nav className="nav" aria-label="Main">
          <div className="nav-label">Platform</div>
          <NavItem href="#/" icon={<IconOverview size={18} />} label="Overview" active={section === ""} />
          <NavItem href="#/indexes" icon={<IconIndexes size={18} />} label="Indexes" active={section === "indexes" && !current}
            trailing={list.length ? <span className="nav-count">{list.length}</span> : undefined} />
          <NavItem href="#/playground" icon={<IconSparkles size={18} />} label="Playground" active={section === "playground"} />

          <div className="nav-label">Access</div>
          {can("admin") && <NavItem href="#/keys" icon={<IconKey size={18} />} label="API Keys" active={section === "keys"} />}
          <NavItem href="#/security" icon={<IconShield size={18} />} label="Security" active={section === "security"} />

          <div className="nav-label">Resources</div>
          <a href="#/docs" className="nav-item"><IconBook size={18} /><span className="nav-text">Documentation</span></a>
          <a href="/docs" target="_blank" rel="noreferrer" className="nav-item">
            <IconCode size={18} /><span className="nav-text">API explorer</span><IconExternal size={13} />
          </a>

          {list.length > 0 && <div className="nav-label">Indexes</div>}
          {list.map((i) => (
            <a key={i.name} href={`#/indexes/${encodeURIComponent(i.name)}`} className={`nav-index ${current === i.name ? "active" : ""}`}>
              <Dot tone={i.status.state === "Ready" ? "good" : "warn"} />
              <span className="nav-text">{i.name}</span>
              <span className="nav-count">{fmtCompact(i.vectorCount)}</span>
            </a>
          ))}
        </nav>

        <div className="sidebar-foot">
          <div className="status-card">
            <div className="status-head">
              <Dot tone={health.error ? "bad" : "good"} />
              <b>{health.error ? "Server unreachable" : "All systems normal"}</b>
            </div>
            <div className="status-grid">
              <span>Requests/s</span><b>{live ? live.qps.toFixed(1) : "—"}</b>
              <span>p99</span><b>{fmtMs(live?.p99Ms)}</b>
            </div>
          </div>

          <Menu direction="up" className="account" trigger={({ open, toggle }) => (
            <button type="button" className={`account-button ${open ? "open" : ""}`} onClick={toggle} aria-haspopup="menu" aria-expanded={open}>
              <Avatar name={principal.name} size={32} />
              <span className="account-text">
                <b>{principal.name}</b>
                <span>{principal.source === "local" ? "Auth disabled · localhost" : ROLE_LABEL[principal.role]}</span>
              </span>
              <IconChevronsUpDown size={16} />
            </button>
          )}>
            {(close) => (
              <>
                <MenuLabel>Signed in as {principal.name}</MenuLabel>
                <MenuItem icon={<IconShield size={16} />} onClick={() => { go("/security"); close(); }}>Your access</MenuItem>
                {can("admin") && <MenuItem icon={<IconKey size={16} />} onClick={() => { go("/keys"); close(); }}>API Keys</MenuItem>}
                <MenuItem icon={<IconBook size={16} />} onClick={() => { window.open("/docs", "_blank", "noopener"); close(); }}>API reference</MenuItem>
                {principal.source !== "local" && (
                  <>
                    <MenuDivider />
                    <MenuItem tone="bad" icon={<IconLogOut size={16} />} onClick={() => { close(); void signOut(); }}>Sign out</MenuItem>
                  </>
                )}
              </>
            )}
          </Menu>
        </div>
      </aside>

      <div className="stage">
        <div className="surface">
          <header className="topbar">
            <nav className="crumbs" aria-label="Breadcrumb">
              <a href="#/" className="crumb-home" aria-label="Overview"><IconHome size={16} /></a>
              {crumbs.map((c, i) => (
                <Fragment key={`${c.label}-${i}`}>
                  <IconChevronRight size={14} />
                  {c.href && i < crumbs.length - 1 ? <a href={c.href}>{c.label}</a> : <span className="current">{c.label}</span>}
                </Fragment>
              ))}
            </nav>
            <div className="topbar-actions">
              <button type="button" className="topbar-search" onClick={() => setPalette(true)}>
                <IconSearch size={16} />
                <span>Search indexes, pages, actions</span>
                <Kbd>⌘K</Kbd>
              </button>
              <a className="icon-button" href="#/docs" aria-label="Documentation" title="Documentation">
                <IconBook size={18} />
              </a>
            </div>
          </header>
          <main className="main">
            <div className="page" key={`${section}/${current ?? ""}`}>{page}</div>
          </main>
        </div>
      </div>

      {palette && <CommandPalette commands={commands} onClose={() => setPalette(false)} />}
    </div>
  );
}
