import { type FormEvent, useEffect, useState } from "react";
import { api, type ApiKey, type IndexInfo, type Role } from "../api";
import { IconAlert, IconCheck, IconCopy, IconKey, IconLock, IconMore, IconPlus, IconSearch, IconShield, IconTrash, IconX } from "../icons";
import { ROLE_LABEL, ROLE_RANK, copyText, fmtRelative, go, usePoll } from "../lib";
import { Badge, Button, Card, Choice, CopyButton, Empty, ErrorNote, Field, IconButton, Menu, MenuDivider, MenuItem, PageHeader, Sheet, Skeleton, useToast } from "../ui";

const ROLES: { value: Role; title: string; detail: string }[] = [
  { value: "read", title: "Read", detail: "For search services and dashboards." },
  { value: "write", title: "Read & write", detail: "For ingestion jobs and apps that update data." },
  { value: "admin", title: "Admin", detail: "For operators. Can create indexes and manage keys." },
];

const OPERATIONS: { label: string; needs: Role }[] = [
  { label: "Query, fetch and list vectors", needs: "read" },
  { label: "Read index stats and the vector map", needs: "read" },
  { label: "Upsert, update and delete vectors", needs: "write" },
  { label: "Create, configure and delete indexes", needs: "admin" },
  { label: "Manage API keys and read the audit log", needs: "admin" },
];

const EXPIRY = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "365", label: "1 year" },
  { value: "never", label: "Never" },
] as const;
type Expiry = (typeof EXPIRY)[number]["value"];

const now = () => Date.now() / 1000;
const expired = (k: ApiKey) => k.expiresAt != null && k.expiresAt <= now();

