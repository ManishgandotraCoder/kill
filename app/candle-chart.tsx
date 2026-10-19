"use client";

import { useEffect, useRef, useState } from "react";
import {
  CandlestickSeries,
  ColorType,
  createChart,
  HistogramSeries,
  type IChartApi,
  type ISeriesApi,
  type MouseEventParams,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { getBinanceStream } from "@/lib/binance/stream";
import {
  Candle,
  candleFromEvent,
  fetchKlines,
  KLINE_INTERVALS,
  KlineEvent,
  KlineInterval,
  klineStreamName,
} from "@/lib/binance/klines";

export const THEMES = {
  light: { surface: "#fcfcfb", text: "#5f5e5a", grid: "#ecebe8", border: "#d9d8d4", up: "#0ca30c", down: "#d03b3b" },
  dark: { surface: "#1a1a19", text: "#a3a29d", grid: "#2a2a28", border: "#3a3a37", up: "#0ca30c", down: "#d03b3b" },
};

type Theme = (typeof THEMES)["light"];

export function currentTheme(): Theme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? THEMES.dark : THEMES.light;
}

function toBar(c: Candle) {
  return { time: c.time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close };
}

function toVolume(c: Candle, t: Theme) {
  // Semi-transparent so volume stays recessive next to the candles.
  return { time: c.time as UTCTimestamp, value: c.volume, color: (c.close >= c.open ? t.up : t.down) + "66" };
}

export default function CandleChart({ symbol }: { symbol: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [interval, setTimeframe] = useState<KlineInterval>("1m");
  const [hover, setHover] = useState<Candle | null>(null);
  const [last, setLast] = useState<Candle | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    let theme = currentTheme();
    const chart: IChartApi = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: theme.surface },
        textColor: theme.text,
        fontFamily: "var(--font-geist-mono), monospace",
        panes: { separatorColor: theme.border },
      },
      grid: { vertLines: { color: theme.grid }, horzLines: { color: theme.grid } },
      rightPriceScale: { borderColor: theme.border },
      timeScale: {
        borderColor: theme.border,
        timeVisible: true,
        secondsVisible: false,
        // lightweight-charts renders UTC by default; show the viewer's local time.
        tickMarkFormatter: (t: Time) => {
          const d = new Date((t as number) * 1000);
          return interval === "1d"
            ? d.toLocaleDateString(undefined, { month: "short", day: "numeric" })
            : d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
        },
      },
      localization: { timeFormatter: (t: Time) => new Date((t as number) * 1000).toLocaleString() },
    });

    const candles: ISeriesApi<"Candlestick"> = chart.addSeries(CandlestickSeries, {
      upColor: theme.up,
      downColor: theme.down,
      borderVisible: false,
      wickUpColor: theme.up,
      wickDownColor: theme.down,
    });
    // Volume in its own pane (own axis, not overlaid on price).
    const volume: ISeriesApi<"Histogram"> = chart.addSeries(
      HistogramSeries,
      { priceFormat: { type: "volume" }, priceLineVisible: false, lastValueVisible: false },
      1,
    );
    chart.panes()[1]?.setHeight(90);

    const byTime = new Map<number, Candle>();
    let latest: Candle | null = null;
    let loaded = false;
    let pending: Candle[] = [];
    let cancelled = false;

    const push = (c: Candle) => {
      if (latest && c.time < latest.time) return; // series.update only accepts the newest bar
      byTime.set(c.time, c);
      candles.update(toBar(c));
      volume.update(toVolume(c, theme));
      latest = c;
      setLast(c);
    };

    // Subscribe first, buffer until history arrives so no candle update is lost.
    const unsub = getBinanceStream().on(klineStreamName(symbol, interval), (d) => {
      const c = candleFromEvent(d as KlineEvent);
      if (loaded) push(c);
      else pending.push(c);
    });

    setError(null);
    fetchKlines(symbol, interval)
      .then((history) => {
        if (cancelled) return;
        history.forEach((c) => byTime.set(c.time, c));
        candles.setData(history.map(toBar));
        volume.setData(history.map((c) => toVolume(c, theme)));
        latest = history.at(-1) ?? null;
        setLast(latest);
        loaded = true;
        pending.forEach(push);
        pending = [];
        chart.timeScale().scrollToRealTime();
      })
      .catch((err) => !cancelled && setError(String(err)));

    const onMove = (p: MouseEventParams) => {
      setHover(p.time !== undefined ? (byTime.get(p.time as number) ?? null) : null);
    };
    chart.subscribeCrosshairMove(onMove);

    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onScheme = () => {
      theme = currentTheme();
      chart.applyOptions({
        layout: { background: { type: ColorType.Solid, color: theme.surface }, textColor: theme.text, panes: { separatorColor: theme.border } },
        grid: { vertLines: { color: theme.grid }, horzLines: { color: theme.grid } },
        rightPriceScale: { borderColor: theme.border },
        timeScale: { borderColor: theme.border },
      });
    };
    mq.addEventListener("change", onScheme);

    return () => {
      cancelled = true;
      unsub();
      mq.removeEventListener("change", onScheme);
      chart.unsubscribeCrosshairMove(onMove);
      chart.remove();
      setHover(null);
      setLast(null);
    };
  }, [symbol, interval]);

  const shown = hover ?? last;

  return (
    <section className="mb-8">
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex gap-1" role="group" aria-label="Candle interval">
          {KLINE_INTERVALS.map((i) => (
            <button
              key={i}
              onClick={() => setTimeframe(i)}
              aria-pressed={i === interval}
              className={`rounded px-2 py-0.5 ${
                i === interval
                  ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-black"
                  : "text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
              }`}
            >
              {i}
            </button>
          ))}
        </div>
        {shown && <OhlcReadout c={shown} />}
      </div>
      <div ref={containerRef} className="h-[420px] w-full overflow-hidden rounded border border-zinc-200 dark:border-zinc-800" />
      {error && <p className="mt-2 text-rose-600">{error}</p>}
    </section>
  );
}

export function OhlcReadout({ c }: { c: Candle }) {
  const up = c.close >= c.open;
  const pct = ((c.close - c.open) / c.open) * 100;
  return (
    <span className="text-xs text-zinc-500">
      {new Date(c.time * 1000).toLocaleString()} · O <b className="text-foreground font-normal">{fmt(c.open)}</b> H{" "}
      <b className="text-foreground font-normal">{fmt(c.high)}</b> L <b className="text-foreground font-normal">{fmt(c.low)}</b> C{" "}
      <b className="text-foreground font-normal">{fmt(c.close)}</b>{" "}
      <span className={up ? "text-emerald-600" : "text-rose-600"}>
        {up ? "▲" : "▼"} {pct.toFixed(2)}%
      </span>{" "}
      · Vol <b className="text-foreground font-normal">{c.volume.toFixed(2)}</b>
    </span>
  );
}

function fmt(n: number): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 8 });
}
