import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { AuditEvent, IndexInfo, Metadata, Role } from "./api";

/** Fixed categorical colours; an index keeps the same one everywhere. */
export const PALETTE = ["#2f6bff", "#12a189", "#f08a24", "#8b5cf6", "#e5487d", "#0ea5e9", "#65a30d"];

export function colorFor(name: string) {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[hash % PALETTE.length];
}

export function describeEvent(e: AuditEvent): string {
  const who = e.actorName ?? "Someone";
  const target = e.target ? `“${e.target}”` : "";
  switch (e.action) {
    case "auth.signed_in": return `${who} signed in`;
    case "auth.signed_out": return `${who} signed out`;
    case "auth.sign_in_failed": return "Failed sign-in attempt";
    case "auth.key_rejected": return "Request rejected: invalid API key";
    case "auth.blocked": return `Blocked ${e.ip ?? "a client"} after repeated failures`;
    case "auth.sessions_revoked": return `${who} ended every session`;
    case "key.created": return `${who} created ${e.detail?.role ? `${String(e.detail.role)} ` : ""}key ${target}`;
    case "key.revoked": return `${who} revoked key ${target}`;
    case "index.created": return `${who} created index ${target}`;
    case "index.deleted": return `${who} deleted index ${target}`;
    case "index.configured":
      return e.detail && "embed" in e.detail
        ? e.detail.embed ? `${who} connected ${String(e.detail.embed)} to ${target}` : `${who} disconnected the model from ${target}`
        : `${who} set ${target} search width to ${String(e.detail?.ef_search ?? "")}`;
    case "provider.key_set": return `${who} saved a ${e.target ?? "provider"} key ending ${String(e.detail?.hint ?? "")}`;
    case "provider.key_removed": return `${who} removed the ${e.target ?? "provider"} key`;
    default: return e.action;
  }
}

function subscribeHash(onChange: () => void) {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

/** Routes live in the hash (#/indexes/products/query?id=…) so the server needs no SPA fallback. */
export function useHashRoute() {
  const hash = useSyncExternalStore(subscribeHash, () => window.location.hash);
  const [path, query = ""] = (hash.replace(/^#/, "") || "/").split("?");
  return {
    parts: path.split("/").filter(Boolean).map(decodeURIComponent),
    params: new URLSearchParams(query),
  };
}

export function go(path: string) {
  window.location.hash = path;
}

/** Load now, then every `intervalMs` while the tab is visible. */
export function usePoll<T>(load: () => Promise<T>, intervalMs: number, deps: unknown[] = []) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<Error>();
  const loadRef = useRef(load);
  loadRef.current = load;

  const reload = useCallback(async () => {
    try {
      const next = await loadRef.current();
      setData(next);
      setError(undefined);
    } catch (err) {
      setError(err as Error);
    }
  }, []);

  useEffect(() => {
    void reload();
    const timer = window.setInterval(() => {
      if (!document.hidden) void reload();
    }, intervalMs);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload, intervalMs, ...deps]);

  return { data, error, reload, setData };
}

export const ROLE_RANK: Record<Role, number> = { read: 0, write: 1, admin: 2 };
export const ROLE_LABEL: Record<Role, string> = { read: "Read", write: "Read & write", admin: "Admin" };

const integer = new Intl.NumberFormat("en-US");
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

export const fmtInt = (n: number | null | undefined) => (n == null ? "—" : integer.format(n));
export const fmtCompact = (n: number | null | undefined) => (n == null ? "—" : compact.format(n));

export function fmtBytes(bytes: number | null | undefined) {
  if (bytes == null) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 && unit ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export function fmtMs(ms: number | null | undefined) {
  if (ms == null) return "—";
  if (ms < 1) return `${ms.toFixed(2)} ms`;
  if (ms < 100) return `${ms.toFixed(1)} ms`;
  return `${Math.round(ms)} ms`;
}

export function fmtDuration(seconds: number) {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
}

export function fmtRelative(epochSeconds: number | null | undefined) {
  if (!epochSeconds) return "Never";
  const delta = epochSeconds - Date.now() / 1000;
  const abs = Math.abs(delta);
  if (abs < 45) return delta <= 0 ? "Just now" : "In a moment";
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [
    ["minute", 60], ["hour", 3600], ["day", 86400], ["week", 604800], ["month", 2629800], ["year", 31557600],
  ];
  let unit = steps[0];
  for (const step of steps) if (abs >= step[1]) unit = step;
  const text = relative.format(Math.round(delta / unit[1]), unit[0]);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function structureLabel(info: Pick<IndexInfo, "index_type" | "annTypes" | "hnsw">) {
  const graph = info.annTypes.includes("hnsw") || (!info.annTypes.length && info.index_type === "hnsw");
  const text = graph ? `HNSW · m ${info.hnsw.m}` : "Flat";
  return info.index_type === "auto" ? `${text} · auto` : text;
}

const TITLE_FIELDS = ["title", "name", "label", "heading", "headline", "text", "summary", "description"];

/** The field a person would call a record by, when its metadata has one. */
export function titleOf(metadata?: Metadata | null): { field: string; text: string } | undefined {
  if (!metadata) return undefined;
  for (const field of TITLE_FIELDS) {
    const value = metadata[field];
    if (typeof value === "string" && value.trim()) return { field, text: value };
  }
  return undefined;
}

export function initials(name: string) {
  const words = name.replace(/[^\p{L}\p{N} ]/gu, " ").split(" ").filter(Boolean);
  return ((words[0]?.[0] ?? "N") + (words[1]?.[0] ?? "")).toUpperCase();
}

export function randomUnitVector(dimension: number): number[] {
  const v = new Array<number>(dimension);
  let sum = 0;
  for (let i = 0; i < dimension; i++) {
    let u = 0;
    while (u === 0) u = Math.random();
    v[i] = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random());
    sum += v[i] * v[i];
  }
  const norm = Math.sqrt(sum);
  return v.map((x) => Math.round((x / norm) * 1e6) / 1e6);
}

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

export function parseVector(text: string, dimension: number): Parsed<number[]> {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, message: `Paste ${dimension} numbers as a JSON array, or generate a random vector.` };
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return { ok: false, message: "That isn't valid JSON — expected an array like [0.12, -0.4, …]." };
  }
  if (!Array.isArray(value) || !value.every((x) => typeof x === "number" && Number.isFinite(x))) {
    return { ok: false, message: "The vector must be an array of finite numbers." };
  }
  if (value.length !== dimension) return { ok: false, message: `This index is ${dimension}-dimensional; the vector has ${value.length} numbers.` };
  return { ok: true, value };
}

export function parseObject(text: string, what: string): Parsed<Record<string, unknown> | undefined> {
  const trimmed = text.trim();
  if (!trimmed) return { ok: true, value: undefined };
  try {
    const value = JSON.parse(trimmed);
    if (value && typeof value === "object" && !Array.isArray(value)) return { ok: true, value };
    return { ok: false, message: `The ${what} must be a JSON object.` };
  } catch {
    return { ok: false, message: `The ${what} isn't valid JSON.` };
  }
}
