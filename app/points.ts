"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import type { Explanation } from "@/lib/predict";

export const HOUR_MS = 3_600_000;

// ---- picked points (kept in this browser) ---------------------------------

export interface Point {
  id: string;
  symbol: string;
  /** Open time (ms) of the 1-hour candle this point predicts. */
  hourTs: number;
}

const STORAGE_KEY = "bit.points.v1";
const EMPTY: Point[] = [];
let points: Point[] | null = null;
const listeners = new Set<() => void>();

function read(): Point[] {
  if (points === null) {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
      points = Array.isArray(parsed) ? parsed : [];
    } catch {
      points = [];
    }
  }
  return points!;
}

function write(next: Point[]) {
  points = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // storage unavailable (private mode) - points just won't survive a reload
  }
  listeners.forEach((l) => l());
}

export function usePoints(): Point[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    read,
    () => EMPTY,
  );
}

/** Adds a point for the hour containing `timeMs`; returns the (new or existing) point. */
export function addPoint(symbol: string, timeMs: number): Point {
  const hourTs = Math.floor(timeMs / HOUR_MS) * HOUR_MS;
  const existing = read().find((p) => p.symbol === symbol && p.hourTs === hourTs);
  if (existing) return existing;
  const point = { id: `${symbol}-${hourTs}`, symbol, hourTs };
  write([...read(), point].sort((a, b) => a.hourTs - b.hourTs));
  return point;
}

export function removePoint(id: string) {
  write(read().filter((p) => p.id !== id));
}

export function clearPoints(symbol: string) {
  write(read().filter((p) => p.symbol !== symbol));
}

// ---- explanations (/api/explain), cached per symbol + hour ----------------

const cache = new Map<string, Promise<Explanation>>();

function fetchExplanation(symbol: string, hourTs: number | null, version: string): Promise<Explanation> {
  const key = `${symbol}:${hourTs ?? "now"}:${version}`;
  let p = cache.get(key);
  if (!p) {
    const q = new URLSearchParams({ symbol });
    if (hourTs !== null) q.set("at", String(hourTs));
    p = fetch(`/api/explain?${q}`, { cache: "no-store" }).then(async (res) => {
      if (!res.ok) throw new Error(await res.text());
      return res.json() as Promise<Explanation>;
    });
    p.catch(() => cache.delete(key)); // let errors retry
    cache.set(key, p);
  }
  return p;
}

/**
 * Closed hours never change, so only still-open hours carry `version` (the
 * current hour's open time) in their cache key and re-fetch when it moves on.
 */
function versionFor(hourTs: number | null, version: string): string {
  const current = Number(version);
  return hourTs === null || !current || hourTs >= current ? version : "closed";
}

/** Explanation for the hour `hourTs` (null = the current hour). `version` = current hour's open time. */
export function useExplanation(symbol: string, hourTs: number | null, version: string) {
  const v = versionFor(hourTs, version);
  const key = `${symbol}:${hourTs ?? "now"}:${v}`;
  const [state, setState] = useState<{ key: string; data: Explanation | null; error: string | null } | null>(null);

  useEffect(() => {
    let alive = true;
    fetchExplanation(symbol, hourTs, v).then(
      (data) => alive && setState({ key, data, error: null }),
      (e) => alive && setState({ key, data: null, error: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      alive = false;
    };
  }, [symbol, hourTs, v, key]);

  return state?.key === key ? state : { key, data: null, error: null };
}

type Result = { data: Explanation | null; error: string | null };

/** Explanations for many hours at once; entries fill in as each one arrives. */
export function useExplanationList(symbol: string, hours: number[], version: string): Map<number, Result> {
  const sig = hours.map((h) => `${h}:${versionFor(h, version)}`).join(",");
  const key = `${symbol}|${sig}`;
  const [state, setState] = useState<{ key: string; map: Map<number, Result> } | null>(null);

  useEffect(() => {
    let alive = true;
    for (const entry of sig ? sig.split(",") : []) {
      const [h, v] = entry.split(":");
      const hourTs = Number(h);
      const put = (r: Result) =>
        alive &&
        setState((prev) => {
          const map = new Map(prev?.key === key ? prev.map : []);
          map.set(hourTs, r);
          return { key, map };
        });
      fetchExplanation(symbol, hourTs, v).then(
        (data) => put({ data, error: null }),
        (e) => put({ data: null, error: e instanceof Error ? e.message : String(e) }),
      );
    }
    return () => {
      alive = false;
    };
  }, [symbol, sig, key]);

  return state?.key === key ? state.map : new Map();
}

// ---- saved predictions (DB, via /api/predictions) -------------------------

export interface SavedPrediction {
  symbol: string;
  targetTs: number;
  source: string; // "auto", "manual" or "auto + manual"
  base: number;
  predicted: number;
  lower: number;
  upper: number;
  actual: number | null;
}

/** Every prediction stored for `symbol`, newest first; refreshes every minute. */
export function useSavedPredictions(symbol: string, version: string) {
  const [state, setState] = useState<{ symbol: string; rows: SavedPrediction[] } | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    fetch(`/api/predictions?symbol=${symbol}`, { signal: ctrl.signal, cache: "no-store" })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((d: { rows: SavedPrediction[] }) => setState({ symbol, rows: d.rows }))
      .catch(() => {});
    const timer = setTimeout(() => setTick((t) => t + 1), 60_000);
    return () => {
      ctrl.abort();
      clearTimeout(timer);
    };
  }, [symbol, version, tick]);

  return state?.symbol === symbol ? state.rows : null;
}

// ---- formatting -----------------------------------------------------------

export function hm(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
}

export function hourLabel(ms: number): string {
  const d = new Date(ms);
  return `${d.toLocaleDateString(undefined, { day: "numeric", month: "short" })} ${hm(ms)}–${hm(ms + HOUR_MS)}`;
}

export function signedPct(p: number, digits = 3): string {
  return `${p >= 0 ? "+" : ""}${p.toFixed(digits)}%`;
}

export function price(n: number): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
