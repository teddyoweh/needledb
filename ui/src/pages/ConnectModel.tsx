import { useEffect, useMemo, useState } from "react";
import { api, type EmbedConfig, type IndexInfo } from "../api";
import { BrandLogo, ModelBadge, PROVIDER_VENDOR, useEmbeddingCatalog } from "../brands";
import { IconAlert, IconCheck, IconSparkles } from "../icons";
import { fmtInt } from "../lib";
import { useSession } from "../session";
import { Button, Card, ErrorNote, Field, Skeleton, useToast } from "../ui";

const TEXT_FIELDS = ["text", "content", "chunk_text", "body", "summary", "description", "passage", "document", "title"];
const keyOf = (m: { provider: string; id: string }) => `${m.provider}/${m.id}`;

/** Text metadata fields on a sample of records, longest first: where the source text probably lives. */
function useTextFields(name: string) {
  const [fields, setFields] = useState<string[]>();
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const page = await api.list(name, { namespace: "", limit: 20 });
        const ids = page.vectors.map((v) => v.id);
        const found = new Map<string, number>();
        if (ids.length) {
          const res = await api.fetch(name, ids, "", false);
          for (const record of Object.values(res.vectors)) {
            for (const [field, value] of Object.entries(record.metadata ?? {})) {
              if (typeof value === "string") found.set(field, Math.max(found.get(field) ?? 0, value.length));
            }
          }
        }
        if (live) setFields([...found.entries()].sort((a, b) => b[1] - a[1]).map(([field]) => field));
      } catch {
        if (live) setFields([]);
      }
    })();
    return () => {
      live = false;
    };
  }, [name]);
  return fields;
}

/** Pick the model that made an index's vectors, so the index can be searched by text. */
export function ConnectModel({ info, current, onConnected }: {
  info: IndexInfo;
  current?: EmbedConfig | null;
  onConnected: (next: IndexInfo) => void;
}) {
  const { can } = useSession();
  const toast = useToast();
  const catalog = useEmbeddingCatalog();
  const fields = useTextFields(info.name);
  const [choice, setChoice] = useState(current ? `${current.provider}/${current.model}` : "");
  const [field, setField] = useState(current?.field ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const compatible = useMemo(
    () => (catalog?.models ?? []).filter((m) => m.dimensions.includes(info.dimension)),
    [catalog, info.dimension],
  );
  const model = compatible.find((m) => keyOf(m) === choice);
  const provider = catalog?.providers.find((p) => p.id === model?.provider);

  useEffect(() => {
    if (field || !fields) return;
    setField(TEXT_FIELDS.find((f) => fields.includes(f)) ?? fields[0] ?? "text");
  }, [fields, field]);

  async function connect() {
    if (!model) return;
    setBusy(true);
    setError(undefined);
    try {
      const next = await api.setEmbedding(info.name, { provider: model.provider, model: model.id, field: field || "text" });
      toast(`${info.name} now searches with ${model.name}`, "good");
      onConnected(next);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!catalog || !fields) return <Skeleton height={220} radius={14} />;

  if (!compatible.length) {
    return (
      <p className="muted">
        No built-in model makes {fmtInt(info.dimension)}-dimensional vectors, so this index can't be searched by text.
        Search it by vector or by stored record from its Query tab.
      </p>
    );
  }

  const fieldOptions = fields.length ? fields : ["text"];

  return (
    <div className="connect">
      <div className="connect-warning">
        <IconAlert size={16} />
        <span>Pick the model that <b>created</b> these vectors. Every model places text differently, so searching with any other model returns results that look random.</span>
      </div>

      <div className="model-list connect-list" role="radiogroup" aria-label="Embedding model">
        {catalog.providers.map((p) => {
          const models = compatible.filter((m) => m.provider === p.id);
          if (!models.length) return null;
          return (
            <div key={p.id} className="model-group">
              <div className="model-group-head">
                <BrandLogo vendor={PROVIDER_VENDOR[p.id]} size={15} />
                <b>{p.name}</b>
                <span className={`key-state ${p.available ? "ok" : ""}`}>
                  {p.available ? (p.local ? "Installed" : "Key set") : p.local ? "Needs needledb[local]" : "Needs a key"}
                </span>
              </div>
              {models.map((m) => {
                const on = keyOf(m) === choice;
                return (
                  <button key={keyOf(m)} type="button" role="radio" aria-checked={on} className={`model-row ${on ? "on" : ""}`}
                    onClick={() => setChoice(keyOf(m))}>
                    <BrandLogo vendor={m.vendor} size={18} tile />
                    <span className="model-text">
                      <b>{m.name}</b>
                      <span>{m.description}</span>
                    </span>
                    <span className="model-meta">
                      <span className="model-dim">{fmtInt(info.dimension)}-d</span>
                      <span>{m.dimension === info.dimension ? "native size" : "shortened output"}</span>
                    </span>
                    <span className="model-check">{on && <IconCheck size={13} />}</span>
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>

      <Field label="Text shown in results" htmlFor={`connect-field-${info.name}`}
        hint="The metadata field that holds each record's text. New text upserts are stored here too.">
        <select id={`connect-field-${info.name}`} value={field} onChange={(e) => setField(e.target.value)}>
          {fieldOptions.map((f) => <option key={f} value={f}>{f}</option>)}
        </select>
      </Field>

      {model && provider && !provider.available && (
        <div className="note note-warn">
          {provider.local
            ? <>This model runs locally and needs <code>pip install "needledb[local]"</code> on the server.</>
            : <>Searching with {model.name} needs a {provider.name} API key. You can connect it now and <a className="link" href={`#/settings?provider=${provider.id}`}>add the key</a> after.</>}
        </div>
      )}
      <ErrorNote error={error} />

      <div className="actions-end">
        {!can("admin") && <span className="muted small">Only admins can connect a model.</span>}
        <Button variant="primary" icon={<IconSparkles size={16} />} disabled={!model || busy || !can("admin")} onClick={() => void connect()}>
          {busy ? "Connecting…" : model ? `Use ${model.name}` : "Choose a model"}
        </Button>
      </div>
    </div>
  );
}

/** The Settings card: which model an index searches with, and a way to change it. */
export function EmbeddingSettings({ info, onSaved }: { info: IndexInfo; onSaved: (next: IndexInfo) => void }) {
  const { can } = useSession();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string>();

  async function disconnect() {
    try {
      onSaved(await api.setEmbedding(info.name, null));
      toast(`Disconnected the model from ${info.name}`);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <Card icon={<IconSparkles size={16} />} title="Embedding model"
      subtitle={info.embed
        ? "Text in searches and upserts is embedded with this model."
        : "Connect the model that made this index's vectors to search it in plain language."}
      actions={info.embed && !editing && can("admin") && (
        <>
          <Button size="sm" onClick={() => setEditing(true)}>Change</Button>
          <Button size="sm" variant="danger" onClick={() => void disconnect()}>Disconnect</Button>
        </>
      )}>
      {info.embed && !editing ? (
        <div className="connect-current">
          <ModelBadge embed={info.embed} size={18} />
          <span className="muted small">Text field <code>{info.embed.field}</code></span>
        </div>
      ) : (
        <ConnectModel info={info} current={info.embed} onConnected={(next) => {
          setEditing(false);
          onSaved(next);
        }} />
      )}
      <ErrorNote error={error} />
    </Card>
  );
}
