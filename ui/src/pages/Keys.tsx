import { type FormEvent, useEffect, useState } from "react";
import { api, type ApiKey, type IndexInfo, type Role } from "../api";
import { IconCheck, IconKey, IconLock, IconPlus, IconTrash } from "../icons";
import { ROLE_LABEL, fmtRelative, go, usePoll } from "../lib";
import { Badge, Button, Card, Choice, CopyButton, Empty, ErrorNote, Field, PageHeader, Sheet, Skeleton, useToast } from "../ui";

const ROLES: { value: Role; title: string; detail: string }[] = [
  { value: "read", title: "Read", detail: "Query, fetch, list and read stats." },
  { value: "write", title: "Read & write", detail: "Everything in Read, plus upsert, update and delete." },
  { value: "admin", title: "Admin", detail: "Everything, including creating indexes and managing keys." },
];

export default function Keys({ openNew, indexes }: { openNew: boolean; indexes: IndexInfo[] }) {
  const toast = useToast();
  const { data, error, reload } = usePoll(api.keys, 20000);
  const [creating, setCreating] = useState(openNew);
  const [confirming, setConfirming] = useState<string>();

  useEffect(() => {
    if (openNew) setCreating(true);
  }, [openNew]);

  async function revoke(key: ApiKey) {
    if (confirming !== key.id) {
      setConfirming(key.id);
      return;
    }
    try {
      await api.revokeKey(key.id);
      toast(`Revoked “${key.name}”`, "good");
      setConfirming(undefined);
      void reload();
    } catch (err) {
      toast((err as Error).message, "bad");
    }
  }

  const keys = data?.keys ?? [];

  return (
    <>
      <PageHeader title="API Keys"
        subtitle="Keys authenticate the SDK, the Pinecone client and this app. Each is shown once, and only a hash is stored."
        actions={<Button variant="primary" icon={<IconPlus size={17} />} onClick={() => setCreating(true)}>Create key</Button>} />

      {!data ? (
        error ? <ErrorNote error={error} /> : <Skeleton height={260} radius={22} />
      ) : (
        <Card flush>
          {keys.length === 0 ? (
            <Empty icon={<IconKey size={22} />} title="No keys yet">Create a key for each app or teammate, so you can revoke one without touching the rest.</Empty>
          ) : (
            <div className="table-wrap">
              <table className="table keys-table">
                <thead>
                  <tr><th>Name</th><th>Key</th><th>Access</th><th>Indexes</th><th>Created</th><th>Last used</th><th /></tr>
                </thead>
                <tbody>
                  {keys.map((k) => (
                    <tr key={k.id} onMouseLeave={() => confirming === k.id && setConfirming(undefined)}>
                      <td>
                        <div className="key-name">
                          <span className={`key-glyph ${k.managed ? "" : "env"}`}>{k.managed ? <IconKey size={16} /> : <IconLock size={16} />}</span>
                          <div><b>{k.name}</b><span className="muted mono small">{k.id}</span></div>
                        </div>
                      </td>
                      <td>{k.prefix ? <span className="mono">{k.prefix}…</span> : <span className="muted">NEEDLEDB_API_KEY</span>}</td>
                      <td><Badge tone={k.role === "admin" ? "accent" : "neutral"}>{ROLE_LABEL[k.role]}</Badge></td>
                      <td>{k.indexes ? <span className="mono small">{k.indexes.join(", ")}</span> : <span className="muted">All</span>}</td>
                      <td className="muted">{k.managed ? fmtRelative(k.createdAt) : "—"}</td>
                      <td className="muted">{k.managed ? fmtRelative(k.lastUsedAt) : "—"}</td>
                      <td className="num">
                        {k.managed ? (
                          <Button size="sm" variant={confirming === k.id ? "danger-solid" : "danger"} icon={<IconTrash size={15} />} onClick={() => void revoke(k)}>
                            {confirming === k.id ? "Confirm" : "Revoke"}
                          </Button>
                        ) : <span className="muted small">Set in environment</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      <CreateKeySheet open={creating} indexes={indexes}
        onClose={() => {
          setCreating(false);
          if (openNew) go("/keys");
        }}
        onCreated={() => void reload()} />
    </>
  );
}

function CreateKeySheet({ open, indexes, onClose, onCreated }: {
  open: boolean;
  indexes: IndexInfo[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>("read");
  const [scope, setScope] = useState<"all" | "some">("all");
  const [chosen, setChosen] = useState<string[]>([]);
  const [created, setCreated] = useState<ApiKey & { key: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!open) return;
    setName("");
    setRole("read");
    setScope("all");
    setChosen([]);
    setCreated(undefined);
    setError(undefined);
  }, [open]);

  const scoped = role !== "admin" && scope === "some";
  const valid = name.trim().length > 0 && (!scoped || chosen.length > 0);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(undefined);
    try {
      setCreated(await api.createKey({ name: name.trim(), role, indexes: scoped ? chosen : undefined }));
      onCreated();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (created) {
    return (
      <Sheet open={open} onClose={onClose} title="Key created" footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
        <div className="reveal">
          <div className="reveal-icon"><IconCheck size={28} /></div>
          <h3>{created.name}</h3>
          <p>{ROLE_LABEL[created.role]} access{created.indexes ? ` to ${created.indexes.join(", ")}` : " to every index"}.</p>
          <div className="secret">
            <code>{created.key}</code>
            <CopyButton text={created.key} variant="primary" />
          </div>
          <div className="note note-warn">Copy it now. For your security, NeedleDB stores only a hash — this key can't be shown again.</div>
          <pre className="code">{`export NEEDLEDB_API_KEY="${created.key}"\n\nfrom needledb import NeedleDB\ndb = NeedleDB("${window.location.origin}")`}</pre>
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet open={open} onClose={onClose} title="Create API key" subtitle="Give each app or person their own key."
      footer={<>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" type="submit" form="create-key" disabled={busy || !valid}>{busy ? "Creating…" : "Create key"}</Button>
      </>}>
      <form id="create-key" className="form" onSubmit={submit}>
        <Field label="Name" htmlFor="k-name" hint="Something you'll recognise later, like “search-api (prod)”.">
          <input id="k-name" value={name} autoFocus autoComplete="off" maxLength={64} placeholder="search-api" onChange={(e) => setName(e.target.value)} />
        </Field>

        <Field label="Access">
          <div className="options" role="radiogroup" aria-label="Access">
            {ROLES.map((r) => (
              <button key={r.value} type="button" role="radio" aria-checked={role === r.value}
                className={`option ${role === r.value ? "on" : ""}`} onClick={() => setRole(r.value)}>
                <span className="option-title">{r.title}</span>
                <span className="option-check">{role === r.value && <IconCheck size={14} />}</span>
                <span className="option-detail">{r.detail}</span>
              </button>
            ))}
          </div>
        </Field>

        {role !== "admin" && (
          <Field label="Indexes" hint={scope === "some" ? "Other indexes will look like they don't exist to this key." : undefined}>
            <Choice label="Index access" value={scope} onChange={setScope} options={[
              { value: "all", label: "All indexes" },
              { value: "some", label: "Only selected" },
            ]} />
            {scope === "some" && (
              indexes.length ? (
                <div className="check-list">
                  {indexes.map((i) => (
                    <label key={i.name} className="check">
                      <input type="checkbox" checked={chosen.includes(i.name)}
                        onChange={(e) => setChosen((c) => (e.target.checked ? [...c, i.name] : c.filter((x) => x !== i.name)))} />
                      <span className="mono">{i.name}</span>
                      <span className="muted small">{i.dimension}-d</span>
                    </label>
                  ))}
                </div>
              ) : <p className="muted small">There are no indexes to choose from yet.</p>
            )}
          </Field>
        )}
        <ErrorNote error={error} />
      </form>
    </Sheet>
  );
}
