import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { api, type EmbeddingModel, type IndexInfo, type IndexType, type Metric } from "../api";
import { BrandLogo, ModelBadge, PROVIDER_VENDOR, useEmbeddingCatalog } from "../brands";
import { IconCheck, IconGrid, IconIndexes, IconPlus, IconRows, IconSearch, IconSparkles, IconTarget } from "../icons";
import { fmtBytes, fmtInt, go, structureLabel } from "../lib";
import { useSession } from "../session";
import { Badge, Button, Card, Choice, Empty, ErrorNote, Field, IndexAvatar, PageHeader, Segmented, Sheet, Skeleton, useToast } from "../ui";
import IndexCard from "./IndexCard";

const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,43}[a-z0-9])?$/;

// Used when the server can't list its models (an older server).
const FALLBACK_PRESETS = [
  { dimension: 384, label: "MiniLM · BGE small", vendor: "huggingface" },
  { dimension: 768, label: "Nomic · BGE base", vendor: "huggingface" },
  { dimension: 1024, label: "Cohere · Voyage", vendor: "cohere" },
  { dimension: 1536, label: "OpenAI small", vendor: "openai" },
  { dimension: 3072, label: "OpenAI large", vendor: "openai" },
];

const PRESET_KEYS = [
  "openai/text-embedding-3-small",
  "openai/text-embedding-3-large",
  "cohere/embed-v4.0",
  "voyage/voyage-3.5",
  "google/gemini-embedding-001",
  "mistral/mistral-embed",
  "jina/jina-embeddings-v3",
  "local/BAAI/bge-small-en-v1.5",
  "local/nomic-ai/nomic-embed-text-v1.5",
];

const STRUCTURE_HELP: Record<IndexType, string> = {
  auto: "Exact search until 20,000 vectors, then an HNSW graph is built in the background and swapped in. The right default.",
  flat: "Always exact — 100% recall. Best below about 50,000 vectors per namespace.",
  hnsw: "An HNSW graph from the first vector. The fastest option for large collections.",
};

const METRIC_NAME: Record<Metric, string> = { cosine: "cosine", dotproduct: "dot product", euclidean: "euclidean" };
const keyOf = (m: Pick<EmbeddingModel, "provider" | "id">) => `${m.provider}/${m.id}`;

