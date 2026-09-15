import {
  type ButtonHTMLAttributes,
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { Metadata } from "./api";
import { Sparkline } from "./charts";
import { IconCheck, IconCopy, IconIndexes, IconTrendDown, IconTrendUp, IconX } from "./icons";
import { colorFor, copyText, initials } from "./lib";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "danger-solid";

export function Button({ variant = "secondary", size = "md", icon, block, className = "", children, ...rest }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md" | "lg"; icon?: ReactNode; block?: boolean }) {
  return (
    <button type="button" {...rest}
      className={`btn btn-${variant} btn-${size} ${block ? "btn-block" : ""} ${className}`.trim()}>
      {icon}
      {children}
    </button>
  );
}

export function IconButton({ label, children, className = "", ...rest }:
  ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button type="button" aria-label={label} title={label} {...rest} className={`icon-button ${className}`.trim()}>
      {children}
    </button>
  );
}

export type Tone = "neutral" | "good" | "warn" | "bad" | "accent";

export function Badge({ tone = "neutral", children, dot }: { tone?: Tone; children: ReactNode; dot?: boolean }) {
  return <span className={`badge badge-${tone}`}>{dot && <i className="badge-dot" />}{children}</span>;
}

export function Dot({ tone = "neutral" }: { tone?: Tone }) {
  return <span className={`dot dot-${tone}`} aria-hidden="true" />;
}

export function Delta({ value, invert = false, suffix }: { value: number | null; invert?: boolean; suffix?: string }) {
  if (value == null || !Number.isFinite(value)) {
    return <span className="delta flat">No change yet{suffix ? <span className="delta-suffix"> {suffix}</span> : null}</span>;
  }
  const up = value > 0.5;
  const down = value < -0.5;
  const good = invert ? down : up;
  const bad = invert ? up : down;
  return (
    <span className={`delta ${good ? "good" : bad ? "bad" : "flat"}`}>
      {up ? <IconTrendUp size={13} /> : down ? <IconTrendDown size={13} /> : null}
      {`${value > 0 ? "+" : ""}${value.toFixed(1)}%`}
      {suffix && <span className="delta-suffix">{suffix}</span>}
    </span>
  );
}

export function PageHeader({ title, subtitle, actions, children }: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="page-head">
      <div className="page-head-row">
        <div className="page-head-text">
          <h1 className="title">{title}</h1>
          {subtitle && <p className="subtitle">{subtitle}</p>}
        </div>
        {actions && <div className="page-actions">{actions}</div>}
      </div>
      {children}
    </header>
  );
}

