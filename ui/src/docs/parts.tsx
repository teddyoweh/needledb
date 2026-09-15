import { type ReactNode, useState } from "react";
import { IconAlert, IconBulb, IconCheck, IconChevronRight, IconCopy, IconInfo } from "../icons";
import { copyText } from "../lib";

export type Method = "GET" | "POST" | "PATCH" | "DELETE";

/** The docs are served by the server they describe, so examples use its address. */
export const ORIGIN = window.location.origin;

export function H2({ id, children }: { id: string; children: ReactNode }) {
  return <h2 id={id}>{children}</h2>;
}

export function H3({ id, children }: { id: string; children: ReactNode }) {
  return <h3 id={id}>{children}</h3>;
}

/** Inline code. */
export function C({ children }: { children: ReactNode }) {
  return <code className="ic">{children}</code>;
}

const CALLOUT_ICONS = {
  note: <IconInfo size={16} />,
  info: <IconInfo size={16} />,
  tip: <IconBulb size={16} />,
  check: <IconCheck size={16} />,
  warning: <IconAlert size={16} />,
  danger: <IconAlert size={16} />,
};

export function Callout({ kind = "note", title, children }: { kind?: keyof typeof CALLOUT_ICONS; title?: string; children: ReactNode }) {
  return (
    <div className={`callout callout-${kind}`}>
      <span className="callout-icon">{CALLOUT_ICONS[kind]}</span>
      <div className="callout-body">
        {title && <b>{title}</b>}
        <div>{children}</div>
      </div>
    </div>
  );
}

export function Steps({ children }: { children: ReactNode }) {
  return <ol className="doc-steps">{children}</ol>;
}

export function Step({ title, children }: { title: string; children: ReactNode }) {
  return (
    <li className="doc-step">
      <div className="doc-step-title">{title}</div>
      <div className="doc-step-body">{children}</div>
    </li>
  );
}

export function CardGroup({ children, cols = 2 }: { children: ReactNode; cols?: 2 | 3 }) {
  return <div className={`doc-cards cols-${cols}`}>{children}</div>;
}

export function DocCard({ title, icon, href, children }: { title: string; icon: ReactNode; href: string; children: ReactNode }) {
  return (
    <a className="doc-card" href={href}>
      <span className="doc-card-icon">{icon}</span>
      <b>{title}</b>
      <p>{children}</p>
      <span className="doc-card-arrow"><IconChevronRight size={16} /></span>
    </a>
  );
}

export type Field = { name: string; type: string; required?: boolean; defaultValue?: string; description: ReactNode; children?: Field[] };

export function Fields({ title, fields }: { title: string; fields: Field[] }) {
  return (
    <section className="fields">
      <div className="fields-title">{title}</div>
      {fields.map((f) => <FieldRow key={f.name} field={f} />)}
    </section>
  );
}

function FieldRow({ field }: { field: Field }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="field-row">
      <div className="field-head">
        <span className="field-name">{field.name}</span>
        <span className="pill pill-type">{field.type}</span>
        {field.required && <span className="pill pill-required">required</span>}
        {field.defaultValue && <span className="field-default">default <code>{field.defaultValue}</code></span>}
      </div>
      <div className="field-desc">{field.description}</div>
      {field.children && (
        <>
          <button type="button" className="field-toggle" onClick={() => setOpen((o) => !o)}>
            <IconChevronRight size={14} className={open ? "open" : ""} />{open ? "Hide" : "Show"} child attributes
          </button>
          {open && <div className="field-children">{field.children.map((c) => <FieldRow key={c.name} field={c} />)}</div>}
        </>
      )}
    </div>
  );
}

export function Verb({ method, size = "sm" }: { method: Method; size?: "sm" | "lg" }) {
  return <span className={`verb verb-${method.toLowerCase()} verb-${size}`}>{size === "sm" && method === "DELETE" ? "DEL" : method}</span>;
}

export function EndpointBar({ method, path }: { method: Method; path: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="endpoint-bar">
      <Verb method={method} size="lg" />
      <code>{path}</code>
      <button type="button" className="endpoint-copy" aria-label="Copy path"
        onClick={async () => {
          if (await copyText(path)) {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1400);
          }
        }}>
        {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
      </button>
    </div>
  );
}

export function DocTable({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <div className="doc-table-wrap">
      <table className="doc-table">
        <thead><tr>{head.map((h) => <th key={h}>{h}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

export function Accordion({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="accordion">
      <summary><IconChevronRight size={16} />{title}</summary>
      <div className="accordion-body">{children}</div>
    </details>
  );
}
