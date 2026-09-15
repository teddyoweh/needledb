import { type ReactNode, useState } from "react";
import { api, type AuditEvent } from "../api";
import { IconActivity, IconCheck, IconCookie, IconGauge, IconGlobe, IconKey, IconLock, IconLogOut, IconShield, IconUpload } from "../icons";
import { ROLE_LABEL, describeEvent, fmtBytes, fmtRelative, usePoll } from "../lib";
import { useSession } from "../session";
import { Avatar, Badge, Button, Card, PageHeader, PropertyList, Segmented, Skeleton, useToast } from "../ui";
import { eventIcon } from "./Activity";

type Check = { icon: ReactNode; title: string; detail: ReactNode; ok: boolean; status: string };

export default function Security() {
  const { me, can, signOut } = useSession();
  const admin = can("admin");
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [only, setOnly] = useState<"all" | "failures">("all");
  const events = usePoll(() => (admin ? api.events(100) : Promise.resolve({ events: [] as AuditEvent[] })), 10000, [admin]);
  const s = me.security;
  const principal = me.principal;
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname);

  const checks: Check[] = s ? [
    {
      icon: <IconLock size={18} />, title: "Authentication", ok: me.authRequired,
      status: me.authRequired ? "Required" : "Off",
      detail: me.authRequired
        ? "Every API route, the API reference and this app need a key or a signed-in session."
        : "Local development mode. The server refuses to run this way on anything but localhost.",
    },
    {
      icon: <IconGlobe size={18} />, title: "Encryption in transit", ok: s.https || local,
      status: s.https ? "HTTPS" : local ? "Localhost" : "Plain HTTP",
      detail: s.https
        ? "Keys, sessions and data are encrypted between clients and this server."
        : local
          ? "Fine on this computer. Anywhere else, serve over HTTPS: a TLS proxy with --trust-proxy, or --tls-cert and --tls-key."
          : "Keys travel unencrypted on this connection. Put NeedleDB behind a TLS proxy or start it with --tls-cert and --tls-key.",
    },
    {
      icon: <IconKey size={18} />, title: "Key storage", ok: true, status: "Hashed",
      detail: `${s.environmentKeys} environment and ${s.managedKeys} managed ${s.managedKeys === 1 ? "key" : "keys"}. Only SHA-256 digests are kept; a key is shown once, when it's created.`,
    },
    {
      icon: <IconCookie size={18} />, title: "Sessions", ok: true, status: `${s.sessionHours} h`,
      detail: `Signed, HttpOnly, SameSite=Strict${s.secureCookies ? ", Secure" : ""} cookies that name the key, never contain it. Cross-site writes are refused.`,
    },
    {
      icon: <IconShield size={18} />, title: "Brute-force protection", ok: true, status: `${s.lockout.maxFailures} tries`,
      detail: `${s.lockout.maxFailures} failed attempts within ${Math.round(s.lockout.windowSeconds / 60)} minutes block that address for ${Math.round(s.lockout.blockSeconds / 60)} minutes.`,
    },
    {
      icon: <IconGauge size={18} />, title: "Browser hardening", ok: true, status: "On",
      detail: "Content Security Policy, no framing, no MIME sniffing, no referrers, and no caching of API responses.",
    },
    {
      icon: <IconUpload size={18} />, title: "Request size limit", ok: true, status: fmtBytes(s.maxBodyBytes),
      detail: `Larger bodies are rejected before they're read.${s.trustProxy ? " Client addresses come from your proxy." : ""}`,
    },
  ] : [];
  const passing = checks.filter((c) => c.ok).length;
  const log = (events.data?.events ?? []).filter((e) => only === "all" || !e.ok);
  const failures = (events.data?.events ?? []).filter((e) => !e.ok).length;

  async function revokeEverywhere() {
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
        subtitle={checks.length ? `${passing} of ${checks.length} protections active on this connection` : "How this server is protected"} />

      <div className="grid-security">
        <Card icon={<IconShield size={16} />} title="Protections" subtitle="Evaluated for the connection you're using now" flush>
          <ul className="checks">
            {checks.map((c) => (
              <li key={c.title} className="check-row">
                <span className={`check-icon ${c.ok ? "" : "warn"}`}>{c.icon}</span>
                <div>
                  <b>{c.title}</b>
                  <p>{c.detail}</p>
                </div>
                <Badge tone={c.ok ? "good" : "warn"}>{c.status}</Badge>
              </li>
            ))}
          </ul>
        </Card>

        <div className="stack">
          <Card icon={<IconLock size={16} />} title="Your access">
            <div className="whoami">
              <Avatar name={principal.name} size={44} />
              <div>
                <b>{principal.name}</b>
                <span>{principal.source === "environment" ? "Environment key" : principal.source === "local" ? "No key · localhost only" : principal.id}</span>
              </div>
            </div>
            <PropertyList items={[
              { icon: <IconKey size={15} />, label: "Access", value: ROLE_LABEL[principal.role] },
              { icon: <IconShield size={15} />, label: "Indexes", value: principal.indexes ? principal.indexes.join(", ") : "All" },
              { icon: <IconCookie size={15} />, label: "Signed in with", value: me.via === "session" ? "Browser session" : me.via === "key" ? "API key header" : "No authentication" },
              ...(me.sessionExpiresAt ? [{ icon: <IconActivity size={15} />, label: "Session ends", value: fmtRelative(me.sessionExpiresAt) }] : []),
            ]} />
            {principal.source !== "local" && (
              <div className="actions-end"><Button icon={<IconLogOut size={16} />} onClick={() => void signOut()}>Sign out</Button></div>
            )}
          </Card>

          {admin && me.authRequired && (
            <Card icon={<IconCheck size={16} />} title="Sign out everywhere"
              subtitle="Rotates the session secret. Every browser, including this one, has to sign in again. API keys keep working.">
              <div className="actions-end">
                <Button variant={confirming ? "danger-solid" : "danger"} onMouseLeave={() => setConfirming(false)} onClick={() => void revokeEverywhere()}>
                  {confirming ? "Confirm — end all sessions" : "End all sessions"}
                </Button>
              </div>
            </Card>
          )}
        </div>
      </div>

      {admin && (
        <Card icon={<IconActivity size={16} />} title="Audit log"
          subtitle={events.data ? `${events.data.events.length} most recent events · ${failures} ${failures === 1 ? "failure" : "failures"}` : "Loading…"} flush
          actions={<Segmented label="Show" value={only} onChange={setOnly} options={[{ value: "all", label: "All events" }, { value: "failures", label: "Failures" }]} />}>
          {!events.data ? (
            <div className="stack tight pad">{[0, 1, 2, 3].map((i) => <Skeleton key={i} height={40} radius={10} />)}</div>
          ) : log.length === 0 ? (
            <div className="table-empty">{only === "failures" ? "No failed attempts recorded." : "No events recorded yet."}</div>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Event</th><th>Actor</th><th>Address</th><th>When</th><th>Result</th></tr></thead>
                <tbody>
                  {log.map((e) => (
                    <tr key={e.id}>
                      <td>
                        <div className="entity">
                          <span className={`feed-icon ${e.ok ? "" : "bad"}`}>{eventIcon(e)}</span>
                          <div><b>{describeEvent(e)}</b><span>{e.action}</span></div>
                        </div>
                      </td>
                      <td>{e.actorName ?? <span className="muted">Anonymous</span>}</td>
                      <td className="muted">{e.ip ?? "—"}</td>
                      <td className="muted" title={new Date(e.ts * 1000).toLocaleString()}>{fmtRelative(e.ts)}</td>
                      <td><Badge tone={e.ok ? "good" : "bad"}>{e.ok ? "Success" : "Failed"}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      <Card icon={<IconGlobe size={16} />} title="Deploying" subtitle="Run it behind TLS with a long random key. Nothing listens without auth except on localhost.">
        <div className="grid-2 tight">
          <div>
            <div className="code-label">Caddyfile</div>
            <pre className="code">{`vectors.example.com {\n  reverse_proxy 127.0.0.1:8080\n}`}</pre>
          </div>
          <div>
            <div className="code-label">Server</div>
            <pre className="code">{`export NEEDLEDB_API_KEY=$(openssl rand -hex 32)\nneedledb serve --trust-proxy`}</pre>
          </div>
        </div>
      </Card>
    </>
  );
}