export function Card({ icon, title, subtitle, actions, children, className = "", flush = false }: {
  icon?: ReactNode;
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  flush?: boolean;
}) {
  return (
    <section className={`card ${className}`.trim()}>
      {(title || actions) && (
        <header className="card-head">
          <div className="card-title">
            {icon && <span className="card-icon">{icon}</span>}
            <div className="card-titles">
              {title && <h2>{title}</h2>}
              {subtitle && <p>{subtitle}</p>}
            </div>
          </div>
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      <div className={flush ? "card-body flush" : "card-body"}>{children}</div>
    </section>
  );
}

export function Stat({ icon, label, value, hint, spark, color }: {
  icon: ReactNode;
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  spark?: (number | null)[];
  color?: string;
}) {
  return (
    <div className="stat">
      <div className="stat-top"><span className="card-icon">{icon}</span>{label}</div>
      <div className="stat-row">
        <div className="stat-value">{value}</div>
        {spark && <Sparkline values={spark} color={color} />}
      </div>
      {hint && <span className="stat-hint">{hint}</span>}
    </div>
  );
}

export function PropertyList({ items }: { items: { icon: ReactNode; label: string; value: ReactNode }[] }) {
  return (
    <dl className="props">
      {items.map((item) => (
        <div key={item.label} className="prop">
          <dt><span className="prop-icon">{item.icon}</span>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function IndexAvatar({ name, size = 34 }: { name: string; size?: number }) {
  const color = colorFor(name);
  return (
    <span className="index-avatar" style={{ width: size, height: size, background: `${color}17`, color }}>
      <IconIndexes size={Math.round(size * 0.5)} />
    </span>
  );
}

export function Field({ label, hint, htmlFor, children, className = "", aside }: {
  label: string;
  hint?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
  aside?: ReactNode;
}) {
  return (
    <div className={`field ${className}`.trim()}>
      <div className="field-label"><label htmlFor={htmlFor}>{label}</label>{aside}</div>
      {children}
      {hint && <div className="field-hint">{hint}</div>}
    </div>
  );
}

/** Pills for choosing an option inside a form. */
export function Choice<T extends string>({ value, options, onChange, label }: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div className="choice" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value}
          className={o.value === value ? "on" : ""} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A compact switch for views and time ranges. */
export function Segmented<T extends string>({ value, options, onChange, label }: {
  value: T;
  options: { value: T; label: ReactNode }[];
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

export function Tabs({ items, current, label }: { items: { id: string; label: string; href: string }[]; current: string; label: string }) {
  return (
    <nav className="tabs" aria-label={label}>
      {items.map((t) => (
        <a key={t.id} href={t.href} className={t.id === current ? "active" : ""} aria-current={t.id === current ? "page" : undefined}>
          {t.label}
        </a>
      ))}
    </nav>
  );
}

export function Menu({ trigger, children, direction = "down", className = "" }: {
  trigger: (state: { open: boolean; toggle: () => void }) => ReactNode;
  children: (close: () => void) => ReactNode;
  direction?: "down" | "up";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className={`menu-anchor ${className}`.trim()} ref={ref}>
      {trigger({ open, toggle: () => setOpen((o) => !o) })}
      {open && <div className={`menu menu-${direction}`} role="menu">{children(() => setOpen(false))}</div>}
    </div>
  );
}

export function MenuItem({ icon, children, onClick, tone }: { icon?: ReactNode; children: ReactNode; onClick: () => void; tone?: "bad" }) {
  return (
    <button type="button" role="menuitem" className={`menu-item ${tone ?? ""}`.trim()} onClick={onClick}>
      {icon}
      <span>{children}</span>
    </button>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <div className="menu-label">{children}</div>;
}

export function MenuDivider() {
  return <div className="menu-divider" role="separator" />;
}

export function Empty({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      {icon && <div className="empty-icon">{icon}</div>}
      <strong>{title}</strong>
      {children && <p>{children}</p>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}

export function ErrorNote({ error }: { error?: Error | string | null }) {
  if (!error) return null;
  return <div className="note note-bad" role="alert">{typeof error === "string" ? error : error.message}</div>;
}

export function Skeleton({ height = 16, width = "100%", radius }: { height?: number | string; width?: number | string; radius?: number }) {
  return <div className="skeleton" style={{ height, width, borderRadius: radius }} />;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

export function Avatar({ name, size = 32 }: { name: string; size?: number }) {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) % 360;
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: size * 0.38, background: `hsl(${hash} 70% 92%)`, color: `hsl(${hash} 45% 32%)` }}>
      {initials(name)}
    </span>
  );
}

export function CopyButton({ text, label = "Copy", size = "sm", variant = "secondary" }: {
  text: string;
  label?: string;
  size?: "sm" | "md";
  variant?: Variant;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <Button size={size} variant={variant} icon={copied ? <IconCheck size={15} /> : <IconCopy size={15} />}
      onClick={async () => {
        if (await copyText(text)) {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1600);
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
      {options.map((ns) => <option key={ns} value={ns}>{ns === "" ? "Default" : ns}</option>)}
    </select>
  );
}

export function MetadataChips({ metadata, omit = [], limit = 6 }: { metadata?: Metadata | null; omit?: string[]; limit?: number }) {
  const entries = Object.entries(metadata ?? {}).filter(([k]) => !omit.includes(k));
  if (!entries.length) return null;
  return (
    <span className="chips">
      {entries.slice(0, limit).map(([k, v]) => {
        const text = Array.isArray(v) ? v.join(", ") : String(v);
        return (
          <span key={k} className="chip" title={`${k}: ${text}`}>
            <span className="chip-k">{k}</span>
            <span className="chip-v">{text.length > 48 ? `${text.slice(0, 48)}…` : text}</span>
          </span>
        );
      })}
      {entries.length > limit && <span className="chip chip-more">+{entries.length - limit}</span>}
    </span>
  );
}

export function Sheet({ open, onClose, title, subtitle, children, footer, width = 520 }: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);

  if (!open) return null;
  // Rendered at the document root: an animated (transformed) page would otherwise
  // become the containing block for position: fixed and trap the sheet inside it.
  return createPortal(
    <div className="sheet-root" role="dialog" aria-modal="true" aria-label={title}>
      <div className="scrim" onMouseDown={onClose} />
      <aside className="sheet" style={{ width: `min(${width}px, calc(100vw - 20px))` }}>
        <header className="sheet-head">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <IconButton label="Close" onClick={onClose}><IconX size={18} /></IconButton>
        </header>
        <div className="sheet-body">{children}</div>
        {footer && <footer className="sheet-foot">{footer}</footer>}
      </aside>
    </div>,
    document.body,
  );
}

type ToastTone = "default" | "good" | "bad";
type Toast = { id: number; message: string; tone: ToastTone };
const ToastContext = createContext<(message: string, tone?: ToastTone) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((message: string, tone: ToastTone = "default") => {
    const id = Date.now() + Math.random();
    setToasts((all) => [...all.slice(-2), { id, message, tone }]);
    window.setTimeout(() => setToasts((all) => all.filter((t) => t.id !== id)), 3400);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone}`}>
            {t.tone === "good" && <IconCheck size={16} />}
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
