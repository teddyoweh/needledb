import { type ButtonHTMLAttributes, type FormEvent, type ReactNode, useEffect, useState } from "react";
import { apiKey, type IndexInfo, type Metadata, type Traffic } from "./api";
import { copyText, fmtBytes, fmtInt, fmtMs, go, structureLabel } from "./lib";

type Variant = "default" | "primary" | "danger" | "ghost";

export function Button({ variant = "default", className = "", ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return <button type="button" {...rest} className={`btn btn-${variant} ${className}`.trim()} />;
}

export type Tone = "neutral" | "good" | "warn" | "bad" | "accent";

export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function Tile({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="tile">
      <div className="tile-label">{label}</div>
      <div className="tile-value">{value}</div>
      {hint && <div className="tile-hint">{hint}</div>}
    </div>
  );
}

export function Panel({ title, note, actions, children, className = "" }: {
  title?: ReactNode;
  note?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`.trim()}>
      {(title || actions) && (
        <header className="panel-head">
          <div>
            {title && <h2>{title}</h2>}
            {note && <span className="panel-note">{note}</span>}
          </div>
          {actions && <div className="panel-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function Field({ label, hint, htmlFor, children, className = "" }: {
  label: string;
  hint?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`field ${className}`.trim()}>
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {hint && <div className="field-hint">{hint}</div>}
    </div>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value}
          className={o.value === value ? "on" : ""} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function ErrorNote({ error }: { error?: Error | string | null }) {
  if (!error) return null;
  return <div className="error-note" role="alert">{typeof error === "string" ? error : error.message}</div>;
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return <div className="loading">{label}</div>;
}

export function NeedleMark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" aria-hidden="true">
      <path d="M4 20 17.6 6.4" strokeWidth="2.4" />
      <ellipse cx="19.2" cy="4.8" rx="2.6" ry="1.4" transform="rotate(-45 19.2 4.8)" strokeWidth="1.8" />
    </svg>
  );
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button variant="ghost" onClick={async () => {
      if (await copyText(text)) {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      }
    }}>
      {copied ? "Copied" : label}
    </Button>
  );
}

export function NamespaceSelect({ id, value, namespaces, onChange }: {
  id: string;
  value: string;
  namespaces: string[];
  onChange: (value: string) => void;
}) {
  const options = Array.from(new Set(["", ...namespaces, value])).sort();
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map((ns) => (
        <option key={ns} value={ns}>{ns === "" ? "(default)" : ns}</option>
      ))}
    </select>
  );
}

export function MetadataChips({ metadata }: { metadata?: Metadata | null }) {
  const entries = Object.entries(metadata ?? {});
  if (!entries.length) return <span className="muted">—</span>;
  return (
    <div className="meta-chips">
      {entries.slice(0, 8).map(([k, v]) => (
        <span key={k} className="meta-chip" title={`${k}: ${Array.isArray(v) ? v.join(", ") : String(v)}`}>
          <span className="k">{k}</span>
          <span className="v">{Array.isArray(v) ? v.join(", ") : String(v)}</span>
        </span>
      ))}
      {entries.length > 8 && <span className="muted">+{entries.length - 8}</span>}
    </div>
  );
}

export function IndexTable({ indexes, traffic, onCreate }: {
  indexes: IndexInfo[];
  traffic?: Record<string, Traffic>;
  onCreate?: () => void;
}) {
  if (!indexes.length) {
    return (
      <Empty title="No indexes yet"
        action={onCreate ? <Button variant="primary" onClick={onCreate}>Create an index</Button>
          : <a className="btn btn-primary" href="#/indexes?new=1">Create an index</a>}>
        An index holds vectors of one dimension and metric. Create one here, or with the SDK:{" "}
        <code>db.create_index("products", dimension=1536)</code>
      </Empty>
    );
  }
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th className="num">Dimension</th>
            <th>Metric</th>
            <th>Structure</th>
            <th className="num">Vectors</th>
            <th className="num">Memory</th>
            {traffic && <th className="num">QPS</th>}
            {traffic && <th className="num">p99</th>}
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {indexes.map((i) => {
            const t = traffic?.[i.name];
            return (
              <tr key={i.name} className="rowlink" onClick={() => go(`/indexes/${encodeURIComponent(i.name)}`)}>
                <td><a className="name" href={`#/indexes/${encodeURIComponent(i.name)}`} onClick={(e) => e.stopPropagation()}>{i.name}</a></td>
                <td className="num">{i.dimension}</td>
                <td>{i.metric}</td>
                <td>{structureLabel(i)}</td>
                <td className="num">{fmtInt(i.vectorCount)}</td>
                <td className="num">{fmtBytes(i.memoryBytes)}</td>
                {traffic && <td className="num">{t ? t.qps.toFixed(1) : "0.0"}</td>}
                {traffic && <td className="num">{fmtMs(t?.p99Ms)}</td>}
                <td><Badge tone={i.status.state === "Ready" ? "good" : "warn"}>{i.status.state}</Badge></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function KeyDialog({ onClose }: { onClose: () => void }) {
  const [key, setKey] = useState(apiKey.get());
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function save(e: FormEvent) {
    e.preventDefault();
    apiKey.set(key.trim());
    onClose();
    window.location.reload();
  }

  return (
    <div className="scrim" onMouseDown={onClose}>
      <form className="dialog" onMouseDown={(e) => e.stopPropagation()} onSubmit={save} aria-labelledby="key-title">
        <h2 id="key-title">API key</h2>
        <p>
          Paste a key from the server's <code>NEEDLEDB_API_KEY</code>. It is stored in this browser only and sent
          as the <code>Api-Key</code> header.
        </p>
        <input id="api-key" type="password" autoFocus autoComplete="off" value={key}
          onChange={(e) => setKey(e.target.value)} placeholder="Api-Key" />
        <div className="dialog-actions">
          {apiKey.get() && <Button variant="ghost" onClick={() => { apiKey.set(""); onClose(); window.location.reload(); }}>Forget key</Button>}
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit">Save key</Button>
        </div>
      </form>
    </div>
  );
}
