"use client";

import { useEffect, useRef, useState } from "react";
import {
  CandlestickSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  HistogramSeries,
  TickMarkType,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
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
import { sequenceKey } from "@/lib/candle-code";
import { detectMask, patternsIn, type PatternDef } from "@/lib/patterns";
import type { DiscoveredLite } from "./discovered";

export const THEMES = {
  light: { surface: "#fcfcfb", text: "#5f5e5a", grid: "#ecebe8", border: "#d9d8d4", up: "#0ca30c", down: "#d03b3b", discovered: "#6250d6" },
  dark: { surface: "#1a1a19", text: "#a3a29d", grid: "#2a2a28", border: "#3a3a37", up: "#0ca30c", down: "#d03b3b", discovered: "#9085e9" },
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

const BAR_SECONDS: Record<KlineInterval, number> = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };

interface Props {
  symbol: string;
  /** Discovered patterns to mark (1h chart only - they were found on 1h candles). */
  discovered?: DiscoveredLite[];
}

export default function CandleChart({ symbol, discovered = [] }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const markersRef = useRef<{ api: ISeriesMarkersPluginApi<Time>; byTime: Map<number, Candle> } | null>(null);
  const nowLineRef = useRef<HTMLDivElement>(null);
  const nowLabelRef = useRef<HTMLSpanElement>(null);
  const [interval, setTimeframe] = useState<KlineInterval>("1m");
  const [hover, setHover] = useState<Candle | null>(null);
  const [last, setLast] = useState<Candle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadedKey, setLoadedKey] = useState("");
  const [closedTick, setClosedTick] = useState(0);
  const [showPatterns, setShowPatterns] = useState(true);
  const [showDiscovered, setShowDiscovered] = useState(true);
  const [hoverPatterns, setHoverPatterns] = useState<PatternDef[]>([]);
  const [hoverDiscovered, setHoverDiscovered] = useState<DiscoveredLite[]>([]);
  const discoveredAtRef = useRef(new Map<number, DiscoveredLite[]>());
  /** Patterns completed at each bar (time in seconds), for the hover readout. */
  const patternsAtRef = useRef(new Map<number, PatternDef[]>());


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
        // Day/month/year ticks show the date, intraday ticks the time.
        tickMarkFormatter: (t: Time, type: TickMarkType) => {
          const d = new Date((t as number) * 1000);
          return type === TickMarkType.Time || type === TickMarkType.TimeWithSeconds
            ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false })
            : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
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
    markersRef.current = { api: createSeriesMarkers(candles, []), byTime };
    let latest: Candle | null = null;
    let loaded = false;
    let pending: Candle[] = [];
    let cancelled = false;

    const push = (c: Candle) => {
      if (latest && c.time < latest.time) return; // series.update only accepts the newest bar
      const closedNow = c.closed && !byTime.get(c.time)?.closed;
      byTime.set(c.time, c);
      candles.update(toBar(c));
      volume.update(toVolume(c, theme));
      latest = c;
      setLast(c);
      if (closedNow) setClosedTick((x) => x + 1); // a candle finished: re-scan patterns
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
        updateNow();
        setLoadedKey(`${symbol}:${interval}:${Date.now()}`); // re-apply markers now that bars exist
      })
      .catch((err) => !cancelled && setError(String(err)));

    // Dotted "now" line: position = current candle's index + how far into it we are.
    const timeScale = chart.timeScale();
    const step = BAR_SECONDS[interval];
    const updateNow = () => {
      const line = nowLineRef.current;
      if (!line) return;
      const nowSec = Date.now() / 1000;
      const barOpen = Math.floor(nowSec / step) * step;
      const x0 = timeScale.timeToCoordinate(barOpen as UTCTimestamp);
      // Next bar may not exist yet (the live candle is the last one) - fall back to bar spacing.
      const x1 = timeScale.timeToCoordinate((barOpen + step) as UTCTimestamp);
      const spacing = x1 !== null && x0 !== null ? x1 - x0 : timeScale.options().barSpacing;
      const x = x0 === null ? null : x0 + ((nowSec - barOpen) / step) * spacing;
      if (x === null || x < 0 || x > timeScale.width()) {
        line.style.display = "none";
        return;
      }
      line.style.display = "block";
      line.style.transform = `translateX(${Math.round(x) + 1}px)`; // +1 for the container border
      line.style.bottom = `${timeScale.height() + 1}px`;
      if (nowLabelRef.current) {
        nowLabelRef.current.textContent = new Date().toLocaleTimeString(undefined, { hour12: false });
      }
    };
    timeScale.subscribeVisibleLogicalRangeChange(updateNow);
    timeScale.subscribeSizeChange(updateNow);
    const nowTimer = window.setInterval(updateNow, 1000);

    const onMove = (p: MouseEventParams) => {
      setHover(p.time !== undefined ? (byTime.get(p.time as number) ?? null) : null);
      setHoverPatterns(p.time !== undefined ? (patternsAtRef.current.get(p.time as number) ?? []) : []);
      setHoverDiscovered(p.time !== undefined ? (discoveredAtRef.current.get(p.time as number) ?? []) : []);
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
      markersRef.current = null;
      window.clearInterval(nowTimer);
      timeScale.unsubscribeVisibleLogicalRangeChange(updateNow);
      timeScale.unsubscribeSizeChange(updateNow);
      chart.remove();
      setHover(null);
      setLast(null);
    };
  }, [symbol, interval]);

  // Pattern markers (classic + discovered) on the loaded candles.
  useEffect(() => {
    const m = markersRef.current;
    if (!m) return;
    const theme = currentTheme();

    // Candlestick patterns on the closed candles currently loaded.
    const closed = [...m.byTime.values()].filter((c) => c.closed).sort((a, b) => a.time - b.time);
    const ohlc = closed.map((c) => ({ o: c.open, h: c.high, l: c.low, c: c.close }));
    const at = new Map<number, PatternDef[]>();
    closed.forEach((c, i) => {
      const found = patternsIn(detectMask(ohlc, i));
      if (found.length) at.set(c.time, found);
    });
    patternsAtRef.current = at;
    const patternMarkers = showPatterns
      ? [...at].flatMap(([time, found]) => {
          // Doji / spinning top are everywhere; keep markers for directional patterns.
          const shown = found.filter((p) => p.textbook !== "neutral");
          if (!shown.length) return [];
          const ups = shown.filter((p) => p.textbook === "up");
          const downs = shown.filter((p) => p.textbook === "down");
          return [
            ...(ups.length ? [{ time: time as UTCTimestamp, position: "belowBar" as const, shape: "arrowUp" as const, color: theme.up, text: ups.map((p) => p.code).join(" "), size: 0.7 }] : []),
            ...(downs.length ? [{ time: time as UTCTimestamp, position: "aboveBar" as const, shape: "arrowDown" as const, color: theme.down, text: downs.map((p) => p.code).join(" "), size: 0.7 }] : []),
          ];
        })
      : [];

    // Discovered sequences (found on 1h candles, so only marked on the 1h chart).
    const byKey = new Map(discovered.map((d) => [d.key, d]));
    const found = new Map<number, DiscoveredLite[]>();
    if (interval === "1h" && byKey.size) {
      closed.forEach((c, i) => {
        const hits: DiscoveredLite[] = [];
        for (let len = 1; len <= 3; len++) {
          const key = sequenceKey(ohlc, i, len);
          const hit = key && byKey.get(key);
          if (hit) hits.push(hit);
        }
        if (hits.length) found.set(c.time, hits);
      });
    }
    discoveredAtRef.current = found;
    const discoveredMarkers = showDiscovered
      ? [...found].map(([time, hits]) => ({
          time: time as UTCTimestamp,
          position: hits[0].direction === "up" ? ("belowBar" as const) : ("aboveBar" as const),
          shape: "circle" as const,
          color: theme.discovered,
          text: hits.map((h) => `★${h.id}`).join(" "),
          size: 0.7,
        }))
      : [];

    m.api.setMarkers([...patternMarkers, ...discoveredMarkers].sort((a, b) => (a.time as number) - (b.time as number)));
  }, [interval, loadedKey, closedTick, showPatterns, showDiscovered, discovered]);

  const shown = hover ?? last;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex gap-0.5 rounded-lg bg-panel-2 p-0.5" role="group" aria-label="Candle interval">
          {KLINE_INTERVALS.map((i) => (
            <button
              key={i}
              onClick={() => setTimeframe(i)}
              aria-pressed={i === interval}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                i === interval ? "bg-panel text-foreground shadow-sm" : "text-muted hover:text-foreground"
              }`}
            >
              {i}
            </button>
          ))}
        </div>
        <button
          onClick={() => setShowPatterns(!showPatterns)}
          aria-pressed={showPatterns}
          className={`rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${showPatterns ? "bg-foreground text-background" : "bg-panel-2 text-muted hover:text-foreground"}`}
          title="Mark the 20 classic candlestick patterns"
        >
          Classic
        </button>
        <button
          onClick={() => setShowDiscovered(!showDiscovered)}
          aria-pressed={showDiscovered}
          disabled={interval !== "1h"}
          className={`-ml-2 rounded-lg px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-40 ${showDiscovered ? "bg-[#6250d6] text-white dark:bg-[#9085e9] dark:text-black" : "bg-panel-2 text-muted hover:text-foreground"}`}
          title={interval === "1h" ? "Mark patterns the app discovered in 5 years of data" : "Discovered patterns are found on 1h candles - switch to 1h"}
        >
          ★ Discovered
        </button>
        {shown && <OhlcReadout c={shown} />}
        {hover && hoverDiscovered.length > 0 && (
          <span className="text-xs text-[#6250d6] dark:text-[#9085e9]">
            {hoverDiscovered.map((d) => (
              <span key={d.id} className="mr-2">
                ★{d.id} {d.direction === "up" ? "▲" : "▼"} {d.description}
              </span>
            ))}
          </span>
        )}
        {hover && hoverPatterns.length > 0 && (
          <span className="text-xs">
            {hoverPatterns.map((p) => (
              <span key={p.id} className={`mr-2 ${p.textbook === "up" ? "text-up" : p.textbook === "down" ? "text-down" : "text-muted"}`}>
                {p.textbook === "up" ? "▲" : p.textbook === "down" ? "▼" : "↔"} {p.name}
              </span>
            ))}
          </span>
        )}
      </div>
      <div className="relative">
        <div
          ref={containerRef}
          className="h-[460px] w-full overflow-hidden rounded-lg border border-line"
        />
        <div
          ref={nowLineRef}
          aria-hidden
          className="pointer-events-none absolute top-px left-0 z-10 hidden border-l-2 border-dotted border-zinc-500"
        >
          <span
            ref={nowLabelRef}
            className="absolute top-1 left-1 rounded bg-zinc-500 px-1 text-[10px] leading-4 text-white dark:text-black"
          />
        </div>
      </div>
      {error && <p className="mt-2 text-rose-600">{error}</p>}
    </div>
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
