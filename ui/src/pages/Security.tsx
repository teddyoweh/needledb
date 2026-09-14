import { type ReactNode, useState } from "react";
import { api } from "../api";
import { IconCheck, IconCookie, IconGauge, IconGlobe, IconKey, IconLock, IconLogOut, IconShield, IconUpload } from "../icons";
import { ROLE_LABEL, fmtBytes, fmtRelative } from "../lib";
import { useSession } from "../session";
import { Avatar, Badge, Button, Card, PageHeader, useToast } from "../ui";

type Check = { icon: ReactNode; title: string; detail: ReactNode; ok: boolean; status: string };

export default function Security() {
  const { me, can, signOut } = useSession();
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
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
      detail: `${s.environmentKeys} environment ${s.environmentKeys === 1 ? "key" : "keys"} and ${s.managedKeys} managed ${s.managedKeys === 1 ? "key" : "keys"}. Only SHA-256 digests are kept; a key is shown once, when it's created.`,
    },
    {
      icon: <IconCookie size={18} />, title: "Sessions", ok: true, status: `${s.sessionHours} h`,
      detail: `Signed, HttpOnly, SameSite=Strict${s.secureCookies ? ", Secure" : ""} cookies that name the key, never contain it. Cross-site writes are refused, and revoking a key ends its sessions.`,
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
      detail: `Larger bodies are rejected before they're read.${s.trustProxy ? " Client addresses come from your proxy's X-Forwarded-For." : ""}`,
    },
  ] : [];

  const passing = checks.filter((c) => c.ok).length;

  async function revokeEverywhere() {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    try {
      await api.revokeAllSessions();
      toast("Signed out every session");
      await signOut();
    } catch (err) {
      toast((err as Error).message, "bad");
    }
  }

  return (
    <>
      <PageHeader title="Security"
        subtitle={checks.length ? `${passing} of ${checks.length} protections active on this connection.` : "How this server is protected."} />

      <Card title="Protections" flush>
        <ul className="checks">
          {checks.map((c) => (
            <li key={c.title} className="check-row">
              <span className={`check-icon ${c.ok ? "" : "warn"}`}>{c.icon}</span>
              <div>
                <b>{c.title}</b>
                <p>{c.detail}</p>
              </div>
              <Badge tone={c.ok ? "good" : "warn"} dot>{c.status}</Badge>
            </li>
          ))}
        </ul>
      </Card>

      <div className="grid-2">
        <Card title="Your access">
          <div className="whoami">
            <Avatar name={principal.name} size={48} />
            <div>
              <b>{principal.name}</b>
              <span>{principal.source === "environment" ? "Environment key" : principal.source === "local" ? "Local access" : principal.id}</span>
            </div>
          </div>
          <dl className="kv">
            <dt>Access</dt><dd>{ROLE_LABEL[principal.role]}</dd>
            <dt>Indexes</dt><dd>{principal.indexes ? principal.indexes.join(", ") : "All"}</dd>
            <dt>Signed in with</dt><dd>{me.via === "session" ? "Browser session" : me.via === "key" ? "API key header" : "No authentication"}</dd>
            {me.sessionExpiresAt && <><dt>Session ends</dt><dd>{fmtRelative(me.sessionExpiresAt)}</dd></>}
          </dl>
          {principal.source !== "local" && (
            <div className="actions-end"><Button icon={<IconLogOut size={16} />} onClick={() => void signOut()}>Sign out</Button></div>
          )}
        </Card>

        {can("admin") && me.authRequired && (
          <Card title="Sign out everywhere" subtitle="Rotates the session secret. Every browser, including this one, has to sign in again. API keys keep working.">
            <div className="actions-end">
              <Button variant={confirming ? "danger-solid" : "danger"} icon={<IconCheck size={16} />}
                onMouseLeave={() => setConfirming(false)} onClick={() => void revokeEverywhere()}>
                {confirming ? "Confirm — end all sessions" : "End all sessions"}
              </Button>
            </div>
          </Card>
        )}
      </div>

      <Card title="Deploying" subtitle="Run it behind TLS with a long random key. Nothing listens without auth except on localhost.">
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
