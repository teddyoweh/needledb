import { type ReactNode, useMemo, useState } from "react";
import { api, type AuditEvent } from "../api";
import { CodeBlock } from "../code";
import {
  IconActivity,
  IconAlert,
  IconCheck,
  IconCookie,
  IconDownload,
  IconGauge,
  IconGlobe,
  IconKey,
  IconLock,
  IconLogOut,
  IconSearch,
  IconShield,
  IconUpload,
} from "../icons";
import { ROLE_LABEL, describeEvent, fmtBytes, fmtInt, fmtRelative, usePoll } from "../lib";
import { useSession } from "../session";
import { Avatar, Badge, Button, Card, PageHeader, PropertyList, Segmented, Sheet, Skeleton, useToast } from "../ui";
import { eventIcon } from "./Activity";

type Check = { icon: ReactNode; title: string; detail: ReactNode; ok: boolean; status: string; guide: string };
type Filter = "all" | "auth" | "key" | "index" | "failures";

function ActivityBars({ events }: { events: AuditEvent[] }) {
  const nowS = Date.now() / 1000;
  const hours = Array.from({ length: 24 }, () => ({ ok: 0, bad: 0 }));
  for (const e of events) {
    const age = Math.floor((nowS - e.ts) / 3600);
    if (age >= 0 && age < 24) {
      const bucket = hours[23 - age];
      if (e.ok) bucket.ok += 1;
      else bucket.bad += 1;
    }
  }
  const max = Math.max(1, ...hours.map((h) => h.ok + h.bad));
  return (
    <>
      <div className="activity-bars" role="img" aria-label="Events per hour over the last 24 hours">
        {hours.map((h, i) => (
          <div key={i} className="activity-col" title={`${h.ok} succeeded, ${h.bad} failed`}>
            <span className="activity-bad" style={{ height: `${(h.bad / max) * 100}%` }} />
            <span className="activity-ok" style={{ height: `${(h.ok / max) * 100}%` }} />
          </div>
        ))}
      </div>
      <div className="matrix-axis"><span>24 hours ago</span><span>now</span></div>
    </>
  );
}

function toCsv(events: AuditEvent[]) {
  const cell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const rows = events.map((e) => [new Date(e.ts * 1000).toISOString(), e.action, describeEvent(e), e.actorName, e.ip, e.target, e.ok ? "success" : "failure"].map(cell).join(","));
  return ["time,action,description,actor,ip,target,result", ...rows].join("\n");
}

