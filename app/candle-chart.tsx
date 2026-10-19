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
  light: { surface: "#fcfcfb", text: "#5f5e5a", grid: "#ecebe8", border: "#d9d8d4", up: "#0ca30c", down: "#d03b3b", forecast: "#2a78d6", point: "#eb6834" },
  dark: { surface: "#1a1a19", text: "#a3a29d", grid: "#2a2a28", border: "#3a3a37", up: "#0ca30c", down: "#d03b3b", forecast: "#3987e5", point: "#d95926" },
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

// Seconds per bar, for intervals where a 1-hour forecast cone is visible.
const CONE_STEP: Partial<Record<KlineInterval, number>> = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600 };

interface ConeSeries {
  mid: ISeriesApi<"Line">;
  upper: ISeriesApi<"Line">;
  lower: ISeriesApi<"Line">;
}

/** A forecast drawn as a cone over its hour. */
export interface ConeData {
  symbol: string;
  targetTs: number;
  baseClose: number;
  predictedClose: number;
  lower: number;
  upper: number;
}

/** A picked point, marked at the start of the hour it predicts. */
export interface ChartMarker {
  hourTs: number; // ms
  label: string;
  selected: boolean;
}

interface Props {
  symbol: string;
  cone?: ConeData | null;
  markers?: ChartMarker[];
  /** When true, clicking a candle calls onPick with its open time (ms). */
  pickMode?: boolean;
  onPick?: (timeMs: number) => void;
}

export default function CandleChart({ symbol, cone: forecast, markers = [], pickMode = false, onPick }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const coneRef = useRef<ConeSeries | null>(null);
  const markersRef = useRef<{ api: ISeriesMarkersPluginApi<Time>; byTime: Map<number, Candle> } | null>(null);
  const pickRef = useRef({ pickMode, onPick });
  const nowLineRef = useRef<HTMLDivElement>(null);
  const nowLabelRef = useRef<HTMLSpanElement>(null);
  const [interval, setTimeframe] = useState<KlineInterval>("1m");
  const [hover, setHover] = useState<Candle | null>(null);
  const [last, setLast] = useState<Candle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadedKey, setLoadedKey] = useState("");

  useEffect(() => {
    pickRef.current = { pickMode, onPick };
  }, [pickMode, onPick]);

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

    // Next-hour forecast cone: dashed predicted path, dotted 80% range.
    const coneOpts = { color: theme.forecast, priceLineVisible: false, crosshairMarkerVisible: false };
    coneRef.current = {
      mid: chart.addSeries(LineSeries, { ...coneOpts, lineWidth: 2, lineStyle: LineStyle.Dashed, title: "forecast" }),
      upper: chart.addSeries(LineSeries, { ...coneOpts, lineWidth: 1, lineStyle: LineStyle.Dotted, lastValueVisible: false }),
      lower: chart.addSeries(LineSeries, { ...coneOpts, lineWidth: 1, lineStyle: LineStyle.Dotted, lastValueVisible: false }),
    };

    const byTime = new Map<number, Candle>();
    markersRef.current = { api: createSeriesMarkers(candles, []), byTime };
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
      // Next bar may not exist yet (no forecast points on 4h/1d) - fall back to bar spacing.
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
    };
    chart.subscribeCrosshairMove(onMove);

    const onClick = (p: MouseEventParams) => {
      const { pickMode, onPick } = pickRef.current;
      if (pickMode && onPick && p.time !== undefined) onPick((p.time as number) * 1000);
    };
    chart.subscribeClick(onClick);

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
      chart.unsubscribeClick(onClick);
      markersRef.current = null;
      window.clearInterval(nowTimer);
      timeScale.unsubscribeVisibleLogicalRangeChange(updateNow);
      timeScale.unsubscribeSizeChange(updateNow);
      coneRef.current = null;
      chart.remove();
      setHover(null);
      setLast(null);
    };
  }, [symbol, interval]);

  // Runs after the chart effect above, so the cone series exist for this symbol/interval.
  useEffect(() => {
    const cone = coneRef.current;
    if (!cone) return;
    const step = CONE_STEP[interval];
    if (!forecast || forecast.symbol !== symbol || !step) {
      cone.mid.setData([]);
      cone.upper.setData([]);
      cone.lower.setData([]);
      return;
    }
    // Path from the last close to the predicted close over the hour; the range
    // widens with sqrt(time), like a random walk.
    const start = forecast.targetTs / 1000;
    const mu = Math.log(forecast.predictedClose / forecast.baseClose);
    const up = Math.log(forecast.upper / forecast.predictedClose);
    const down = Math.log(forecast.predictedClose / forecast.lower);
    const mid = [], upper = [], lower = [];
    for (let t = start; t <= start + 3600; t += step) {
      const frac = (t - start) / 3600;
      const centre = forecast.baseClose * Math.exp(mu * frac);
      const time = t as UTCTimestamp;
      mid.push({ time, value: centre });
      upper.push({ time, value: centre * Math.exp(up * Math.sqrt(frac)) });
      lower.push({ time, value: centre * Math.exp(-down * Math.sqrt(frac)) });
    }
    cone.mid.setData(mid);
    cone.upper.setData(upper);
    cone.lower.setData(lower);
  }, [forecast, symbol, interval]);

  // Point markers sit on the bar that contains the start of each predicted hour.
  useEffect(() => {
    const m = markersRef.current;
    if (!m) return;
    const step = BAR_SECONDS[interval];
    const theme = currentTheme();
    m.api.setMarkers(
      markers
        .map((p) => ({ ...p, time: Math.floor(p.hourTs / 1000 / step) * step }))
        .filter((p) => m.byTime.has(p.time))
        .sort((a, b) => a.time - b.time)
        .map((p) => ({
          time: p.time as UTCTimestamp,
          position: "aboveBar" as const,
          shape: p.selected ? ("arrowDown" as const) : ("circle" as const),
          color: p.selected ? theme.forecast : theme.point,
          text: p.label,
          size: p.selected ? 1.4 : 1,
        })),
    );
  }, [markers, interval, loadedKey]);

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
      <div className="relative">
        <div
          ref={containerRef}
          className={`h-[420px] w-full overflow-hidden rounded border ${
            pickMode ? "cursor-crosshair border-[#eb6834] dark:border-[#d95926]" : "border-zinc-200 dark:border-zinc-800"
          }`}
        />
        {pickMode && (
          <span className="pointer-events-none absolute top-2 left-1/2 z-10 -translate-x-1/2 rounded bg-[#eb6834] px-2 py-0.5 text-xs text-white dark:bg-[#d95926]">
            Click a candle to add a point
          </span>
        )}
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
