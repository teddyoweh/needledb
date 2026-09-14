import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { IndexInfo } from "./api";

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

const integer = new Intl.NumberFormat("en-US");
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

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

export function structureLabel(info: Pick<IndexInfo, "index_type" | "annTypes" | "hnsw">) {
  const kinds = info.annTypes.length ? info.annTypes : [info.index_type === "hnsw" ? "hnsw" : "flat"];
  const text = kinds.map((k) => (k === "hnsw" ? `HNSW m=${info.hnsw.m}` : "Flat")).join(" + ");
  return info.index_type === "auto" ? `${text} (auto)` : text;
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
  if (!trimmed) return { ok: false, message: `Paste a JSON array of ${dimension} numbers, or generate a random one.` };
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return { ok: false, message: "Not valid JSON — expected an array like [0.12, -0.4, …]." };
  }
  if (!Array.isArray(value) || !value.every((x) => typeof x === "number" && Number.isFinite(x))) {
    return { ok: false, message: "The vector must be an array of finite numbers." };
  }
  if (value.length !== dimension) return { ok: false, message: `This index is ${dimension}-d; the vector has ${value.length} numbers.` };
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
    return { ok: false, message: `The ${what} is not valid JSON.` };
  }
}
