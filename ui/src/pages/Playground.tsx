import { useEffect, useMemo, useRef, useState } from "react";
import { api, type CompareResult, type EmbeddingCatalog, type IndexInfo, type QueryResult } from "../api";
import { BrandLogo, ModelBadge, PROVIDER_VENDOR, useEmbeddingCatalog } from "../brands";
import { IconBolt, IconClock, IconPlus, IconRows, IconSearch, IconSparkles, IconX } from "../icons";
import { fmtInt, fmtMs, go, titleOf, usePoll } from "../lib";
import { useSession } from "../session";
import { Button, Card, Choice, Empty, ErrorNote, IconButton, MetadataChips, NamespaceSelect, PageHeader, Skeleton, Tabs } from "../ui";
import { ConnectModel } from "./ConnectModel";

type Scalar = string | number | boolean;
type Facet = { field: string; value: Scalar };

export default function Playground({ indexes, loaded, tab, params }: {
  indexes: IndexInfo[];
  loaded: boolean;
  tab: string;
  params: URLSearchParams;
}) {
  const current = tab === "compare" ? "compare" : "search";
  return (
    <>
      <PageHeader title="Playground" subtitle="Search in plain language, and see how embedding models rank the same text." />
      <Tabs label="Playground" current={current} items={[
        { id: "search", label: "Search an index", href: "#/playground" },
        { id: "compare", label: "Compare models", href: "#/playground/compare" },
      ]} />
      {current === "search"
        ? <SearchIndex indexes={indexes} loaded={loaded} initial={params.get("index") ?? undefined} />
        : <CompareModels />}
    </>
  );
}

// ---- search an index -----------------------------------------------------------------------

function useRecent(scope: string) {
  const key = `needledb.playground.recent.${scope}`;
  const read = () => {
    try {
      const value = JSON.parse(localStorage.getItem(key) ?? "[]");
      return Array.isArray(value) ? (value as string[]) : [];
    } catch {
      return [];
    }
  };
  const [items, setItems] = useState<string[]>(read);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setItems(read()), [key]);
  const remember = (text: string) => setItems((prev) => {
    const next = [text, ...prev.filter((p) => p !== text)].slice(0, 6);
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      // Storage can be unavailable (private windows); recents are a convenience.
    }
    return next;
  });
  return [items, remember] as const;
}

/** Metadata fields worth filtering by: short text or yes/no values with 2–8 options in the results. */
function facetsOf(matches: QueryResult["matches"], skip: string[]) {
  const fields = new Map<string, Map<string, { value: Scalar; count: number }>>();
  for (const m of matches) {
    for (const [field, value] of Object.entries(m.metadata ?? {})) {
      if (skip.includes(field) || Array.isArray(value) || typeof value === "number" || (typeof value === "string" && value.length > 40)) continue;
      const values = fields.get(field) ?? new Map<string, { value: Scalar; count: number }>();
      const k = String(value);
      values.set(k, { value, count: (values.get(k)?.count ?? 0) + 1 });
      fields.set(field, values);
    }
  }
  return [...fields.entries()]
    .filter(([, values]) => values.size >= 2 && values.size <= 8)
    .slice(0, 3)
    .map(([field, values]) => ({ field, values: [...values.values()].sort((a, b) => b.count - a.count) }));
}

