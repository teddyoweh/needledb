import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import {
  BrandMark,
  IconBook,
  IconChevronRight,
  IconIndexes,
  IconKey,
  IconLogOut,
  IconOverview,
  IconPlus,
  IconReturn,
  IconSearch,
  IconShield,
} from "./icons";
import { ROLE_LABEL, fmtCompact, go, useHashRoute, usePoll } from "./lib";
import IndexPage from "./pages/IndexPage";
import Indexes from "./pages/Indexes";
import Keys from "./pages/Keys";
import Overview from "./pages/Overview";
import Security from "./pages/Security";
import { useSession } from "./session";
import { Avatar, Dot, Empty, IconButton, Kbd } from "./ui";

type Command = { id: string; group: string; label: string; hint?: string; icon: ReactNode; run: () => void };

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
  const indexes = usePoll(api.indexes, 5000);
  const [palette, setPalette] = useState(false);
  const section = parts[0] ?? "";
  const current = section === "indexes" ? parts[1] : undefined;
  const principal = me.principal;

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

  const list = indexes.data?.indexes ?? [];
  const commands: Command[] = [
    { id: "p-overview", group: "Go to", label: "Overview", icon: <IconOverview size={18} />, run: () => go("/") },
    { id: "p-indexes", group: "Go to", label: "Indexes", icon: <IconIndexes size={18} />, run: () => go("/indexes") },
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
    { id: "a-docs", group: "Actions", label: "Open the API reference", icon: <IconBook size={18} />, run: () => window.open("/docs", "_blank", "noopener") },
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
  } else if (section === "security") {
    page = <Security />;
  } else if (section === "") {
    page = <Overview />;
  } else {
    page = <Empty title="Page not found" action={<a className="btn btn-secondary btn-md" href="#/">Back to overview</a>} />;
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <a className="brand" href="#/">
          <BrandMark size={30} />
          <b>NeedleDB</b>
          {me.version && <small>v{me.version}</small>}
        </a>
        <button type="button" className="search-trigger" onClick={() => setPalette(true)}>
          <IconSearch size={16} />
          <span>Search</span>
          <Kbd>⌘K</Kbd>
        </button>

        <nav className="nav" aria-label="Main">
          <NavItem href="#/" icon={<IconOverview size={18} />} label="Overview" active={section === ""} />
          <NavItem href="#/indexes" icon={<IconIndexes size={18} />} label="Indexes" active={section === "indexes" && !current}
            trailing={<span className="nav-count">{list.length || ""}</span>} />
          {can("admin") && <NavItem href="#/keys" icon={<IconKey size={18} />} label="API Keys" active={section === "keys"} />}
          <NavItem href="#/security" icon={<IconShield size={18} />} label="Security" active={section === "security"} />

          {list.length > 0 && <div className="nav-label">Your indexes</div>}
          {list.map((i) => (
            <a key={i.name} href={`#/indexes/${encodeURIComponent(i.name)}`} className={`nav-index ${current === i.name ? "active" : ""}`}>
              <Dot tone={i.status.state === "Ready" ? "good" : "warn"} />
              <span className="nav-text">{i.name}</span>
              <span className="nav-count">{fmtCompact(i.vectorCount)}</span>
            </a>
          ))}
        </nav>

        <div className="sidebar-foot">
          <a className="nav-item quiet" href="/docs" target="_blank" rel="noreferrer">
            <IconBook size={18} /><span className="nav-text">API reference</span><IconChevronRight size={14} />
          </a>
          <div className="account">
            <Avatar name={principal.name} size={34} />
            <div className="account-text">
              <b>{principal.name}</b>
              <span>{principal.source === "local" ? "Auth disabled · localhost" : ROLE_LABEL[principal.role]}</span>
            </div>
            {principal.source !== "local" && (
              <IconButton label="Sign out" onClick={() => void signOut()}><IconLogOut size={17} /></IconButton>
            )}
          </div>
        </div>
      </aside>

      <main className="main">
        <div className="page" key={`${section}/${current ?? ""}`}>{page}</div>
      </main>

      {palette && <CommandPalette commands={commands} onClose={() => setPalette(false)} />}
    </div>
  );
}