export default function Indexes({ indexes, error, openNew, onChanged }: {
  indexes?: IndexInfo[];
  error?: Error;
  openNew: boolean;
  onChanged: () => void;
}) {
  const { can } = useSession();
  const admin = can("admin");
  const [creating, setCreating] = useState(openNew && admin);
  const [view, setView] = useState<"table" | "cards">("table");
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (openNew && admin) setCreating(true);
  }, [openNew, admin]);

  function close() {
    setCreating(false);
    if (openNew) go("/indexes");
  }

  const shown = (indexes ?? []).filter((i) => i.name.includes(query.trim().toLowerCase()));
  const vectors = (indexes ?? []).reduce((a, i) => a + i.vectorCount, 0);

  return (
    <>
      <PageHeader
        title="Indexes"
        subtitle={indexes ? `${indexes.length} ${indexes.length === 1 ? "index" : "indexes"} · ${fmtInt(vectors)} vectors` : "Each index holds vectors of one dimension and metric."}
        actions={admin && <Button variant="primary" icon={<IconPlus size={17} />} onClick={() => setCreating(true)}>New index</Button>}
      />

      {indexes && indexes.length > 0 && (
        <div className="toolbar">
          <div className="search-field wide">
            <IconSearch size={16} />
            <input aria-label="Search indexes" placeholder="Search indexes" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <Segmented label="View" value={view} onChange={setView} options={[
            { value: "table", label: <><IconRows size={15} /> Table</> },
            { value: "cards", label: <><IconGrid size={15} /> Cards</> },
          ]} />
        </div>
      )}

      {!indexes ? (
        error ? <ErrorNote error={error} /> : <Skeleton height={280} radius={16} />
      ) : indexes.length === 0 ? (
        <Card>
          <Empty icon={<IconIndexes size={24} />} title="No indexes yet"
            action={admin && <Button variant="primary" icon={<IconPlus size={17} />} onClick={() => setCreating(true)}>Create your first index</Button>}>
            An index is where vectors live. Pick an embedding model and send text, or bring vectors of any dimension from 1 to 65,536.
          </Empty>
        </Card>
      ) : view === "table" ? (
        <Card flush>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>Index</th><th>Embedding</th><th className="num">Dimension</th><th>Metric</th><th>Structure</th><th className="num">Vectors</th><th className="num">Memory</th><th className="num">On disk</th><th>Status</th></tr>
              </thead>
              <tbody>
                {shown.map((i) => (
                  <tr key={i.name} className="rowlink" onClick={() => go(`/indexes/${encodeURIComponent(i.name)}`)}>
                    <td>
                      <div className="entity">
                        <IndexAvatar name={i.name} />
                        <div><b>{i.name}</b><span>{i.namespaceCount} {i.namespaceCount === 1 ? "namespace" : "namespaces"}</span></div>
                      </div>
                    </td>
                    <td>{i.embed ? <ModelBadge embed={i.embed} /> : <span className="muted">Your vectors</span>}</td>
                    <td className="num">{i.dimension}</td>
                    <td>{i.metric}</td>
                    <td>{structureLabel(i)}</td>
                    <td className="num">{fmtInt(i.vectorCount)}</td>
                    <td className="num">{fmtBytes(i.memoryBytes)}</td>
                    <td className="num">{fmtBytes(i.storageBytes)}</td>
                    <td><Badge tone={i.status.state === "Ready" ? "good" : "warn"}>{i.status.state === "Ready" ? "Ready" : "Rebuilding"}</Badge></td>
                  </tr>
                ))}
                {shown.length === 0 && <tr><td colSpan={9} className="table-empty">No indexes match “{query}”.</td></tr>}
              </tbody>
            </table>
          </div>
        </Card>
      ) : (
        <div className="index-grid">
          {shown.map((i) => <IndexCard key={i.name} info={i} />)}
          {admin && (
            <button type="button" className="index-card index-card-new" onClick={() => setCreating(true)}>
              <span className="new-plus"><IconPlus size={22} /></span>
              <b>New index</b>
              <span>Built-in embedding models, or any vectors you bring</span>
            </button>
          )}
        </div>
      )}

      <CreateIndexSheet open={creating} onClose={close}
        onCreated={(name) => {
          onChanged();
          setCreating(false);
          go(`/indexes/${encodeURIComponent(name)}`);
        }} />
    </>
  );
}

type Source = "text" | "vectors";

