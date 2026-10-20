"use client";

import { useCallback, useEffect, useState } from "react";
import type { Prediction, PredictionStats } from "@/lib/predictions";

// Prediction sessions for a symbol: polled every 5 s (the server scores finished ones on each read),
// plus start / cancel actions that refresh the list right away.

const POLL_MS = 5000;

export interface PredictionsState {
  running: Prediction[];
  history: Prediction[];
  stats: PredictionStats | null;
  loading: boolean;
  error?: string;
  start: (minutes: number) => Promise<void>;
  cancel: (id: number) => Promise<void>;
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { cache: "no-store", ...init });
  if (!r.ok) throw new Error((await r.text()) || `HTTP ${r.status}`);
  return r.json();
}

/** `enabled` = logged in; predictions belong to the user, so nothing is fetched when logged out. */
export function usePredictions(symbol: string, enabled: boolean): PredictionsState {
  const [state, setState] = useState<{ symbol: string; running: Prediction[]; history: Prediction[]; stats: PredictionStats | null; error?: string } | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let ctrl = new AbortController();
    const load = () => {
      ctrl.abort();
      ctrl = new AbortController();
      call<{ running: Prediction[]; history: Prediction[]; stats: PredictionStats }>(`/api/predictions?symbol=${symbol}`, { signal: ctrl.signal })
        .then((d) => setState({ symbol, ...d }))
        .catch((e: Error) => e.name !== "AbortError" && setState((s) => ({ symbol, running: s?.running ?? [], history: s?.history ?? [], stats: s?.stats ?? null, error: e.message })));
    };
    load();
    const timer = window.setInterval(load, POLL_MS);
    return () => {
      ctrl.abort();
      window.clearInterval(timer);
    };
  }, [symbol, tick, enabled]);

  const start = useCallback(
    async (minutes: number) => {
      await call("/api/predictions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ symbol, minutes }) });
      setTick((t) => t + 1);
    },
    [symbol],
  );
  const cancel = useCallback(async (id: number) => {
    await call(`/api/predictions/${id}/cancel`, { method: "POST" });
    setTick((t) => t + 1);
  }, []);

  const s = enabled && state?.symbol === symbol ? state : null;
  return { running: s?.running ?? [], history: s?.history ?? [], stats: s?.stats ?? null, loading: enabled && !s, error: s?.error, start, cancel };
}
