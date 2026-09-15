import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { BrandMark, IconArrowRight, IconBook, IconChevronRight, IconCode, IconExternal, IconReturn, IconRows, IconSearch, IconX } from "../icons";
import { go } from "../lib";
import { Kbd } from "../ui";
import { GUIDES } from "./guides";
import { Verb } from "./parts";
import { REFERENCE } from "./reference";
import { SDK } from "./sdk";
import type { DocPage } from "./types";

type Tab = { id: string; label: string; icon: ReactNode; pages: DocPage[] };

const TABS: Tab[] = [
  { id: "guides", label: "Guides", icon: <IconBook size={16} />, pages: GUIDES },
  { id: "api", label: "API Reference", icon: <IconCode size={16} />, pages: REFERENCE },
  { id: "sdk", label: "Python SDK", icon: <IconRows size={16} />, pages: SDK },
];

const ALL = TABS.flatMap((tab) => tab.pages.map((page) => ({ tab, page })));

const hrefOf = (tab: string, slug: string) => `#/docs/${tab}/${slug}`;

function groupsOf(pages: DocPage[]) {
  const groups: { name: string; pages: DocPage[] }[] = [];
  for (const page of pages) {
    const group = groups.find((g) => g.name === page.group);
    if (group) group.pages.push(page);
    else groups.push({ name: page.group, pages: [page] });
  }
  return groups;
}

function scrollToHeading(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 124, behavior: still ? "auto" : "smooth" });
}