function CreateIndexSheet({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (name: string) => void }) {
  const toast = useToast();
  const catalog = useEmbeddingCatalog();
  const [name, setName] = useState("");
  const [source, setSource] = useState<Source>("text");
  const [providerFilter, setProviderFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [modelKey, setModelKey] = useState("openai/text-embedding-3-small");
  const [outputSize, setOutputSize] = useState<number>();
  const [dimension, setDimension] = useState("1536");
  const [metric, setMetric] = useState<Metric>("cosine");
  const [structure, setStructure] = useState<IndexType>("auto");
  const [advanced, setAdvanced] = useState(false);
  const [m, setM] = useState("32");
  const [efConstruction, setEfConstruction] = useState("200");
  const [efSearch, setEfSearch] = useState("128");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const models = catalog?.models ?? [];
  const providers = catalog?.providers ?? [];
  const model = models.find((x) => keyOf(x) === modelKey);
  const provider = providers.find((p) => p.id === model?.provider);
  const listRef = useRef<HTMLDivElement>(null);

  // Keep the chosen model in view inside the list (without scrolling the sheet itself).
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      const list = listRef.current;
      const row = list?.querySelector<HTMLElement>(".model-row.on");
      if (!list || !row) return;
      const l = list.getBoundingClientRect();
      const r = row.getBoundingClientRect();
      if (r.top < l.top + 44 || r.bottom > l.bottom) list.scrollTop += r.top - l.top - 52;
    });
    return () => cancelAnimationFrame(frame);
  }, [open, catalog, source, modelKey]);

  useEffect(() => {
    if (!open) return;
    setName("");
    setSearch("");
    setError(undefined);
    setBusy(false);
  }, [open]);

  // Start on a model the server can actually run.
  useEffect(() => {
    if (!catalog) return;
    const ready = new Set(catalog.providers.filter((p) => p.available).map((p) => p.id));
    const current = catalog.models.find((x) => keyOf(x) === modelKey);
    if (!current || !ready.has(current.provider)) {
      const first = catalog.models.find((x) => ready.has(x.provider) && x.provider !== "local")
        ?? catalog.models.find((x) => ready.has(x.provider));
      if (first) setModelKey(keyOf(first));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog]);

  const groups = useMemo(() => {
    const needle = search.trim().toLowerCase();
    // Providers the server can use right now come first.
    return [...providers].sort((a, b) => Number(b.available) - Number(a.available))
      .filter((p) => providerFilter === "all" || p.id === providerFilter)
      .map((p) => ({
        provider: p,
        models: models.filter((x) => x.provider === p.id
          && (!needle || `${x.name} ${x.id} ${x.description} ${p.name}`.toLowerCase().includes(needle))),
      }))
      .filter((g) => g.models.length);
  }, [providers, models, providerFilter, search]);

  const textMode = source === "text" && !!catalog;
  const dim = textMode ? outputSize ?? model?.dimension ?? 0 : Number(dimension);
  const nameOk = NAME_RE.test(name);
  const dimOk = Number.isInteger(dim) && dim >= 1 && dim <= 65536;
  const ready = nameOk && dimOk && (!textMode || !!model);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(undefined);
    try {
      const info = await api.createIndex({
        name, dimension: dim, metric, index_type: structure,
        hnsw: { m: Number(m), ef_construction: Number(efConstruction), ef_search: Number(efSearch) },
        ...(textMode && model ? { embed: { provider: model.provider, model: model.id } } : {}),
      });
      toast(`Created ${info.name}`, "good");
      onCreated(info.name);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  const presets = PRESET_KEYS.map((k) => models.find((x) => keyOf(x) === k)).filter((x): x is EmbeddingModel => !!x);

  return (
    <Sheet open={open} onClose={onClose} width={680} title="New index"
      subtitle="Pick how vectors are made. The model, dimension and metric are fixed once the index exists."
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button variant="primary" type="submit" form="create-index" disabled={busy || !ready}>
          {busy ? "Creating…" : "Create index"}
        </Button>
      </>}>
      <form id="create-index" className="form" onSubmit={submit}>
        <Field label="Name" htmlFor="ix-name"
          hint={name && !nameOk ? <span className="bad">Use 1–45 lowercase letters, digits and hyphens.</span> : "Lowercase letters, digits and hyphens. Used in the API path."}>
          <input id="ix-name" value={name} placeholder="products" autoFocus autoComplete="off"
            onChange={(e) => setName(e.target.value.toLowerCase().replace(/\s+/g, "-"))} />
        </Field>

        {catalog && (
          <Field label="Vectors">
            <div className="source-cards" role="radiogroup" aria-label="How vectors are made">
              <button type="button" role="radio" aria-checked={source === "text"} className={`source-card ${source === "text" ? "on" : ""}`}
                onClick={() => setSource("text")}>
                <span className="source-icon"><IconSparkles size={17} /></span>
                <b>Embed text for me</b>
                <span className="source-detail">Upsert plain text and search in natural language. NeedleDB calls the model.</span>
                <span className="source-logos">
                  {["openai", "cohere", "voyage", "gemini", "mistral", "jina", "baai"].map((v) => <BrandLogo key={v} vendor={v} size={14} tile />)}
                </span>
                <span className="option-check">{source === "text" && <IconCheck size={14} />}</span>
              </button>
              <button type="button" role="radio" aria-checked={source === "vectors"} className={`source-card ${source === "vectors" ? "on" : ""}`}
                onClick={() => setSource("vectors")}>
                <span className="source-icon"><IconTarget size={17} /></span>
                <b>Bring my own vectors</b>
                <span className="source-detail">Send vectors from any model or pipeline, at any dimension up to 65,536.</span>
                <span className="option-check">{source === "vectors" && <IconCheck size={14} />}</span>
              </button>
            </div>
          </Field>
        )}

        {textMode ? (
          <>
            <Field label="Embedding model">
              <div className="model-picker">
                <div className="search-field model-search">
                  <IconSearch size={15} />
                  <input aria-label="Search models" placeholder={`Search ${models.length} models`} value={search} onChange={(e) => setSearch(e.target.value)} />
                </div>
                <div className="model-filters" role="group" aria-label="Provider">
                  <button type="button" className={`all ${providerFilter === "all" ? "on" : ""}`} onClick={() => setProviderFilter("all")}>All</button>
                  {providers.map((p) => (
                    <button key={p.id} type="button" className={providerFilter === p.id ? "on" : ""} onClick={() => setProviderFilter(p.id)}>
                      <BrandLogo vendor={PROVIDER_VENDOR[p.id]} size={14} />{p.local ? "Local" : p.name}
                    </button>
                  ))}
                </div>
                <div className="model-list" ref={listRef} role="radiogroup" aria-label="Embedding model">
                  {groups.map((g) => (
                    <div key={g.provider.id} className="model-group">
                      <div className="model-group-head">
                        <BrandLogo vendor={PROVIDER_VENDOR[g.provider.id]} size={15} />
                        <b>{g.provider.name}</b>
                        <span className={`key-state ${g.provider.available ? "ok" : ""}`}>
                          {g.provider.available ? (g.provider.local ? "Installed" : "Key set")
                            : g.provider.local ? "Needs needledb[local]" : "Needs a key"}
                        </span>
                      </div>
                      {g.models.map((x) => {
                        const on = keyOf(x) === modelKey;
                        return (
                          <button key={keyOf(x)} type="button" role="radio" aria-checked={on} className={`model-row ${on ? "on" : ""}`}
                            onClick={() => {
                              setModelKey(keyOf(x));
                              setOutputSize(undefined);
                            }}>
                            <BrandLogo vendor={x.vendor} size={18} tile />
                            <span className="model-text">
                              <b>{x.name}</b>
                              <span>{x.description}</span>
                            </span>
                            <span className="model-meta">
                              <span className="model-dim">{fmtInt(x.dimension)}-d</span>
                              <span>{x.sizeMb ? `${x.sizeMb >= 1000 ? `${(x.sizeMb / 1000).toFixed(1)} GB` : `${x.sizeMb} MB`}` : x.multilingual ? "Multilingual" : `${fmtInt(x.maxTokens)} tokens`}</span>
                            </span>
                            <span className="model-check">{on && <IconCheck size={13} />}</span>
                          </button>
                        );
                      })}
                    </div>
                  ))}
                  {!groups.length && <div className="model-empty">No models match “{search}”.</div>}
                </div>
              </div>
            </Field>

            {model && model.dimensions.length > 1 && (
              <Field label="Output size" hint="Smaller vectors use less memory and search faster, at a small cost in accuracy.">
                <Choice label="Output size" value={String(dim)} onChange={(v) => setOutputSize(Number(v))}
                  options={model.dimensions.map((d) => ({ value: String(d), label: `${fmtInt(d)}${d === model.dimension ? " · default" : ""}` }))} />
              </Field>
            )}

            {model && provider && !provider.available && (
              <div className="note note-warn">
                {provider.local
                  ? <>Local models need <code>pip install "needledb[local]"</code> on the server. You can create the index now.</>
                  : <>{provider.name} needs an API key before it can embed text. You can create the index now and <a className="link" href={`#/settings?provider=${provider.id}`}>add the key in Settings</a>.</>}
              </div>
            )}
            {model && provider?.local && provider.available && model.sizeMb && (
              <p className="muted small">Downloads {model.sizeMb >= 1000 ? `${(model.sizeMb / 1000).toFixed(1)} GB` : `${model.sizeMb} MB`} the first time it runs, then embeds on this server's CPU.</p>
            )}
          </>
        ) : (
          <Field label="Dimension" htmlFor="ix-dim" hint={dimOk ? "Must match the model that makes your vectors." : <span className="bad">Choose a whole number from 1 to 65,536.</span>}>
            <input id="ix-dim" type="number" min={1} max={65536} value={dimension} onChange={(e) => setDimension(e.target.value)} />
            <div className="preset-models">
              {presets.length
                ? presets.map((x) => (
                  <button key={keyOf(x)} type="button" className={dim === x.dimension ? "on" : ""} title={`${x.name}: ${x.dimension} dimensions`}
                    onClick={() => setDimension(String(x.dimension))}>
                    <BrandLogo vendor={x.vendor} size={14} /><b>{x.dimension}</b>{x.name}
                  </button>
                ))
                : FALLBACK_PRESETS.map((p) => (
                  <button key={p.dimension} type="button" className={dim === p.dimension ? "on" : ""} onClick={() => setDimension(String(p.dimension))}>
                    <BrandLogo vendor={p.vendor} size={14} /><b>{p.dimension}</b>{p.label}
                  </button>
                ))}
            </div>
          </Field>
        )}

        <Field label="Metric" hint={textMode ? "Embedding models are trained for cosine similarity." : undefined}>
          <Choice label="Metric" value={metric} onChange={setMetric} options={[
            { value: "cosine", label: "Cosine" },
            { value: "dotproduct", label: "Dot product" },
            { value: "euclidean", label: "Euclidean" },
          ]} />
        </Field>

        <Field label="Structure" hint={STRUCTURE_HELP[structure]}>
          <Choice label="Structure" value={structure} onChange={setStructure} options={[
            { value: "auto", label: "Auto" },
            { value: "flat", label: "Flat" },
            { value: "hnsw", label: "HNSW" },
          ]} />
        </Field>

        {structure !== "flat" && (
          <div className="disclosure">
            <button type="button" className="disclosure-toggle" aria-expanded={advanced} onClick={() => setAdvanced((a) => !a)}>
              {advanced ? "Hide" : "Show"} graph settings
            </button>
            {advanced && (
              <div className="form-row three">
                <Field label="m" htmlFor="ix-m" hint="Links per node">
                  <input id="ix-m" type="number" min={4} max={128} value={m} onChange={(e) => setM(e.target.value)} />
                </Field>
                <Field label="ef_construction" htmlFor="ix-efc" hint="Build width">
                  <input id="ix-efc" type="number" min={16} max={2000} value={efConstruction} onChange={(e) => setEfConstruction(e.target.value)} />
                </Field>
                <Field label="ef_search" htmlFor="ix-efs" hint="Query width">
                  <input id="ix-efs" type="number" min={1} max={10000} value={efSearch} onChange={(e) => setEfSearch(e.target.value)} />
                </Field>
              </div>
            )}
          </div>
        )}

        <div className="create-summary">
          {textMode && model ? <BrandLogo vendor={model.vendor} size={20} tile /> : <span className="summary-icon"><IconTarget size={18} /></span>}
          <div>
            <b>{name || "Untitled index"}</b>
            <span>
              {dimOk ? `${fmtInt(dim)} dimensions` : "Dimension needed"} · {METRIC_NAME[metric]} · {structure === "auto" ? "Auto" : structure === "flat" ? "Flat" : "HNSW"}
              {textMode && model ? ` · ${model.name}` : " · your vectors"}
            </span>
          </div>
        </div>
        <ErrorNote error={error} />
      </form>
    </Sheet>
  );
}