export default function Keys({ openNew, indexes }: { openNew: boolean; indexes: IndexInfo[] }) {
  const toast = useToast();
  const { data, error, reload } = usePoll(api.keys, 20000);
  const [creating, setCreating] = useState(openNew);
  const [confirming, setConfirming] = useState<ApiKey>();
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (openNew) setCreating(true);
  }, [openNew]);

  async function revoke(key: ApiKey) {
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
  const managed = keys.filter((k) => k.managed);
  const shown = keys.filter((k) => `${k.name} ${k.id} ${k.prefix ?? ""} ${k.role}`.toLowerCase().includes(query.trim().toLowerCase()));
  const soon = managed.filter((k) => k.expiresAt != null && !expired(k) && k.expiresAt - now() < 30 * 86400).length;
  const summary = [
    { label: "Active keys", value: keys.filter((k) => !expired(k)).length, hint: `${keys.length - managed.length} from the environment`, tone: "" },
    { label: "Expiring in 30 days", value: soon, hint: soon ? "Rotate before they lapse" : "Nothing due", tone: soon ? "warn" : "" },
    { label: "Never expire", value: managed.filter((k) => k.expiresAt == null).length, hint: "Managed keys without an expiry", tone: "" },
    { label: "Scoped to indexes", value: managed.filter((k) => k.indexes).length, hint: "Limited blast radius", tone: "" },
  ];

  return (
    <>
      <PageHeader title="API Keys"
        subtitle="Keys authenticate the SDK, the Pinecone client and this app. Each is shown once; only a hash is stored."
        actions={<>
          <a className="btn btn-secondary btn-md" href="#/docs/guides/authentication">How keys work</a>
          <Button variant="primary" icon={<IconPlus size={17} />} onClick={() => setCreating(true)}>Create key</Button>
        </>} />

      <div className="mini-stats">
        {summary.map((s) => (
          <div key={s.label} className={`mini-stat ${s.tone}`}>
            <span>{s.label}</span>
            <b>{data ? s.value : "—"}</b>
            <small>{s.hint}</small>
          </div>
        ))}
      </div>

      {!data ? (
        error ? <ErrorNote error={error} /> : <Skeleton height={260} radius={16} />
      ) : (
        <Card icon={<IconKey size={16} />} title="All keys" subtitle="Revoking a key takes effect immediately and ends its sessions" flush
          actions={keys.length > 0 && (
            <div className="search-field">
              <IconSearch size={15} />
              <input aria-label="Search keys" placeholder="Search keys" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
          )}>
          {confirming && (
            <div className="confirm-bar" role="alert">
              <IconAlert size={18} />
              <span>Revoke <b>{confirming.name}</b>? Apps using it stop working immediately and its sessions end.</span>
              <Button size="sm" onClick={() => setConfirming(undefined)}>Cancel</Button>
              <Button size="sm" variant="danger-solid" icon={<IconTrash size={15} />} onClick={() => void revoke(confirming)}>Revoke key</Button>
            </div>
          )}
          {keys.length === 0 ? (
            <Empty icon={<IconKey size={22} />} title="No keys yet"
              action={<Button variant="primary" icon={<IconPlus size={16} />} onClick={() => setCreating(true)}>Create a key</Button>}>
              Create a key for each app or teammate, so you can revoke one without touching the rest.
            </Empty>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr><th>Name</th><th>Secret</th><th>Access</th><th>Scope</th><th>Last used</th><th>Expires</th><th>Status</th><th /></tr>
                </thead>
                <tbody>
                  {shown.map((k) => {
                    const lapsed = expired(k);
                    const recent = (k.lastUsedAt ?? 0) > now() - 86400;
                    return (
                      <tr key={k.id} className={lapsed ? "row-muted" : ""}>
                        <td>
                          <div className="entity">
                            <span className={`key-glyph ${k.managed ? "" : "env"}`}>{k.managed ? <IconKey size={16} /> : <IconLock size={16} />}</span>
                            <div><b>{k.name}</b><span>{k.managed ? k.id : "Set by NEEDLEDB_API_KEY"}</span></div>
                          </div>
                        </td>
                        <td>{k.prefix ? <span className="secret-prefix">{k.prefix}<i>••••••••</i></span> : <span className="muted">—</span>}</td>
                        <td><span className={`role role-${k.role}`}>{ROLE_LABEL[k.role]}</span></td>
                        <td>{k.indexes ? <span className="scope">{k.indexes.join(", ")}</span> : <span className="muted">All indexes</span>}</td>
                        <td>
                          {k.managed
                            ? <span className="last-used"><i className={recent ? "on" : ""} />{fmtRelative(k.lastUsedAt)}</span>
                            : <span className="muted">—</span>}
                        </td>
                        <td>
                          {!k.managed ? <span className="muted">—</span>
                            : k.expiresAt == null ? <span className="expiry-never">Never</span>
                              : lapsed ? <span className="bad">{fmtRelative(k.expiresAt)}</span>
                                : <span>{fmtRelative(k.expiresAt)}</span>}
                        </td>
                        <td>
                          {!k.managed ? <Badge>Environment</Badge> : lapsed ? <Badge tone="bad">Expired</Badge> : <Badge tone="good">Active</Badge>}
                        </td>
                        <td className="num">
                          {k.managed && (
                            <Menu align="end" trigger={({ open, toggle }) => (
                              <IconButton label="Key actions" onClick={toggle} aria-expanded={open}><IconMore size={18} /></IconButton>
                            )}>
                              {(close) => (
                                <>
                                  <MenuItem icon={<IconCopy size={16} />} onClick={() => { void copyText(k.id); toast("Key id copied"); close(); }}>Copy key id</MenuItem>
                                  <MenuItem icon={<IconShield size={16} />} onClick={() => { go(`/security?q=${encodeURIComponent(k.name)}`); close(); }}>View activity</MenuItem>
                                  <MenuDivider />
                                  <MenuItem tone="bad" icon={<IconTrash size={16} />} onClick={() => { setConfirming(k); close(); }}>Revoke key</MenuItem>
                                </>
                              )}
                            </Menu>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  {shown.length === 0 && <tr><td colSpan={8} className="table-empty">No keys match “{query}”.</td></tr>}
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
  const [expiry, setExpiry] = useState<Expiry>("90");
  const [created, setCreated] = useState<ApiKey & { key: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!open) return;
    setName("");
    setRole("read");
    setScope("all");
    setChosen([]);
    setExpiry("90");
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
      setCreated(await api.createKey({
        name: name.trim(), role, indexes: scoped ? chosen : undefined,
        expiresInDays: expiry === "never" ? undefined : Number(expiry),
      }));
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
          <p>
            {ROLE_LABEL[created.role]} access{created.indexes ? ` to ${created.indexes.join(", ")}` : " to every index"} ·{" "}
            {created.expiresAt ? `expires ${fmtRelative(created.expiresAt).toLowerCase()}` : "never expires"}
          </p>
          <div className="secret">
            <code>{created.key}</code>
            <CopyButton text={created.key} variant="primary" />
          </div>
          <div className="note note-warn">Copy it now and store it in your secret manager. NeedleDB keeps only a hash — this key can't be shown again.</div>
          <pre className="code">{`export NEEDLEDB_API_KEY="${created.key}"\n\nfrom needledb import NeedleDB\ndb = NeedleDB("${window.location.origin}")`}</pre>
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet open={open} onClose={onClose} title="Create API key" subtitle="Give each app or person their own key, with only the access it needs."
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
          <div className="perm-matrix" aria-label="What this key can do">
            {OPERATIONS.map((op) => {
              const allowed = ROLE_RANK[role] >= ROLE_RANK[op.needs];
              return (
                <div key={op.label} className={`perm ${allowed ? "on" : ""}`}>
                  <span className="perm-icon">{allowed ? <IconCheck size={13} /> : <IconX size={13} />}</span>
                  {op.label}
                </div>
              );
            })}
          </div>
        </Field>

        {role !== "admin" && (
          <Field label="Scope" hint={scope === "some" ? "Other indexes look like they don't exist to this key." : undefined}>
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
                      <span>{i.name}</span>
                      <span className="muted small">{i.dimension}-d</span>
                    </label>
                  ))}
                </div>
              ) : <p className="muted small">There are no indexes to choose from yet.</p>
            )}
          </Field>
        )}

        <Field label="Expiration" hint={expiry === "never" ? undefined : "The key stops working after this. Create a new one before then."}>
          <Choice label="Expiration" value={expiry} onChange={setExpiry} options={EXPIRY.map((e) => ({ value: e.value, label: e.label }))} />
          {expiry === "never" && (
            <div className="note note-warn">A key that never expires stays valid until someone revokes it. Prefer an expiry for production apps.</div>
          )}
        </Field>
        <ErrorNote error={error} />
      </form>
    </Sheet>
  );
}