export default function Docs({ path, signedIn }: { path: string[]; signedIn: boolean }) {
  const tab = TABS.find((t) => t.id === path[0]) ?? TABS[0];
  const page = path[1] ? tab.pages.find((p) => p.slug === path[1]) : tab.pages[0];
  const key = `${tab.id}/${page?.slug ?? path[1] ?? ""}`;
  const [searching, setSearching] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [toc, setToc] = useState<{ id: string; text: string; level: number }[]>([]);
  const [activeHeading, setActiveHeading] = useState<string>();
  const articleRef = useRef<HTMLElement>(null);

  useEffect(() => {
    window.scrollTo(0, 0);
    setNavOpen(false);
    document.title = `${page?.title ?? "Page not found"} — NeedleDB Docs`;
  }, [key, page?.title]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearching((s) => !s);
      } else if (e.key === "/" && !typing) {
        e.preventDefault();
        setSearching(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const article = articleRef.current;
    if (!article) return;
    const heads = [...article.querySelectorAll<HTMLElement>(".docs-content h2[id], .docs-content h3[id]")];
    setToc(heads.map((h) => ({ id: h.id, text: h.textContent ?? "", level: h.tagName === "H3" ? 3 : 2 })));
    const onScroll = () => {
      let current = heads[0]?.id;
      for (const h of heads) if (h.getBoundingClientRect().top < 150) current = h.id;
      setActiveHeading(current);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [key]);

  const position = page ? tab.pages.indexOf(page) : -1;
  const prev = position > 0 ? tab.pages[position - 1] : undefined;
  const next = position >= 0 && position < tab.pages.length - 1 ? tab.pages[position + 1] : undefined;

  return (
    <div className="docs">
      <header className="docs-header">
        <div className="docs-top">
          <button type="button" className="icon-button docs-menu-button" aria-label={navOpen ? "Close menu" : "Open menu"}
            aria-expanded={navOpen} onClick={() => setNavOpen((o) => !o)}>
            {navOpen ? <IconX size={18} /> : <IconRows size={18} />}
          </button>
          <a className="docs-brand" href="#/docs">
            <BrandMark size={30} />
            <b>NeedleDB</b>
            <span className="docs-badge">Docs</span>
          </a>
          <button type="button" className="docs-search" onClick={() => setSearching(true)} aria-label="Search the docs">
            <IconSearch size={16} />
            <span>Search the docs</span>
            <Kbd>⌘K</Kbd>
          </button>
          <div className="docs-top-actions">
            <a className="docs-top-link hide-sm" href="/docs" target="_blank" rel="noreferrer">API explorer <IconExternal size={12} /></a>
            <a className="btn btn-primary btn-sm" href="#/">{signedIn ? "Open app" : "Sign in"}<IconArrowRight size={15} /></a>
          </div>
        </div>
        <nav className="docs-tabs" aria-label="Documentation sections">
          {TABS.map((t) => (
            <a key={t.id} href={hrefOf(t.id, t.pages[0].slug)} className={t.id === tab.id ? "active" : ""}
              aria-current={t.id === tab.id ? "true" : undefined}>
              {t.icon}{t.label}
            </a>
          ))}
        </nav>
      </header>

      <div className={`docs-body ${page?.wide ? "wide" : ""}`}>
        <aside className={`docs-nav ${navOpen ? "open" : ""}`} aria-label={`${tab.label} pages`}>
          {groupsOf(tab.pages).map((group) => (
            <div key={group.name} className="docs-nav-group">
              <div className="docs-nav-title">{group.name}</div>
              {group.pages.map((p) => (
                <a key={p.slug} href={hrefOf(tab.id, p.slug)} className={p === page ? "active" : ""} aria-current={p === page ? "page" : undefined}>
                  {p.method && <Verb method={p.method} />}
                  <span>{p.title}</span>
                </a>
              ))}
            </div>
          ))}
        </aside>

        <main className="docs-main">
          {page ? (
            <article className="docs-article" ref={articleRef} key={key}>
              <div className="docs-eyebrow">{page.group}</div>
              <h1>{page.title}</h1>
              {page.description && <p className="docs-lede">{page.description}</p>}
              <div className="docs-content">{page.render()}</div>

              <nav className="docs-pager" aria-label="Previous and next pages">
                {prev && (
                  <a href={hrefOf(tab.id, prev.slug)} className="prev">
                    <span>Previous</span>
                    <b>{prev.title}</b>
                  </a>
                )}
                {next && (
                  <a href={hrefOf(tab.id, next.slug)} className="next">
                    <span>Next</span>
                    <b>{next.title}</b>
                  </a>
                )}
              </nav>
              <footer className="docs-foot">
                <span>NeedleDB 0.1 · self-hosted vector database</span>
                <span>
                  <a href="/docs" target="_blank" rel="noreferrer">OpenAPI explorer</a>
                  <a href="#/">{signedIn ? "Back to the app" : "Sign in"}</a>
                </span>
              </footer>
            </article>
          ) : (
            <article className="docs-article" ref={articleRef} key={key}>
              <div className="docs-eyebrow">Not found</div>
              <h1>There's no page here</h1>
              <p className="docs-lede">The link may be out of date. Search the docs, or start from the introduction.</p>
              <div className="docs-content">
                <p><a href={hrefOf("guides", "introduction")}>Go to the introduction</a></p>
              </div>
            </article>
          )}
        </main>

        {!page?.wide && (
          <aside className="docs-toc" aria-label="On this page">
            {page && toc.length > 1 && (
              <>
                <div className="docs-toc-title">On this page</div>
                {toc.map((item) => (
                  <button key={item.id} type="button" className={`${item.level === 3 ? "l3" : ""} ${activeHeading === item.id ? "on" : ""}`}
                    onClick={() => scrollToHeading(item.id)}>
                    {item.text}
                  </button>
                ))}
              </>
            )}
          </aside>
        )}
      </div>

      {searching && <DocsSearch onClose={() => setSearching(false)} />}
    </div>
  );
}

function DocsSearch({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const results = useMemo(() => {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return ALL.filter((r) => r.tab.id === "guides").slice(0, 8);
    return ALL
      .map((r) => {
        const title = r.page.title.toLowerCase();
        const haystack = `${title} ${r.page.group} ${r.page.description ?? ""} ${r.page.keywords ?? ""} ${r.tab.label} ${r.page.method ?? ""}`.toLowerCase();
        if (!terms.every((t) => haystack.includes(t))) return null;
        const score = terms.reduce((s, t) => s + (title.includes(t) ? 3 : 1), 0) + (title.startsWith(terms[0]) ? 2 : 0);
        return { ...r, score };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .sort((a, b) => b.score - a.score)
      .slice(0, 12);
  }, [query]);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function open(i: number) {
    const r = results[i];
    if (!r) return;
    onClose();
    go(`/docs/${r.tab.id}/${r.page.slug}`);
  }

  return (
    <div className="palette-root" role="dialog" aria-modal="true" aria-label="Search the docs">
      <div className="scrim" onMouseDown={onClose} />
      <div className="palette">
        <div className="palette-input">
          <IconSearch size={20} />
          <input autoFocus placeholder="Search guides, endpoints and SDK methods" value={query} aria-label="Search"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => Math.min(results.length - 1, a + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => Math.max(0, a - 1));
              } else if (e.key === "Enter") {
                open(active);
              } else if (e.key === "Escape") {
                onClose();
              }
            }} />
          <Kbd>esc</Kbd>
        </div>
        <div className="palette-list" ref={listRef}>
          {!query.trim() && <div className="palette-group">Suggested</div>}
          {results.length === 0 && <div className="palette-empty">Nothing matches “{query}”</div>}
          {results.map((r, i) => (
            <button key={`${r.tab.id}/${r.page.slug}`} type="button" data-index={i} className={`palette-item ${i === active ? "on" : ""}`}
              onMouseMove={() => setActive(i)} onClick={() => open(i)}>
              <span className="palette-icon">{r.page.method ? <Verb method={r.page.method} /> : r.tab.icon}</span>
              <span className="palette-label">{r.page.title}</span>
              <span className="palette-hint">{r.tab.label}<IconChevronRight size={12} />{r.page.group}</span>
              {i === active && <IconReturn size={16} />}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
