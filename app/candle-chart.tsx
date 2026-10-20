"use client";

import { useEffect, useRef, useState } from "react";
import {
  CandlestickSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  HistogramSeries,
  LineSeries,
  LineStyle,
  TickMarkType,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type MouseEventParams,
  type SeriesMarker,
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
import { PATTERN_INFO, type PatternKey } from "@/lib/pattern-detect";
import type { DiscoveredLite } from "./discovered";
import type { SignalData } from "./use-signal";
import { hasStoredPatterns, STORED_PATTERN_INTERVALS, type StoredPattern } from "./stored-patterns";

/** Chart palette of the darkMode ghost theme (matches the tokens in app/globals.css). */
export const THEME = {
  surface: "#060609", text: "#6c7084", grid: "#101118", border: "#181a22",
  up: "#2fbf82", down: "#e95a70", discovered: "#9a86f2", neutral: "#50546a",
};

type Theme = typeof THEME;

export function currentTheme(): Theme {
  return THEME;
}

/** Time-axis labels in the viewer's local time (lightweight-charts defaults to UTC). */
export function localTick(t: Time, type: TickMarkType): string {
  const d = new Date((t as number) * 1000);
  return type === TickMarkType.Time || type === TickMarkType.TimeWithSeconds
    ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false })
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function toBar(c: Candle) {
  return { time: c.time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close };
}

function toVolume(c: Candle, t: Theme) {
  // Semi-transparent so volume stays recessive next to the candles.
  return { time: c.time as UTCTimestamp, value: c.volume, color: (c.close >= c.open ? t.up : t.down) + "66" };
}

const EMPTY_ROWS: StoredPattern[] = [];

const BAR_SECONDS: Record<KlineInterval, number> = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };

interface Props {
  symbol: string;
  /** Discovered patterns to mark (1h chart only - they were found on 1h candles). */
  discovered?: DiscoveredLite[];
  /** Current AI signal: drawn as a forecast line from the signal's price over its look-ahead. */
  forecast?: SignalData;
}

/** Trendlines drawn for the most recent detected patterns on the chart. */
const MAX_PATTERN_LINES = 12;

/** Max points of the forecast line (a 1-day look-ahead on the 1m chart is 1440). */
const MAX_FORECAST_POINTS = 1500;

