"use client";

import { useEffect, useState } from "react";

/** A discovered pattern, as much as the chart needs to mark it. */
export interface DiscoveredLite {
  id: string;
  key: string;
  direction: "up" | "down";
  description: string;
}

const EMPTY: DiscoveredLite[] = [];

/** Confirmed + weak discovered patterns for a symbol (failed ones were luck). */
export function useDiscovered(symbol: string): DiscoveredLite[] {
  const [state, setState] = useState<{ symbol: string; list: DiscoveredLite[] } | null>(null);
  useEffect(() => {
    const ctrl = new AbortController();
    fetch(`/api/discovered?symbol=${symbol}`, { signal: ctrl.signal, cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: { patterns: (DiscoveredLite & { tier: string })[] }) =>
        setState({ symbol, list: d.patterns.filter((p) => p.tier !== "failed").map(({ id, key, direction, description }) => ({ id, key, direction, description })) }),
      )
      .catch(() => {});
    return () => ctrl.abort();
  }, [symbol]);
  return state?.symbol === symbol ? state.list : EMPTY;
}