function SearchIndex({ indexes, loaded, initial }: { indexes: IndexInfo[]; loaded: boolean; initial?: string }) {
  const { can } = useSession();
  const catalog = useEmbeddingCatalog();
  const [name, setName] = useState("");
  // A model connected here shows up before the index list refreshes.
  const [connected, setConnected] = useState<Record<string, IndexInfo>>({});
  const ordered = [...indexes].map((i) => connected[i.name] ?? i).sort((a, b) => Number(!!b.embed) - Number(!!a.embed));
  const info = ordered.find((i) => i.name === name);
  const stats = usePoll(() => (name ? api.describeStats(name) : Promise.resolve(undefined)), 30000, [name]);
  const namespaces = Object.keys(stats.data?.namespaces ?? {});
  const [query, setQuery] = useState("");
  const [topK, setTopK] = useState("10");
  const [namespace, setNamespace] = useState("");
  const [facet, setFacet] = useState<Facet | null>(null);
  const [facets, setFacets] = useState<ReturnType<typeof facetsOf>>([]);
  const [result, setResult] = useState<QueryResult & { text: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [recent, remember] = useRecent(name || "none");
  const seq = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const embed = info?.embed ?? null;

  // The URL names the index (?index=…); otherwise take a searchable one. Indexes arrive after the first render.
  useEffect(() => {
    const requested = initial ? ordered.find((i) => i.name === initial) : undefined;
    if (requested) {
      setName(requested.name);
    } else if (!name || !ordered.some((i) => i.name === name)) {
      if (ordered[0]) setName(ordered[0].name);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ordered.map((i) => i.name).join(","), initial]);

  useEffect(() => {
    setResult(undefined);
    setFacet(null);
    setFacets([]);
    setNamespace("");
    setError(undefined);
  }, [name]);

  // Search as you type. Only the newest response is shown.
  useEffect(() => {
    const text = query.trim();
    const id = ++seq.current;
    if (!info || !embed || !text) {
      setResult(undefined);
      setBusy(false);
      setError(undefined);
      return;
    }
    const titleField = embed.field;
    const timer = window.setTimeout(async () => {
      setBusy(true);
      try {
        const res = await api.query(info.name, {
          text, topK: Number(topK), namespace, includeMetadata: true,
          ...(facet ? { filter: { [facet.field]: facet.value } } : {}),
        });
        if (id !== seq.current) return;
        setResult({ ...res, text });
        setError(undefined);
        if (!facet) setFacets(facetsOf(res.matches, [titleField, "title", "sample"]));
      } catch (err) {
        if (id === seq.current) setError((err as Error).message);
      } finally {
        if (id === seq.current) setBusy(false);
      }
    }, 300);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, topK, namespace, facet, info?.name, embed?.provider, embed?.model]);

  // Remember searches people settle on, not every keystroke.
  useEffect(() => {
    const text = result?.text;
    if (!text || text.length < 3 || !result.matches.length) return;
    const timer = window.setTimeout(() => remember(text), 1500);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result?.text]);

  if (!loaded) return <Skeleton height={220} radius={20} />;

  if (!indexes.length) {
    return (
      <Card>
        <Empty icon={<IconSparkles size={24} />} title="No indexes yet"
          action={<div className="actions-end">
            <Button onClick={() => go("/playground/compare")}>Compare models</Button>
            <Button variant="primary" icon={<IconPlus size={16} />} onClick={() => go("/indexes?new=1")}>Create an index</Button>
          </div>}>
          Create an index, add some text, and search it here in your own words. Or compare models on sentences you paste, with no index at all.
        </Empty>
      </Card>
    );
  }
  if (!info) return <Skeleton height={220} radius={20} />;

  const provider = embed ? catalog?.providers.find((p) => p.id === embed.provider) : undefined;
  const matches = result?.matches ?? [];
  const scores = matches.map((m) => m.score ?? 0);
  const lowerIsBetter = info.metric === "euclidean";
  const best = scores.length ? (lowerIsBetter ? Math.min(...scores) : Math.max(...scores)) : 0;
  const worst = scores.length ? (lowerIsBetter ? Math.max(...scores) : Math.min(...scores)) : 0;

  return (
    <div className="pg">
      <div className="pg-search">
        <div className="pg-bar">
          <select className="pg-index" aria-label="Index" value={name} onChange={(e) => go(`/playground?index=${encodeURIComponent(e.target.value)}`)}>
            {ordered.map((i) => <option key={i.name} value={i.name}>{i.name}{i.embed ? "" : " · no model"}</option>)}
          </select>
          <div className={`pg-input ${embed ? "" : "disabled"}`}>
            {busy ? <span className="spinner dark" aria-label="Searching" /> : <IconSearch size={20} />}
            <input ref={inputRef} autoFocus value={query} aria-label="Search" disabled={!embed}
              placeholder={embed ? `Search ${info.name} in your own words` : "Connect a model below to search this index in plain language"}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setQuery("");
                if (e.key === "Enter" && query.trim()) remember(query.trim());
              }} />
            {query && embed && (
              <IconButton label="Clear search" onClick={() => {
                setQuery("");
                inputRef.current?.focus();
              }}><IconX size={16} /></IconButton>
            )}
          </div>
        </div>
        <div className="pg-controls">
          {embed
            ? <span className="embedded-with">Searching {fmtInt(info.vectorCount)} records by meaning with <ModelBadge embed={embed} size={14} /></span>
            : <span>{fmtInt(info.vectorCount)} records · {fmtInt(info.dimension)}-dimensional vectors from a model NeedleDB doesn't know yet</span>}
          {embed && (
            <div className="pg-control-group">
              {namespaces.length > 1 && <NamespaceSelect id="pg-ns" value={namespace} namespaces={namespaces} onChange={setNamespace} />}
              <select aria-label="Number of results" value={topK} onChange={(e) => setTopK(e.target.value)}>
                {["5", "10", "20", "50"].map((n) => <option key={n} value={n}>{n} results</option>)}
              </select>
            </div>
          )}
        </div>
        {embed && provider && !provider.available && (
          <div className="note note-warn">
            {provider.local
              ? <>{info.name} searches with a local model, which needs <code>pip install "needledb[local]"</code> on the server.</>
              : <>{info.name} searches with {provider.name}, which needs an API key.{" "}
                {can("admin")
                  ? <a className="link" href={`#/settings?provider=${provider.id}`}>Add your {provider.name} key</a>
                  : "Ask an admin to add one under Settings."}</>}
          </div>
        )}
        {facets.length > 0 && (
          <div className="pg-facets">
            {facets.map((f) => (
              <div key={f.field} className="pg-facet">
                <span>{f.field}</span>
                {f.values.map((v) => {
                  const on = facet?.field === f.field && facet.value === v.value;
                  return (
                    <button key={String(v.value)} type="button" className={on ? "on" : ""} aria-pressed={on}
                      onClick={() => setFacet(on ? null : { field: f.field, value: v.value })}>
                      {String(v.value)}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </div>

      <ErrorNote error={error} />

      {!embed ? (
        <Card icon={<IconSparkles size={16} />} title={`Connect the model that made ${info.name}`}
          subtitle="Your searches are turned into vectors with that model, then matched against the vectors already in the index.">
          <ConnectModel info={info} onConnected={(next) => setConnected((c) => ({ ...c, [next.name]: next }))} />
        </Card>
      ) : !query.trim() ? (
        <div className="pg-idle">
          <span className="pg-idle-icon"><IconSparkles size={22} /></span>
          <b>Ask it anything</b>
          <p>Describe what you're looking for in your own words. Results are ranked by meaning, so the best match doesn't need to share a single word with your search.</p>
          {recent.length > 0 && (
            <div className="pg-recent">
              <span>Recent</span>
              {recent.map((r) => (
                <button key={r} type="button" onClick={() => setQuery(r)}><IconClock size={13} />{r}</button>
              ))}
            </div>
          )}
        </div>
      ) : !result ? (
        error ? null : <div className="stack tight">{[0, 1, 2, 3].map((i) => <Skeleton key={i} height={76} radius={14} />)}</div>
      ) : (
        <Card flush icon={<IconSparkles size={16} />}
          title={`${matches.length} ${matches.length === 1 ? "result" : "results"}`}
          subtitle={<>for “{result.text}”{facet ? ` · ${facet.field} is ${String(facet.value)}` : ""}</>}
          actions={
            <div className="meta-pills">
              {result.usage.embedMs != null && (
                <span className="meta-pill" title="Time to embed your search (repeat searches come from memory)">
                  <IconSparkles size={14} />{fmtMs(result.usage.embedMs)}
                </span>
              )}
              <span className="meta-pill" title="Total time on the server"><IconBolt size={14} />{fmtMs(result.usage.latencyMs)}</span>
            </div>
          }>
          {matches.length === 0 ? (
            <Empty icon={<IconSearch size={22} />} title="No matches">Remove the filter, or try another namespace.</Empty>
          ) : (
            <ol className="pg-results">
              {matches.map((m, i) => {
                const title = titleOf(m.metadata);
                const body = m.metadata?.[embed.field];
                const separateTitle = !!title && title.field !== embed.field;
                const heading = separateTitle ? title.text : typeof body === "string" ? body : title?.text ?? m.id;
                const snippet = separateTitle && typeof body === "string" ? body : undefined;
                const score = m.score ?? 0;
                const width = best === worst ? 100 : 12 + 88 * ((score - worst) / (best - worst));
                return (
                  <li key={m.id} className="pg-result" style={{ animationDelay: `${Math.min(i, 12) * 22}ms` }}>
                    <span className={`pg-rank ${i === 0 ? "first" : ""}`}>{i + 1}</span>
                    <div className="pg-body">
                      <p className="pg-text">{heading}</p>
                      {snippet && <p className="pg-snippet">{snippet}</p>}
                      <div className="pg-meta">
                        <span className="pg-id">{m.id}</span>
                        <MetadataChips metadata={m.metadata} omit={[embed.field, ...(title ? [title.field] : [])]} limit={4} />
                      </div>
                    </div>
                    <div className="pg-score" title={lowerIsBetter ? "Distance: lower is closer" : "Similarity: higher is closer"}>
                      <b>{score.toFixed(3)}</b>
                      <div className="bar"><i style={{ width: `${width}%` }} /></div>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </Card>
      )}
    </div>
  );
}

// ---- compare models ------------------------------------------------------------------------

const SAMPLES = {
  products: {
    label: "Products",
    queries: ["something to keep me dry when it rains", "a gift for someone who loves coffee", "gear for listening to records"],
    documents: [
      "Waterproof hiking boots with a grippy sole for muddy mountain trails",
      "Two-person ultralight tent that packs smaller than a water bottle",
      "Down sleeping bag rated for freezing nights at high altitude",
      "Breathable rain jacket with taped seams for storms on the ridge",
      "Headlamp with a red night mode for reading maps at camp",
      "Cast iron skillet that sears steak and goes straight into the oven",
      "Chef's knife forged from high-carbon steel for precise slicing",
      "Burr coffee grinder with forty settings from espresso to French press",
      "Gooseneck kettle with temperature control for pour-over coffee",
      "Enameled Dutch oven for slow-braised stews and crusty bread",
      "A science fiction epic about first contact with an alien language",
      "Field guide to identifying birds by their songs and calls",
      "Thriller about a detective hunting a hacker across Europe",
      "Beginner's handbook to growing vegetables on a small balcony",
      "Noise-cancelling headphones that silence airplane cabins on long flights",
      "Waterproof Bluetooth speaker that floats in the pool",
      "Turntable with a built-in preamp for playing vinyl records",
      "USB condenser microphone for recording podcasts at home",
      "Open-back headphones with a wide soundstage for classical music",
      "Compact umbrella that opens with one button and survives strong wind",
    ],
  },
  support: {
    label: "Support tickets",
    queries: ["money taken from my card by mistake", "my order never showed up", "I can't get into my account"],
    documents: [
      "I was charged twice for my subscription this month",
      "The app crashes every time I open the camera",
      "How do I change the email address on my account?",
      "My package says delivered but it never arrived",
      "Can I get a refund if I cancel within the first week?",
      "The password reset link in the email has expired",
      "Video calls keep dropping when I switch to mobile data",
      "Please add a dark mode, the white screen hurts my eyes at night",
      "I can't find where to download my invoices",
      "The order arrived damaged and the box was soaked",
      "Two-factor codes are not arriving by text message",
      "How do I invite my teammates to the workspace?",
      "Export to CSV is missing half of the columns",
      "I want to delete my account and all my data",
      "The checkout page won't accept my card",
      "Notifications stopped working after the latest update",
    ],
  },
  films: {
    label: "Films",
    queries: ["an animated movie about food", "surviving alone in space", "a murder mystery with a twist"],
    documents: [
      "Arrival — a linguist learns to talk with visitors whose language reshapes how she experiences time",
      "The Grand Budapest Hotel — a concierge and his lobby boy are framed for murder in a mountain hotel",
      "Spirited Away — a girl works in a bathhouse for spirits to free her parents from a curse",
      "Mad Max: Fury Road — a desperate chase across a desert wasteland in armored trucks",
      "Ratatouille — a rat with a gift for cooking helps a young man become a chef in Paris",
      "Interstellar — astronauts travel through a wormhole searching for a new home for humanity",
      "Paddington — a polite bear from Peru finds a family in London",
      "Whiplash — a young drummer is pushed to his limits by a ruthless music teacher",
      "Jaws — a shark terrorizes a beach town and three men set out to hunt it",
      "Coco — a boy crosses into the Land of the Dead to uncover his family's musical past",
      "The Martian — a stranded astronaut grows potatoes to survive alone on Mars",
      "Knives Out — a detective untangles a wealthy family's lies after a novelist's death",
      "Up — an elderly widower ties balloons to his house and flies to South America",
      "Parasite — a poor family schemes its way into jobs with a wealthy household",
      "Top Gun: Maverick — a veteran pilot trains young aviators for a dangerous mission",
      "My Octopus Teacher — a filmmaker befriends an octopus in a kelp forest",
    ],
  },
} as const;
type SampleKey = keyof typeof SAMPLES;

const MAX_DOCUMENTS = 200;
const PREFERRED = [
  "local/BAAI/bge-small-en-v1.5",
  "local/sentence-transformers/all-MiniLM-L6-v2",
  "openai/text-embedding-3-small",
  "cohere/embed-v4.0",
  "voyage/voyage-3.5",
  "google/gemini-embedding-001",
];

const keyOf = (m: { provider: string; id: string }) => `${m.provider}/${m.id}`;
const splitKey = (key: string) => ({ provider: key.slice(0, key.indexOf("/")), model: key.slice(key.indexOf("/") + 1) });

function CompareModels() {
  const { can } = useSession();
  const canWrite = can("write");
  const catalog = useEmbeddingCatalog();
  const [sample, setSample] = useState<SampleKey>("products");
  const [docsText, setDocsText] = useState<string>(SAMPLES.products.documents.join("\n"));
  const [query, setQuery] = useState<string>(SAMPLES.products.queries[0]);
  const [picked, setPicked] = useState<string[]>([]);
  const [topK, setTopK] = useState("5");
  const [results, setResults] = useState<CompareResult[]>();
  const [rankedDocs, setRankedDocs] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [hover, setHover] = useState<number | null>(null);
  const seq = useRef(0);

  const documents = useMemo(() => docsText.split("\n").map((line) => line.trim()).filter(Boolean), [docsText]);
  const tooMany = documents.length > MAX_DOCUMENTS;
  const ready = useMemo(() => new Set((catalog?.providers ?? []).filter((p) => p.available).map((p) => p.id)), [catalog]);

  // Start with two models the server can actually run.
  useEffect(() => {
    if (!catalog || picked.length) return;
    const runnable = catalog.models.filter((m) => ready.has(m.provider)).map(keyOf);
    const choice = [...PREFERRED.filter((k) => runnable.includes(k)), ...runnable]
      .filter((k, i, all) => all.indexOf(k) === i)
      .slice(0, 2);
    setPicked(choice.length ? choice : catalog.models.slice(0, 1).map(keyOf));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog]);

  useEffect(() => {
    const text = query.trim();
    if (!canWrite || !text || !documents.length || tooMany || !picked.length) return;
    const id = ++seq.current;
    const timer = window.setTimeout(async () => {
      setBusy(true);
      try {
        const res = await api.compareModels({ query: text, documents, models: picked.map(splitKey), topK: Number(topK) });
        if (id !== seq.current) return;
        setResults(res.results);
        setRankedDocs(documents);
        setError(undefined);
      } catch (err) {
        if (id === seq.current) setError((err as Error).message);
      } finally {
        if (id === seq.current) setBusy(false);
      }
    }, 450);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, documents, picked.join("|"), topK, canWrite, tooMany]);

  if (!canWrite) {
    return (
      <Card>
        <Empty icon={<IconSparkles size={24} />} title="Comparing models needs a write key">
          Comparisons send text to embedding providers and use their credits, so they need a key with write access. Searching an index works with any key.
        </Empty>
      </Card>
    );
  }

  const nextModel = () => {
    const all = (catalog?.models ?? []).map(keyOf);
    return all.find((k) => !picked.includes(k) && ready.has(splitKey(k).provider)) ?? all.find((k) => !picked.includes(k));
  };
  const baselineName = results?.[0] ? catalog?.models.find((m) => keyOf(m) === `${results[0].provider}/${results[0].model}`)?.name ?? results[0].model : "";

  return (
    <div className="cmp">
      <Card className="cmp-docs" icon={<IconRows size={16} />} title="Documents"
        subtitle={`${fmtInt(documents.length)} of ${MAX_DOCUMENTS} · one per line`}>
        <div className="stack tight">
          <Choice label="Sample set" value={sample} options={(Object.keys(SAMPLES) as SampleKey[]).map((k) => ({ value: k, label: SAMPLES[k].label }))}
            onChange={(k) => {
              setSample(k);
              setDocsText(SAMPLES[k].documents.join("\n"));
              setQuery(SAMPLES[k].queries[0]);
            }} />
          <textarea className="cmp-textarea" spellCheck={false} wrap="off" value={docsText} aria-label="Documents, one per line"
            onChange={(e) => setDocsText(e.target.value)} />
          {tooMany && <div className="note note-warn">Keep it to {MAX_DOCUMENTS} documents.</div>}
          <p className="muted small">Paste your own text to see how each model handles it. Nothing is stored; embeddings are kept in memory briefly so you can keep typing.</p>
        </div>
      </Card>

      <div className="stack">
        <Card>
          <div className="pg-input">
            {busy ? <span className="spinner dark" aria-label="Comparing" /> : <IconSearch size={20} />}
            <input value={query} aria-label="Search" placeholder="Search in your own words" onChange={(e) => setQuery(e.target.value)} />
            {query && <IconButton label="Clear search" onClick={() => setQuery("")}><IconX size={16} /></IconButton>}
          </div>
          <div className="cmp-suggest">
            <span>Try</span>
            {SAMPLES[sample].queries.map((q) => (
              <button key={q} type="button" className={q === query ? "on" : ""} onClick={() => setQuery(q)}>{q}</button>
            ))}
          </div>
          <div className="cmp-models">
            {picked.map((key, slot) => (
              <ModelSlot key={`${slot}-${key}`} value={key} catalog={catalog}
                onChange={(v) => setPicked((p) => p.map((x, i) => (i === slot ? v : x)))}
                onRemove={picked.length > 1 ? () => setPicked((p) => p.filter((_, i) => i !== slot)) : undefined} />
            ))}
            {picked.length < 3 && catalog && (
              <Button size="sm" icon={<IconPlus size={15} />} onClick={() => {
                const next = nextModel();
                if (next) setPicked((p) => [...p, next]);
              }}>Add model</Button>
            )}
            <select className="cmp-topk" aria-label="Results per model" value={topK} onChange={(e) => setTopK(e.target.value)}>
              {["3", "5", "10"].map((n) => <option key={n} value={n}>Top {n}</option>)}
            </select>
          </div>
        </Card>

        <ErrorNote error={error} />

        {results ? (
          <div className="cmp-columns" style={{ gridTemplateColumns: `repeat(${results.length}, minmax(0, 1fr))` }}>
            {results.map((r, col) => (
              <CompareColumn key={`${col}-${r.provider}/${r.model}`} result={r} documents={rankedDocs} catalog={catalog}
                baseline={col > 0 ? results[0] : undefined} baselineName={baselineName} hover={hover} onHover={setHover} />
            ))}
          </div>
        ) : (
          <div className="cmp-columns" style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}>
            <Skeleton height={360} radius={16} /><Skeleton height={360} radius={16} />
          </div>
        )}
      </div>
    </div>
  );
}

function ModelSlot({ value, catalog, onChange, onRemove }: {
  value: string;
  catalog?: EmbeddingCatalog;
  onChange: (key: string) => void;
  onRemove?: () => void;
}) {
  const model = catalog?.models.find((m) => keyOf(m) === value);
  return (
    <div className="cmp-slot">
      <BrandLogo vendor={model?.vendor ?? PROVIDER_VENDOR[splitKey(value).provider]} size={16} tile />
      <select aria-label="Embedding model" value={value} onChange={(e) => onChange(e.target.value)}>
        {!catalog && <option value={value}>{value}</option>}
        {catalog?.providers.map((p) => (
          <optgroup key={p.id} label={`${p.name}${p.available ? "" : p.local ? " — install needledb[local]" : " — needs a key"}`}>
            {catalog.models.filter((m) => m.provider === p.id).map((m) => (
              <option key={keyOf(m)} value={keyOf(m)}>{m.name} · {m.dimension}-d</option>
            ))}
          </optgroup>
        ))}
      </select>
      {onRemove && <IconButton label="Remove model" onClick={onRemove}><IconX size={14} /></IconButton>}
    </div>
  );
}

function CompareColumn({ result, documents, catalog, baseline, baselineName, hover, onHover }: {
  result: CompareResult;
  documents: string[];
  catalog?: EmbeddingCatalog;
  baseline?: CompareResult;
  baselineName: string;
  hover: number | null;
  onHover: (index: number | null) => void;
}) {
  const model = catalog?.models.find((m) => m.provider === result.provider && m.id === result.model);
  const provider = catalog?.providers.find((p) => p.id === result.provider);
  const matches = result.matches ?? [];
  const baseRank = new Map((baseline?.matches ?? []).map((m, i) => [m.index, i]));
  const shared = baseline?.matches ? matches.filter((m) => baseRank.has(m.index)).length : null;
  const scores = matches.map((m) => m.score);
  const top = scores.length ? Math.max(...scores) : 0;
  const low = scores.length ? Math.min(...scores) : 0;

  return (
    <section className="cmp-col">
      <header className="cmp-head">
        <BrandLogo vendor={model?.vendor ?? PROVIDER_VENDOR[result.provider]} size={20} tile />
        <div>
          <b>{model?.name ?? result.model}</b>
          <span>{result.error ? provider?.name ?? result.provider : `${provider?.local ? "Local" : provider?.name ?? result.provider} · ${fmtInt(result.dimension ?? 0)}-d · ${fmtMs(result.embedMs)}`}</span>
        </div>
      </header>
      {shared != null && !result.error && baseline && !baseline.error && (
        <div className="cmp-agree">Shares {shared} of its top {matches.length} with {baselineName}</div>
      )}
      {result.error ? (
        <div className="note note-warn">{result.error.message}</div>
      ) : (
        <ol className="cmp-list">
          {matches.map((m, rank) => {
            const before = baseRank.get(m.index);
            const move = baseline && !baseline.error ? (before == null ? "new" : before - rank) : null;
            const width = top === low ? 100 : 12 + 88 * ((m.score - low) / (top - low));
            return (
              <li key={m.index} className={hover === m.index ? "hot" : ""} onMouseEnter={() => onHover(m.index)} onMouseLeave={() => onHover(null)}>
                <span className="cmp-rank">{rank + 1}</span>
                <div className="cmp-main">
                  <p>{documents[m.index]}</p>
                  <div className="cmp-scoreline">
                    <div className="bar"><i style={{ width: `${width}%` }} /></div>
                    <b>{m.score.toFixed(3)}</b>
                    {move != null && (
                      <span className={`cmp-move ${move === "new" ? "new" : move > 0 ? "up" : move < 0 ? "down" : ""}`}
                        title={move === "new" ? `Not in ${baselineName}'s top results` : `Rank compared with ${baselineName}`}>
                        {move === "new" ? "New" : move === 0 ? "Same" : move > 0 ? `↑ ${move}` : `↓ ${-move}`}
                      </span>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
