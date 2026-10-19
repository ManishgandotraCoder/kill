"use client";

import { useEffect, useRef, useState } from "react";
import {
  CandlestickSeries,
  ColorType,
  createChart,
  HistogramSeries,
  type MouseEventParams,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import type { Candle } from "@/lib/binance/klines";
import { currentTheme, OhlcReadout } from "../candle-chart";

type Row = [t: number, o: number, h: number, l: number, c: number, v: number];

/** Candles stored in our DB (not live). `version` bump = reload. */
export default function HistoryChart({ symbol, interval, version }: { symbol: string; interval: string; version: number }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<Candle | null>(null);
  const [meta, setMeta] = useState<{ key: string; count: number; truncated: boolean } | null>(null);
  const key = `${symbol}:${interval}:${version}`;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const theme = currentTheme();
    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: theme.surface },
        textColor: theme.text,
        fontFamily: "var(--font-geist-mono), monospace",
        panes: { separatorColor: theme.border },
      },
      grid: { vertLines: { color: theme.grid }, horzLines: { color: theme.grid } },
      rightPriceScale: { borderColor: theme.border },
      // Tiny min spacing so fitContent can show all ~44k hourly bars (5 years) at once.
      timeScale: { borderColor: theme.border, timeVisible: interval !== "1d", minBarSpacing: 0.001 },
      localization: { timeFormatter: (t: Time) => new Date((t as number) * 1000).toLocaleString() },
    });
    const candles = chart.addSeries(CandlestickSeries, {
      upColor: theme.up,
      downColor: theme.down,
      borderVisible: false,
      wickUpColor: theme.up,
      wickDownColor: theme.down,
    });
    const volume = chart.addSeries(
      HistogramSeries,
      { priceFormat: { type: "volume" }, priceLineVisible: false, lastValueVisible: false },
      1,
    );
    chart.panes()[1]?.setHeight(90);

    const byTime = new Map<number, Candle>();
    const ctrl = new AbortController();

    fetch(`/api/candles?symbol=${symbol}&interval=${interval}`, { signal: ctrl.signal })
      .then((r) => r.json() as Promise<{ candles: Row[]; truncated: boolean }>)
      .then(({ candles: rows, truncated }) => {
        candles.setData(rows.map(([t, o, h, l, c]) => ({ time: t as UTCTimestamp, open: o, high: h, low: l, close: c })));
        volume.setData(
          rows.map(([t, o, , , c, v]) => ({ time: t as UTCTimestamp, value: v, color: (c >= o ? theme.up : theme.down) + "66" })),
        );
        for (const [t, o, h, l, c, v] of rows) byTime.set(t, { time: t, open: o, high: h, low: l, close: c, volume: v, closed: true });
        setMeta({ key, count: rows.length, truncated });
        chart.timeScale().fitContent();
      })
      .catch(() => {});

    const onMove = (p: MouseEventParams) => setHover(p.time !== undefined ? (byTime.get(p.time as number) ?? null) : null);
    chart.subscribeCrosshairMove(onMove);

    return () => {
      ctrl.abort();
      chart.unsubscribeCrosshairMove(onMove);
      chart.remove();
    };
  }, [symbol, interval, key]);

  const current = meta?.key === key ? meta : null;

  return (
    <div>
      <div className="mb-2 flex min-h-5 flex-wrap items-center gap-x-4 text-xs text-zinc-500">
        {current && (
          <span>
            {current.count.toLocaleString()} candles from DB{current.truncated && " (latest only)"}
          </span>
        )}
        {hover && <OhlcReadout c={hover} />}
      </div>
      <div ref={containerRef} className="relative h-[460px] w-full overflow-hidden rounded border border-zinc-200 dark:border-zinc-800">
        {current?.count === 0 && (
          <p className="absolute inset-0 z-10 flex items-center justify-center text-zinc-500">
            No {interval} candles for {symbol} in the DB yet. Run a sync above.
          </p>
        )}
      </div>
    </div>
  );
}
