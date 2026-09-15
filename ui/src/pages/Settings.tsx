import { type FormEvent, useEffect, useState } from "react";
import { api, type ProviderCheck, type ProviderSetting } from "../api";
import { BrandLogo, PROVIDER_VENDOR, refreshEmbeddingCatalog } from "../brands";
import { IconCheck, IconExternal, IconEye, IconEyeOff, IconLock, IconSparkles } from "../icons";
import { fmtRelative, go, usePoll } from "../lib";
import { useSession } from "../session";
import { Badge, Button, Card, Empty, ErrorNote, Field, IconButton, PageHeader, Sheet, Skeleton, useToast } from "../ui";

const KEY_PAGES: Record<string, string> = {
  openai: "https://platform.openai.com/api-keys",
  cohere: "https://dashboard.cohere.com/api-keys",
  voyage: "https://dashboard.voyageai.com/",
  google: "https://aistudio.google.com/apikey",
  mistral: "https://console.mistral.ai/api-keys",
  jina: "https://jina.ai/api-dashboard",
};

const USED_FOR: Record<string, string> = {
  openai: "text-embedding-3 small and large, and ada-002",
  cohere: "Embed v4 and the v3 models",
  voyage: "voyage-3.5, voyage-3-large and the domain models",
  google: "gemini-embedding-001",
  mistral: "mistral-embed and codestral-embed",
  jina: "jina-embeddings-v3",
  local: "BGE, MiniLM, Nomic, Arctic, mxbai and E5",
};

type Check = ProviderCheck | "running";