export default function Security({ query = "" }: { query?: string }) {
  const { me, can, signOut } = useSession();
  const admin = can("admin");
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState(query);
  const [open, setOpen] = useState<AuditEvent>();
  const events = usePoll(() => (admin ? api.events(500) : Promise.resolve({ events: [] as AuditEvent[] })), 10000, [admin]);
  const s = me.security;
  const principal = me.principal;
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname);

  const checks: Check[] = s ? [
    {
      icon: <IconLock size={18} />, title: "Authentication", ok: me.authRequired, status: me.authRequired ? "Required" : "Off",
      guide: "#/docs/guides/authentication",
      detail: me.authRequired
        ? "Every API route, the API explorer and this app need a key or a signed-in session."
        : "Local development mode. The server refuses to run this way on anything but localhost.",
    },
    {
      icon: <IconGlobe size={18} />, title: "Encryption in transit", ok: s.https || local, status: s.https ? "HTTPS" : local ? "Localhost" : "Plain HTTP",
      guide: "#/docs/guides/deploying",
      detail: s.https
        ? "Keys, sessions and data are encrypted between clients and this server."
        : local
          ? "Fine on this computer. Anywhere else, serve over HTTPS through a TLS proxy or with --tls-cert."
          : "Keys travel unencrypted on this connection. Put NeedleDB behind a TLS proxy or start it with --tls-cert and --tls-key.",
    },
    {
      icon: <IconKey size={18} />, title: "Key storage", ok: true, status: "Hashed", guide: "#/docs/guides/authentication",
      detail: `${s.environmentKeys} environment and ${s.managedKeys} active managed ${s.managedKeys === 1 ? "key" : "keys"}. Only SHA-256 digests are kept, and keys can expire.`,
    },
    {
      icon: <IconCookie size={18} />, title: "Sessions", ok: true, status: `${s.sessionHours} h`, guide: "#/docs/guides/sessions",
      detail: `Signed, HttpOnly, SameSite=Strict${s.secureCookies ? ", Secure" : ""} cookies that name the key, never contain it. Cross-site writes are refused.`,
    },
    {
      icon: <IconShield size={18} />, title: "Brute-force protection", ok: true, status: `${s.lockout.maxFailures} tries`, guide: "#/docs/guides/authentication",
      detail: `${s.lockout.maxFailures} failed attempts within ${Math.round(s.lockout.windowSeconds / 60)} minutes block that address for ${Math.round(s.lockout.blockSeconds / 60)} minutes.`,
    },
    {
      icon: <IconGauge size={18} />, title: "Browser hardening", ok: true, status: "On", guide: "#/docs/guides/deploying",
      detail: "Content Security Policy, no framing, no MIME sniffing, no referrers, and no caching of API responses.",
    },
    {
      icon: <IconUpload size={18} />, title: "Request size limit", ok: true, status: fmtBytes(s.maxBodyBytes), guide: "#/docs/api/limits",
      detail: `Larger bodies are rejected before they're read.${s.trustProxy ? " Client addresses come from your proxy." : ""}`,
    },
  ] : [];
  const review = checks.filter((c) => !c.ok);

  const all = events.data?.events ?? [];
  const failuresByIp = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of all) if (!e.ok && e.ip) counts.set(e.ip, (counts.get(e.ip) ?? 0) + 1);
    return counts;
  }, [all]);
  const dayAgo = Date.now() / 1000 - 86400;
  const lastDay = all.filter((e) => e.ts > dayAgo);
  const needle = search.trim().toLowerCase();
  const log = all.filter((e) => {
    if (filter === "failures" && e.ok) return false;
    if (filter !== "all" && filter !== "failures" && !e.action.startsWith(`${filter}.`)) return false;
    return !needle || `${describeEvent(e)} ${e.action} ${e.actorName ?? ""} ${e.ip ?? ""} ${e.target ?? ""}`.toLowerCase().includes(needle);
  });

  function exportCsv() {
    const url = URL.createObjectURL(new Blob([toCsv(log)], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `needledb-audit-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function endAllSessions() {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    try {
      await api.revokeAllSessions();
      toast("Ended every session");
      await signOut();
    } catch (err) {
      toast((err as Error).message, "bad");
    }
  }

  return (
    <>
      <PageHeader title="Security"
        subtitle={checks.length ? (review.length ? `${review.length} to review · ${checks.length - review.length} passing` : `All ${checks.length} protections active on this connection`) : "How this server is protected"}
        actions={<a className="btn btn-secondary btn-md" href="#/docs/guides/deploying">Deployment guide</a>} />

      <div className="security-top">
        <div className={`posture ${review.length ? "attention" : ""}`}>
          <div className="posture-label"><IconShield size={16} />Posture</div>
          <div className="posture-value">{review.length ? `${review.length} to review` : "Hardened"}</div>
          <ul className="posture-list">
            {checks.map((c) => (
              <li key={c.title} className={c.ok ? "ok" : "warn"}>{c.ok ? <IconCheck size={13} /> : <IconAlert size={13} />}{c.title}</li>
            ))}
          </ul>
        </div>

        {admin ? (
          <Card icon={<IconActivity size={16} />} title="Access activity" subtitle="Sign-ins, rejected keys and changes, last 24 hours">
            <div className="access-figures">
              <div><b>{fmtInt(lastDay.filter((e) => e.action === "auth.signed_in").length)}</b><span>sign-ins</span></div>
              <div className="bad"><b>{fmtInt(lastDay.filter((e) => !e.ok).length)}</b><span>failed attempts</span></div>
              <div><b>{fmtInt(lastDay.filter((e) => e.action === "auth.blocked").length)}</b><span>blocks</span></div>
              <div><b>{fmtInt(lastDay.filter((e) => e.action.startsWith("key.") || e.action.startsWith("index.")).length)}</b><span>changes</span></div>
            </div>
            {events.data ? <ActivityBars events={all} /> : <Skeleton height={96} radius={10} />}
          </Card>
        ) : <div />}

        <Card icon={<IconLock size={16} />} title="Your access">
          <div className="whoami">
            <Avatar name={principal.name} size={42} />
            <div>
              <b>{principal.name}</b>
              <span>{principal.source === "environment" ? "Environment key" : principal.source === "local" ? "No key · localhost only" : principal.id}</span>
            </div>
          </div>
          <PropertyList items={[
            { icon: <IconKey size={15} />, label: "Access", value: ROLE_LABEL[principal.role] },
            { icon: <IconShield size={15} />, label: "Indexes", value: principal.indexes ? principal.indexes.join(", ") : "All" },
            ...(me.sessionExpiresAt ? [{ icon: <IconCookie size={15} />, label: "Session ends", value: fmtRelative(me.sessionExpiresAt) }] : []),
          ]} />
          <div className="actions-end">
            {admin && me.authRequired && (
              <Button size="sm" variant={confirming ? "danger-solid" : "danger"} onMouseLeave={() => setConfirming(false)} onClick={() => void endAllSessions()}>
                {confirming ? "Confirm — end all" : "End all sessions"}
              </Button>
            )}
            {principal.source !== "local" && <Button size="sm" icon={<IconLogOut size={15} />} onClick={() => void signOut()}>Sign out</Button>}
          </div>
        </Card>
      </div>

      <Card icon={<IconShield size={16} />} title="Protections" subtitle="Evaluated for the connection you're using now" flush>
        <ul className="checks">
          {checks.map((c) => (
            <li key={c.title} className="check-row">
              <span className={`check-icon ${c.ok ? "" : "warn"}`}>{c.icon}</span>
              <div>
                <b>{c.title}</b>
                <p>{c.detail}</p>
              </div>
              <div className="check-side">
                <Badge tone={c.ok ? "good" : "warn"}>{c.status}</Badge>
                <a className={`link small ${c.ok ? "quiet" : ""}`} href={c.guide}>{c.ok ? "Learn more" : "How to fix"}</a>
              </div>
            </li>
          ))}
        </ul>
      </Card>

      {admin && (
        <Card icon={<IconActivity size={16} />} title="Audit log"
          subtitle={events.data ? `${fmtInt(all.length)} most recent events · ${fmtInt(all.filter((e) => !e.ok).length)} failures` : "Loading…"} flush
          actions={<Button size="sm" icon={<IconDownload size={15} />} onClick={exportCsv} disabled={!log.length}>Export CSV</Button>}>
          <div className="log-toolbar">
            <div className="search-field wide">
              <IconSearch size={15} />
              <input aria-label="Search events" placeholder="Search by event, actor, address or key" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            <Segmented label="Event type" value={filter} onChange={setFilter} options={[
              { value: "all", label: "All" },
              { value: "auth", label: "Sign-ins" },
              { value: "key", label: "Keys" },
              { value: "index", label: "Indexes" },
              { value: "failures", label: "Failures" },
            ]} />
          </div>
          {!events.data ? (
            <div className="stack tight pad">{[0, 1, 2, 3].map((i) => <Skeleton key={i} height={42} radius={10} />)}</div>
          ) : log.length === 0 ? (
            <div className="table-empty">{needle || filter !== "all" ? "No events match these filters." : "No events recorded yet."}</div>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Event</th><th>Actor</th><th>Address</th><th>When</th><th>Result</th></tr></thead>
                <tbody>
                  {log.slice(0, 200).map((e) => {
                    const suspicious = !!e.ip && (failuresByIp.get(e.ip) ?? 0) >= 3 && !e.ok;
                    return (
                      <tr key={e.id} className="rowlink" onClick={() => setOpen(e)}>
                        <td>
                          <div className="entity">
                            <span className={`feed-icon ${e.ok ? "" : "bad"}`}>{eventIcon(e)}</span>
                            <div><b>{describeEvent(e)}</b><span>{e.action}</span></div>
                          </div>
                        </td>
                        <td>{e.actorName ?? <span className="muted">Anonymous</span>}</td>
                        <td>
                          <span className="address">{e.ip ?? "—"}</span>
                          {suspicious && <span className="tag-suspicious" title={`${failuresByIp.get(e.ip!)} failures from this address`}>Repeated failures</span>}
                        </td>
                        <td className="muted" title={new Date(e.ts * 1000).toLocaleString()}>{fmtRelative(e.ts)}</td>
                        <td><Badge tone={e.ok ? "good" : "bad"}>{e.ok ? "Success" : "Failed"}</Badge></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      <Sheet open={!!open} onClose={() => setOpen(undefined)} title="Event" subtitle={open ? describeEvent(open) : undefined}>
        {open && (
          <div className="stack">
            <PropertyList items={[
              { icon: eventIcon(open, 15), label: "Action", value: open.action },
              { icon: <IconCheck size={15} />, label: "Result", value: <Badge tone={open.ok ? "good" : "bad"}>{open.ok ? "Success" : "Failed"}</Badge> },
              { icon: <IconLock size={15} />, label: "Actor", value: open.actorName ?? "Anonymous" },
              { icon: <IconGlobe size={15} />, label: "Address", value: open.ip ?? "—" },
              { icon: <IconActivity size={15} />, label: "Time", value: new Date(open.ts * 1000).toLocaleString() },
            ]} />
            <CodeBlock lang="json" title="Raw event" code={JSON.stringify(open, null, 2)} />
          </div>
        )}
      </Sheet>
    </>
  );
}
