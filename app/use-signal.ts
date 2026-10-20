"use client";

import { useEffect, useState } from "react";
import type { ModelSummary, Signal } from "@/lib/signal";

// Current AI signal for a symbol + chosen look-ahead, shared by the signal card and the chart's
// forecast line. Polls every 30 s (a new 1m candle closes every minute).

export type SignalData = Omit<Signal, "recent">;

const REFRESH_MS = 30_000;

export interface SignalState {
  models: ModelSummary[];
  choice: { interval: string; horizon: number };
  setChoice: (c: { interval: string; horizon: number }) => void;
  /** Query string identifying symbol + model (also used to key explanations). */
  query: string;
  data?: SignalData;
  error?: string;
  loading: boolean;
}

export function useSignal(symbol: string): SignalState {
  const [models, setModels] = useState<{ symbol: string; list: ModelSummary[] } | null>(null);
  const [choice, setChoice] = useState({ interval: "1m", horizon: 15 });
  const query = `symbol=${symbol}&interval=${choice.interval}&horizon=${choice.horizon}`;
  const [state, setState] = useState<{ query: string; data?: SignalData; error?: string } | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    fetch(`/api/signal/models?symbol=${symbol}`, { signal: ctrl.signal, cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((b: { models: ModelSummary[] }) => setModels({ symbol, list: b.models }))
      .catch(() => {});
    return () => ctrl.abort();
  }, [symbol]);

  useEffect(() => {
    let ctrl = new AbortController();
    const load = () => {
      ctrl.abort();
      ctrl = new AbortController();
      fetch(`/api/signal?${query}`, { signal: ctrl.signal, cache: "no-store" })
        .then(async (r) => (r.ok ? r.json() : Promise.reject(new Error((await r.text()) || `HTTP ${r.status}`))))
        .then((data: SignalData) => setState({ query, data }))
        .catch((e: Error) => e.name !== "AbortError" && setState({ query, error: e.message }));
    };
    load();
    const timer = window.setInterval(load, REFRESH_MS);
    return () => {
      ctrl.abort();
      window.clearInterval(timer);
    };
  }, [query]);

  const s = state?.query === query ? state : null;
  return {
    models: models?.symbol === symbol ? models.list : [],
    choice,
    setChoice,
    query,
    data: s?.data,
    error: s?.error,
    loading: !s,
  };
}