export default function CandleChart({ symbol, discovered = [], forecast }: Props) {
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
  const [showDetected, setShowDetected] = useState(true);
  const [detected, setDetected] = useState<{ key: string; rows: StoredPattern[]; error?: string }>({ key: "", rows: [] });
  const [hoverDetected, setHoverDetected] = useState<StoredPattern[]>([]);
  const detectedAtRef = useRef(new Map<number, StoredPattern[]>());
  const [showDiscovered, setShowDiscovered] = useState(true);
  const [showForecast, setShowForecast] = useState(true);
  const forecastRef = useRef<{
    chart: IChartApi;
    line: ISeriesApi<"Line">;
    upper: ISeriesApi<"Line">;
    lower: ISeriesApi<"Line">;
    /** Chart + look-ahead the view was last framed for (re-framed only when this changes). */
    framed: string;
  } | null>(null);
  const [hoverDiscovered, setHoverDiscovered] = useState<DiscoveredLite[]>([]);
  const discoveredAtRef = useRef(new Map<number, DiscoveredLite[]>());
  /** Reusable line series that draw the trendlines / necklines of recent detected patterns. */
  const patternLinesRef = useRef<ISeriesApi<"Line">[]>([]);


  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const theme = currentTheme();
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
        tickMarkFormatter: localTick,
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

    // Pattern lines: a small pool of dashed two-point series, filled by the markers effect.
    patternLinesRef.current = Array.from({ length: MAX_PATTERN_LINES }, () =>
      chart.addSeries(LineSeries, { lineWidth: 1, lineStyle: LineStyle.Dashed, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }),
    );

    // AI forecast: expected path (solid) and the typical-move band (dotted), filled in by an effect below.
    const lineOpts = { priceLineVisible: false, crosshairMarkerVisible: false, lastValueVisible: false } as const;
    forecastRef.current = {
      chart,
      framed: "",
      line: chart.addSeries(LineSeries, { ...lineOpts, lineWidth: 2, lastValueVisible: true }),
      upper: chart.addSeries(LineSeries, { ...lineOpts, lineWidth: 1, lineStyle: LineStyle.Dotted }),
      lower: chart.addSeries(LineSeries, { ...lineOpts, lineWidth: 1, lineStyle: LineStyle.Dotted }),
    };

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
      setHoverDiscovered(p.time !== undefined ? (discoveredAtRef.current.get(p.time as number) ?? []) : []);
      setHoverDetected(p.time !== undefined ? (detectedAtRef.current.get(p.time as number) ?? []) : []);
    };
    chart.subscribeCrosshairMove(onMove);

    return () => {
      cancelled = true;
      unsub();
      chart.unsubscribeCrosshairMove(onMove);
      markersRef.current = null;
      forecastRef.current = null;
      patternLinesRef.current = [];
      window.clearInterval(nowTimer);
      timeScale.unsubscribeVisibleLogicalRangeChange(updateNow);
      timeScale.unsubscribeSizeChange(updateNow);
      chart.remove();
      setHover(null);
      setLast(null);
    };
  }, [symbol, interval]);

  // Stored detections (pattern_detections) for the loaded range only; refreshed as candles close.
  useEffect(() => {
    const m = markersRef.current;
    if (!hasStoredPatterns(interval) || !loadedKey || !m || !m.byTime.size) return;
    const times = [...m.byTime.keys()];
    const from = Math.min(...times) * 1000, to = Math.max(...times) * 1000;
    const ctrl = new AbortController();
    fetch(`/api/patterns?symbol=${symbol}&interval=${interval}&from=${from}&to=${to}&limit=1000`, { signal: ctrl.signal, cache: "no-store" })
      .then((r) => (r.ok ? r.json() : r.text().then((t) => Promise.reject(new Error(t || `HTTP ${r.status}`)))))
      .then((d: { items: StoredPattern[] }) => setDetected({ key: loadedKey, rows: d.items }))
      .catch((err: Error) => err.name !== "AbortError" && setDetected({ key: loadedKey, rows: [], error: err.message }));
    return () => ctrl.abort();
  }, [symbol, interval, loadedKey, closedTick]);

  // Forecast line: from the signal candle's close (price p0) to the end of the look-ahead window,
  // ending at p0 x (1 + expectedMove); the band widens like sqrt(time) to +-typicalMove.
  useEffect(() => {
    const f = forecastRef.current;
    if (!f || !loadedKey) return;
    const clear = () => [f.line, f.upper, f.lower].forEach((x) => x.setData([]));
    if (!showForecast || !forecast || forecast.symbol !== symbol) return clear();
    const bar = BAR_SECONDS[interval];
    const start = Math.floor((forecast.at + forecast.stepMs) / 1000 / bar) * bar; // the signal candle's close
    const end = start + Math.round((forecast.horizon * forecast.stepMs) / 1000);
    const n = Math.ceil((end - start) / bar);
    if (n < 1 || n > MAX_FORECAST_POINTS) return clear(); // e.g. a 15-min look-ahead on the 1d chart
    const theme = currentTheme();
    const color = forecast.lean === "up" ? theme.up : forecast.lean === "down" ? theme.down : theme.neutral;
    const p0 = forecast.close;
    const pts = Array.from({ length: n + 1 }, (_, i) => ({ time: (start + i * bar) as UTCTimestamp, frac: Math.min(1, i / n) }));
    f.line.setData(pts.map((p) => ({ time: p.time, value: p0 * (1 + forecast.expectedMove * p.frac) })));
    f.upper.setData(pts.map((p) => ({ time: p.time, value: p0 * (1 + forecast.expectedMove * p.frac + forecast.typicalMove * Math.sqrt(p.frac)) })));
    f.lower.setData(pts.map((p) => ({ time: p.time, value: p0 * (1 + forecast.expectedMove * p.frac - forecast.typicalMove * Math.sqrt(p.frac)) })));
    // Frame recent candles + the whole forecast once per chart/look-ahead; later refreshes keep the user's view.
    const frameKey = `${loadedKey}:${forecast.interval}:${forecast.horizon}`;
    if (f.framed !== frameKey) {
      f.framed = frameKey;
      const past = Math.max(n, 120) * bar;
      f.chart.timeScale().setVisibleRange({ from: (start - past) as UTCTimestamp, to: (end + 3 * bar) as UTCTimestamp });
    }
    const arrow = forecast.lean === "up" ? "▲" : forecast.lean === "down" ? "▼" : "•";
    f.line.applyOptions({ color, title: `AI ${forecast.horizonLabel} ${arrow} ${(forecast.pUp * 100).toFixed(0)}%` });
    f.upper.applyOptions({ color: color + "99" });
    f.lower.applyOptions({ color: color + "99" });
  }, [forecast, showForecast, symbol, interval, loadedKey]);

  const detectedRows = detected.key.startsWith(`${symbol}:${interval}:`) ? detected.rows : EMPTY_ROWS;

  // Markers (discovered sequences + stored chart-pattern breakouts) and lines of recent patterns.
  useEffect(() => {
    const m = markersRef.current;
    if (!m) return;
    const theme = currentTheme();

    const closed = [...m.byTime.values()].filter((c) => c.closed).sort((a, b) => a.time - b.time);
    const ohlc = closed.map((c) => ({ o: c.open, h: c.high, l: c.low, c: c.close }));

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

    // Stored detections: green arrow below = bullish breakout, red arrow above = bearish.
    const detAt = new Map<number, StoredPattern[]>();
    for (const r of detectedRows) {
      const t = r.ts / 1000;
      if (m.byTime.has(t)) detAt.set(t, [...(detAt.get(t) ?? []), r]);
    }
    detectedAtRef.current = detAt;
    const detectedMarkers = showDetected
      ? [...detAt].flatMap(([time, rows]) =>
          (["bullish", "bearish", "neutral"] as const).flatMap((dir): SeriesMarker<Time>[] => {
            const hits = rows.filter((r) => r.direction === dir);
            if (!hits.length) return [];
            const text = hits.map((r) => PATTERN_INFO[r.pattern].code).join(" ");
            const t = time as UTCTimestamp;
            return dir === "bullish"
              ? [{ time: t, position: "belowBar", shape: "arrowUp", color: theme.up, text, size: 0.7 }]
              : dir === "bearish"
                ? [{ time: t, position: "aboveBar", shape: "arrowDown", color: theme.down, text, size: 0.7 }]
                : [{ time: t, position: "aboveBar", shape: "circle", color: theme.neutral, text, size: 0.4 }];
          }),
        )
      : [];

    // Trendlines / necklines of the most recent detections whose lines are fully in the loaded range.
    const pool = patternLinesRef.current;
    const lines = showDetected
      ? [...detectedRows]
          .sort((a, b) => b.ts - a.ts)
          .flatMap((r) => r.meta.lines.map((l) => ({ l, dir: r.direction })))
          .filter(({ l }) => m.byTime.has(l.a.ts / 1000) && m.byTime.has(l.b.ts / 1000) && l.b.ts > l.a.ts)
          .slice(0, pool.length)
      : [];
    pool.forEach((series, i) => {
      const x = lines[i];
      if (!x) return series.setData([]);
      series.applyOptions({ color: (x.dir === "bullish" ? theme.up : x.dir === "bearish" ? theme.down : theme.neutral) + "bb" });
      series.setData([
        { time: (x.l.a.ts / 1000) as UTCTimestamp, value: x.l.a.p },
        { time: (x.l.b.ts / 1000) as UTCTimestamp, value: x.l.b.p },
      ]);
    });

    m.api.setMarkers([...discoveredMarkers, ...detectedMarkers].sort((a, b) => (a.time as number) - (b.time as number)));
  }, [interval, loadedKey, closedTick, showDiscovered, discovered, showDetected, detectedRows]);

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
          onClick={() => setShowForecast(!showForecast)}
          aria-pressed={showForecast}
          className={`rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${showForecast ? "bg-accent/15 text-accent ring-1 ring-accent/30" : "bg-panel-2 text-muted hover:text-foreground"}`}
          title="AI forecast line: expected path over the selected look-ahead (solid) and the typical move range (dotted)"
        >
          AI line{forecast ? ` · ${forecast.horizonLabel}` : ""}
        </button>
        <button
          onClick={() => setShowDetected(!showDetected)}
          aria-pressed={showDetected}
          disabled={!hasStoredPatterns(interval)}
          className={`-ml-2 rounded-lg px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-40 ${showDetected ? "bg-accent/15 text-accent ring-1 ring-accent/30" : "bg-panel-2 text-muted hover:text-foreground"}`}
          title={hasStoredPatterns(interval) ? "Chart patterns found by the detector: breakout markers and the pattern's trendlines" : `Chart patterns are detected on ${STORED_PATTERN_INTERVALS.join(" / ")} candles - switch to ${STORED_PATTERN_INTERVALS[0]}`}
        >
          Chart patterns{hasStoredPatterns(interval) && detected.key === loadedKey && !detected.error ? ` · ${detectedRows.length}` : ""}
        </button>
        <button
          onClick={() => setShowDiscovered(!showDiscovered)}
          aria-pressed={showDiscovered}
          disabled={interval !== "1h"}
          className={`-ml-2 rounded-lg px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-40 ${showDiscovered ? "bg-accent/15 text-accent ring-1 ring-accent/30" : "bg-panel-2 text-muted hover:text-foreground"}`}
          title={interval === "1h" ? "Mark patterns the app discovered in 5 years of data" : "Discovered patterns are found on 1h candles - switch to 1h"}
        >
          ★ Discovered
        </button>
        {shown && <OhlcReadout c={shown} />}
        {hover && hoverDiscovered.length > 0 && (
          <span className="text-xs text-accent">
            {hoverDiscovered.map((d) => (
              <span key={d.id} className="mr-2">
                ★{d.id} {d.direction === "up" ? "▲" : "▼"} {d.description}
              </span>
            ))}
          </span>
        )}
        {hover && hoverDetected.length > 0 && (
          <span className="text-xs">
            {hoverDetected.map((r) => (
              <span key={r.id} className={`mr-2 font-medium ${r.direction === "bullish" ? "text-up" : r.direction === "bearish" ? "text-down" : "text-muted"}`}>
                {r.direction === "bullish" ? "▲" : r.direction === "bearish" ? "▼" : "●"} {PATTERN_INFO[r.pattern as PatternKey].name}
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
          className="pointer-events-none absolute top-px left-0 z-10 hidden border-l-2 border-dotted border-muted"
        >
          <span
            ref={nowLabelRef}
            className="absolute top-1 left-1 rounded bg-panel-2 px-1 text-[10px] leading-4 text-foreground ring-1 ring-line"
          />
        </div>
      </div>
      {error && <p className="mt-2 text-down">{error}</p>}
      {detected.error && hasStoredPatterns(interval) && <p className="mt-2 text-xs text-down">Couldn&apos;t load stored patterns: {detected.error}</p>}
    </div>
  );
}

export function OhlcReadout({ c }: { c: Candle }) {
  const up = c.close >= c.open;
  const pct = ((c.close - c.open) / c.open) * 100;
  return (
    <span className="text-xs text-muted">
      {new Date(c.time * 1000).toLocaleString()} · O <b className="text-foreground font-normal">{fmt(c.open)}</b> H{" "}
      <b className="text-foreground font-normal">{fmt(c.high)}</b> L <b className="text-foreground font-normal">{fmt(c.low)}</b> C{" "}
      <b className="text-foreground font-normal">{fmt(c.close)}</b>{" "}
      <span className={up ? "text-up" : "text-down"}>
        {up ? "▲" : "▼"} {pct.toFixed(2)}%
      </span>{" "}
      · Vol <b className="text-foreground font-normal">{c.volume.toFixed(2)}</b>
    </span>
  );
}

function fmt(n: number): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 8 });
}
