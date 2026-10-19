"use client";

import { useEffect, useState } from "react";
import { BookState, BookView, LocalOrderBook } from "./orderbook";
import { getBinanceStream, StreamStatus } from "./stream";

/** Latest payload from a stream, e.g. "btcusdt@ticker". */
export function useBinanceStream<T>(streamName: string | null): T | null {
  // Keyed by stream so switching streams never shows the previous stream's data.
  const [latest, setLatest] = useState<{ stream: string; data: T } | null>(null);
  useEffect(() => {
    if (!streamName) return;
    return getBinanceStream().on(streamName, (d) => setLatest({ stream: streamName, data: d as T }));
  }, [streamName]);
  return latest?.stream === streamName ? latest.data : null;
}

export function useStreamStatus(): StreamStatus {
  const [status, setStatus] = useState<StreamStatus>("idle");
  useEffect(() => getBinanceStream().onStatus(setStatus), []);
  return status;
}

/** Synced local order book, re-rendered at most every `throttleMs`. */
export function useOrderBook(symbol: string, depth = 15, throttleMs = 200) {
  const [view, setView] = useState<BookView | null>(null);
  const [state, setState] = useState<BookState>("syncing");

  useEffect(() => {
    const book = new LocalOrderBook(symbol, { speed: "100ms" });
    let timer: ReturnType<typeof setTimeout> | null = null;

    const unsubBook = book.subscribe(() => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        setView(book.view(depth));
      }, throttleMs);
    });
    const unsubState = book.onState(setState);
    book.start();

    return () => {
      if (timer) clearTimeout(timer);
      unsubBook();
      unsubState();
      book.stop();
      setView(null);
    };
  }, [symbol, depth, throttleMs]);

  return { view, state };
}