export default function Settings({ params }: { params: URLSearchParams }) {
  const { can } = useSession();
  const toast = useToast();
  const admin = can("admin");
  const { data, error, reload } = usePoll(() => (admin ? api.providerSettings() : Promise.resolve({ providers: [] as ProviderSetting[] })), 30000, [admin]);
  const [editing, setEditing] = useState<ProviderSetting>();
  const [checks, setChecks] = useState<Record<string, Check>>({});
  const requested = params.get("provider");

  // Links like #/settings?provider=openai open that provider's key sheet.
  useEffect(() => {
    if (!requested || !data) return;
    const provider = data.providers.find((p) => p.id === requested && !p.local && p.source !== "environment");
    if (provider) setEditing(provider);
  }, [requested, data]);

  if (!admin) {
    return (
      <>
        <PageHeader title="Settings" />
        <Card>
          <Empty icon={<IconLock size={22} />} title="Only admins can change settings">
            Provider keys and server settings are managed by admins. Ask one to add the key you need.
          </Empty>
        </Card>
      </>
    );
  }

  async function test(provider: ProviderSetting) {
    setChecks((c) => ({ ...c, [provider.id]: "running" }));
    try {
      const result = await api.testProvider(provider.id);
      setChecks((c) => ({ ...c, [provider.id]: result }));
    } catch (err) {
      setChecks((c) => ({ ...c, [provider.id]: { ok: false, message: (err as Error).message } }));
    }
  }

  async function remove(provider: ProviderSetting) {
    try {
      await api.removeProviderKey(provider.id);
      toast(`Removed the ${provider.name} key`);
      setChecks((c) => {
        const next = { ...c };
        delete next[provider.id];
        return next;
      });
      refreshEmbeddingCatalog();
      void reload();
    } catch (err) {
      toast((err as Error).message, "bad");
    }
  }

  function closeSheet() {
    setEditing(undefined);
    if (requested) go("/settings");
  }

  return (
    <>
      <PageHeader title="Settings" subtitle="Configure this server. Changes apply right away, with no restart." />

      <Card icon={<IconSparkles size={16} />} title="Embedding providers"
        subtitle="API keys for hosted embedding models, used for text search, text upserts and the playground." flush>
        {!data ? (
          error ? <ErrorNote error={error} /> : <div className="stack tight pad">{[0, 1, 2].map((i) => <Skeleton key={i} height={68} radius={12} />)}</div>
        ) : (
          <ul className="providers">
            {data.providers.map((p) => {
              const check = checks[p.id];
              return (
                <li key={p.id} className="provider-row">
                  <BrandLogo vendor={PROVIDER_VENDOR[p.id]} size={22} tile />
                  <div className="provider-main">
                    <div className="provider-title">
                      <b>{p.local ? "Local models" : p.name}</b>
                      {p.local
                        ? <Badge tone={p.available ? "good" : "neutral"} dot={p.available}>{p.available ? "Installed" : "Not installed"}</Badge>
                        : p.source === "environment" ? <Badge tone="good" dot>From environment</Badge>
                          : p.source === "app" ? <Badge tone="good" dot>Connected</Badge>
                            : <Badge>Not set</Badge>}
                    </div>
                    <p>
                      {p.local
                        ? p.available
                          ? <>{USED_FOR.local} run on this server's CPU. No key needed.</>
                          : <>Run {USED_FOR.local} on this server with <code>pip install "needledb[local]"</code>.</>
                        : p.source === "environment"
                          ? <>Set in the server's environment ({p.env.join(" or ")}). Change it there.</>
                          : p.saved
                            ? <>Key ending <b>{p.saved.hint}</b> · added {fmtRelative(p.saved.setAt).toLowerCase()}{p.saved.setBy ? ` by ${p.saved.setBy}` : ""}.</>
                            : <>Add a key to use {USED_FOR[p.id]}.</>}
                    </p>
                    {check && check !== "running" && (
                      <p className={`provider-check ${check.ok ? "ok" : "bad"}`}>
                        {check.ok ? <><IconCheck size={13} />Working · answered in {Math.round(check.latencyMs ?? 0)} ms</> : check.message}
                      </p>
                    )}
                  </div>
                  <div className="provider-actions">
                    {!p.local && p.available && (
                      <Button size="sm" onClick={() => void test(p)} disabled={check === "running"}>{check === "running" ? "Testing…" : "Test"}</Button>
                    )}
                    {!p.local && p.source !== "environment" && (
                      <Button size="sm" variant={p.saved ? "secondary" : "primary"} onClick={() => setEditing(p)}>{p.saved ? "Replace key" : "Add key"}</Button>
                    )}
                    {p.source === "app" && <Button size="sm" variant="danger" onClick={() => void remove(p)}>Remove</Button>}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <div className="settings-note">
        <IconLock size={16} />
        <span>
          Keys are stored on this server in <code>_system/providers.json</code>, readable only by the account the server runs as.
          They're never sent back to the browser: admins can replace or remove a key, but nobody can read it. A key set in the
          server's environment takes precedence, and changes are recorded in the audit log.
        </span>
      </div>

      <KeySheet provider={editing} onClose={closeSheet}
        onSaved={(provider, latencyMs) => {
          toast(`${provider.name} key saved`, "good");
          setChecks((c) => ({ ...c, [provider.id]: latencyMs != null ? { ok: true, latencyMs } : c[provider.id] }));
          closeSheet();
          refreshEmbeddingCatalog();
          void reload();
        }} />
    </>
  );
}

function KeySheet({ provider, onClose, onSaved }: {
  provider?: ProviderSetting;
  onClose: () => void;
  onSaved: (provider: ProviderSetting, latencyMs?: number) => void;
}) {
  const [key, setKey] = useState("");
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();

  useEffect(() => {
    setKey("");
    setReveal(false);
    setFailure(undefined);
    setBusy(false);
  }, [provider?.id]);

  if (!provider) return null;

  async function save(skipCheck: boolean) {
    if (!provider) return;
    const value = key.trim();
    if (!value) return;
    setBusy(true);
    setFailure(undefined);
    try {
      let latencyMs: number | undefined;
      if (!skipCheck) {
        const result = await api.testProvider(provider.id, value);
        if (!result.ok) {
          setFailure(result.message ?? "The key didn't work.");
          return;
        }
        latencyMs = result.latencyMs;
      }
      onSaved(await api.setProviderKey(provider.id, value), latencyMs);
    } catch (err) {
      setFailure((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const page = KEY_PAGES[provider.id];
  return (
    <Sheet open onClose={onClose} title={`${provider.saved ? "Replace" : "Add"} ${provider.name} key`}
      subtitle="NeedleDB checks the key with one tiny embedding request, then saves it on the server."
      footer={<>
        <Button onClick={onClose}>Cancel</Button>
        {failure && <Button variant="danger" onClick={() => void save(true)} disabled={busy || !key.trim()}>Save anyway</Button>}
        <Button variant="primary" type="submit" form="provider-key" disabled={busy || !key.trim()}>{busy ? "Checking…" : "Test and save"}</Button>
      </>}>
      <form id="provider-key" className="form" onSubmit={(e: FormEvent) => {
        e.preventDefault();
        void save(false);
      }}>
        <div className="key-provider">
          <BrandLogo vendor={PROVIDER_VENDOR[provider.id]} size={24} tile />
          <div>
            <b>{provider.name}</b>
            <span>Used for {USED_FOR[provider.id]}</span>
          </div>
        </div>
        <Field label="API key" htmlFor="provider-key-input"
          hint={page && <>Create one at <a className="link" href={page} target="_blank" rel="noreferrer">{new URL(page).host} <IconExternal size={11} /></a></>}>
          <div className="key-input">
            <input id="provider-key-input" type={reveal ? "text" : "password"} autoFocus autoComplete="off" spellCheck={false}
              placeholder="Paste the key" value={key} onChange={(e) => setKey(e.target.value)} />
            <IconButton label={reveal ? "Hide key" : "Show key"} onClick={() => setReveal((r) => !r)}>
              {reveal ? <IconEyeOff size={18} /> : <IconEye size={18} />}
            </IconButton>
          </div>
        </Field>
        {failure && <div className="note note-bad">{failure}</div>}
        {provider.saved && <p className="muted small">This replaces the key ending {provider.saved.hint}.</p>}
      </form>
    </Sheet>
  );
}
