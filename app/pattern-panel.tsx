"use client";

import { useEffect, useRef, useState } from "react";
import { CandlestickSeries, ColorType, createChart, createSeriesMarkers, LineSeries, LineStyle, type UTCTimestamp } from "lightweight-charts";
import { PATTERN_INFO, PATTERN_KEYS, type PatternGroup, type PatternKey } from "@/lib/pattern-detect";
import { currentTheme, localTick } from "./candle-chart";
import { STORED_PATTERN_INTERVALS, type StoredPattern } from "./stored-patterns";

// Stored pattern detections: per-pattern counts, filters, a paginated list and a detail chart
// of the candles around a selected detection. All data comes from /api/patterns*.

interface Summary {
  patterns: { pattern: PatternKey; direction: string; count: number; first: number; last: number }[];
  total: number;
  scan: { lastTs: number; scanned: number } | null;
}

interface Page {
  items: StoredPattern[];
  nextCursor: string | null;
}

const PAGE = 50;

export const GROUPS: [PatternGroup, string][] = [
  ["reversal", "Reversal · the trend may turn"],
  ["continuation", "Continuation · the trend may carry on"],
  ["bilateral", "Bilateral · the breakout side decides"],
];

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const r = await fetch(url, { signal, cache: "no-store" });
  if (!r.ok) throw new Error((await r.text()) || `HTTP ${r.status}`);
  return r.json();
}

/** <input type="date"> value (local day) -> ms bound. */
const dayStart = (d: string) => (d ? String(new Date(`${d}T00:00:00`).getTime()) : "");
const dayEnd = (d: string) => (d ? String(new Date(`${d}T23:59:59.999`).getTime()) : "");

const dirClass = (d: string) => (d === "bullish" ? "text-up" : d === "bearish" ? "text-down" : "text-muted");
const dirIcon = (d: string) => (d === "bullish" ? "▲" : d === "bearish" ? "▼" : "●");
const fmtTime = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short", hour12: false });
const fmtPrice = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function PatternPanel({ symbol }: { symbol: string }) {
  const [interval, setInterval_] = useState(STORED_PATTERN_INTERVALS[0]);
  const [pattern, setPattern] = useState<PatternKey | "">("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [selected, setSelected] = useState<number | null>(null);

  const base = new URLSearchParams({ symbol, interval });
  if (from) base.set("from", dayStart(from));
  if (to) base.set("to", dayEnd(to));
  const summaryQuery = base.toString(); // counts ignore the pattern filter so every chip stays visible
  if (pattern) base.set("pattern", pattern);
  const listQuery = base.toString();

  const [summary, setSummary] = useState<{ q: string; data?: Summary; error?: string }>({ q: "" });
  const [list, setList] = useState<{ q: string; items: StoredPattern[]; next: string | null; error?: string }>({ q: "", items: [], next: null });
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    const ctrl = new AbortController();
    getJson<Summary>(`/api/patterns/summary?${summaryQuery}`, ctrl.signal)
      .then((data) => setSummary({ q: summaryQuery, data }))
      .catch((e: Error) => e.name !== "AbortError" && setSummary({ q: summaryQuery, error: e.message }));
    return () => ctrl.abort();
  }, [summaryQuery]);

  useEffect(() => {
    const ctrl = new AbortController();
    getJson<Page>(`/api/patterns?${listQuery}&limit=${PAGE}`, ctrl.signal)
      .then((d) => setList({ q: listQuery, items: d.items, next: d.nextCursor }))
      .catch((e: Error) => e.name !== "AbortError" && setList({ q: listQuery, items: [], next: null, error: e.message }));
    return () => ctrl.abort();
  }, [listQuery]);

  const loadMore = () => {
    if (!list.next) return;
    setLoadingMore(true);
    getJson<Page>(`/api/patterns?${listQuery}&limit=${PAGE}&cursor=${list.next}`)
      .then((d) => setList((l) => (l.q === listQuery ? { ...l, items: [...l.items, ...d.items], next: d.nextCursor } : l)))
      .catch((e: Error) => setList((l) => ({ ...l, error: e.message })))
      .finally(() => setLoadingMore(false));
  };

  const summaryLoading = summary.q !== summaryQuery;
  const listLoading = list.q !== listQuery;
  const counts = new Map(summary.data?.patterns.map((p) => [p.pattern, p.count]) ?? []);
  const notScanned = !summaryLoading && summary.data && !summary.data.scan;

  return (
    <section className="card p-4">
      <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-base font-semibold">Detected chart patterns</h2>
        <div className={`gap-0.5 rounded-lg bg-panel-2 p-0.5 text-xs ${STORED_PATTERN_INTERVALS.length > 1 ? "flex" : "hidden"}`} role="group" aria-label="Candle timeframe">
          {STORED_PATTERN_INTERVALS.map((i) => (
            <button
              key={i}
              onClick={() => {
                setInterval_(i);
                setSelected(null);
              }}
              aria-pressed={i === interval}
              className={`rounded-md px-2.5 py-0.5 font-medium transition-colors ${i === interval ? "bg-panel text-foreground shadow-sm" : "text-muted hover:text-foreground"}`}
            >
              {i}
            </button>
          ))}
        </div>
        <span className="text-xs text-muted">
          {symbol} · {interval} candles
          {summary.data?.scan && ` · scanned ${summary.data.scan.scanned.toLocaleString()} candles through ${fmtTime(summary.data.scan.lastTs)}`}
        </span>
      </div>

      {/* filters */}
      <div className="mb-4 flex flex-wrap items-end gap-3 text-xs">
        <label className="flex flex-col gap-1">
          <span className="text-muted">Pattern</span>
          <select
            value={pattern}
            onChange={(e) => setPattern(e.target.value as PatternKey | "")}
            className="rounded-md border border-line bg-panel px-2 py-1.5"
          >
            <option value="">All patterns</option>
            {GROUPS.map(([group, label]) => (
              <optgroup key={group} label={label.split(" · ")[0]}>
                {PATTERN_KEYS.filter((k) => PATTERN_INFO[k].group === group).map((k) => (
                  <option key={k} value={k}>
                    {PATTERN_INFO[k].name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-muted">From</span>
          <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className="rounded-md border border-line bg-panel px-2 py-1" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-muted">To</span>
          <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className="rounded-md border border-line bg-panel px-2 py-1" />
        </label>
        {(pattern || from || to) && (
          <button onClick={() => { setPattern(""); setFrom(""); setTo(""); }} className="rounded-md bg-panel-2 px-2.5 py-1.5 text-muted hover:text-foreground">
            Clear filters
          </button>
        )}
      </div>

      {/* summary */}
      {summary.error ? (
        <p className="mb-4 text-xs text-down">Couldn&apos;t load summary: {summary.error}</p>
      ) : notScanned ? (
        <p className="mb-4 rounded-lg bg-panel-2 p-3 text-xs text-muted">
          {symbol} {interval} hasn&apos;t been scanned yet. Run <code className="font-mono">npm run patterns -- --symbol {symbol} --interval {interval}</code> to backfill.
        </p>
      ) : (
        <div className={`mb-4 space-y-3 ${summaryLoading ? "opacity-50" : ""}`}>
          {GROUPS.map(([group, label]) => (
            <div key={group}>
              <div className="eyebrow mb-1.5">{label}</div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
                {PATTERN_KEYS.filter((k) => PATTERN_INFO[k].group === group).map((k) => {
                  const info = PATTERN_INFO[k];
                  const active = pattern === k;
                  return (
                    <button
                      key={k}
                      onClick={() => setPattern(active ? "" : k)}
                      aria-pressed={active}
                      title={info.definition}
                      className={`rounded-lg border p-2.5 text-left transition-colors ${active ? "border-foreground bg-panel-2" : "border-line hover:bg-panel-2"}`}
                    >
                      <div className={`truncate text-xs font-medium ${dirClass(info.direction)}`}>
                        {dirIcon(info.direction)} {info.name}
                      </div>
                      <div className="mt-1 font-mono text-lg">{summaryLoading && !summary.data ? "…" : (counts.get(k) ?? 0).toLocaleString()}</div>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {selected !== null && <PatternDetail id={selected} onClose={() => setSelected(null)} />}

      {/* list */}
      {list.error && <p className="mb-2 text-xs text-down">Couldn&apos;t load patterns: {list.error}</p>}
      <div className={`max-h-[520px] overflow-auto ${listLoading ? "opacity-50" : ""}`}>
        <table className="w-full text-left text-xs">
          <thead className="sticky top-0 bg-panel text-muted">
            <tr className="border-b border-line">
              <th className="py-2 pr-3 font-medium">Breakout (candle open)</th>
              <th className="py-2 pr-3 font-medium">Pattern</th>
              <th className="py-2 pr-3 text-right font-medium">Broke level</th>
              <th className="py-2 pr-3 text-right font-medium">Close</th>
              <th className="py-2 text-right font-medium">Span</th>
            </tr>
          </thead>
          <tbody>
            {list.items.map((r) => (
              <tr
                key={r.id}
                onClick={() => setSelected(r.id === selected ? null : r.id)}
                className={`cursor-pointer border-b border-line/60 hover:bg-panel-2 ${r.id === selected ? "bg-panel-2" : ""}`}
              >
                <td className="py-1.5 pr-3 font-mono">{fmtTime(r.ts)}</td>
                <td className={`py-1.5 pr-3 font-medium ${dirClass(r.direction)}`}>
                  {dirIcon(r.direction)} {PATTERN_INFO[r.pattern].name}
                </td>
                <td className="py-1.5 pr-3 text-right font-mono text-muted">{fmtPrice(r.meta.level)}</td>
                <td className="py-1.5 pr-3 text-right font-mono">{fmtPrice(r.close)}</td>
                <td className="py-1.5 text-right font-mono text-muted">{r.candles} candles</td>
              </tr>
            ))}
          </tbody>
        </table>
        {listLoading && !list.items.length && <p className="py-6 text-center text-xs text-muted">Loading…</p>}
        {!listLoading && !list.error && !list.items.length && (
          <p className="py-6 text-center text-xs text-muted">No patterns match these filters.</p>
        )}
      </div>
      {list.next && !listLoading && (
        <button onClick={loadMore} disabled={loadingMore} className="mt-3 rounded-md bg-panel-2 px-3 py-1.5 text-xs text-muted hover:text-foreground disabled:opacity-50">
          {loadingMore ? "Loading…" : "Load more"}
        </button>
      )}
    </section>
  );
}

interface Detail {
  detection: StoredPattern;
  candles: { ts: number; o: number; h: number; l: number; c: number }[];
}

/** Candles around one detection, from the DB, with the pattern's candles highlighted. */
export function PatternDetail({ id, onClose }: { id: number; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<{ id: number; data?: Detail; error?: string }>({ id: -1 });

  useEffect(() => {
    const ctrl = new AbortController();
    getJson<Detail>(`/api/patterns/${id}`, ctrl.signal)
      .then((data) => setState({ id, data }))
      .catch((e: Error) => e.name !== "AbortError" && setState({ id, error: e.message }));
    return () => ctrl.abort();
  }, [id]);

  const data = state.id === id ? state.data : undefined;

  useEffect(() => {
    const el = ref.current;
    if (!el || !data) return;
    const theme = currentTheme();
    const chart = createChart(el, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: theme.surface }, textColor: theme.text, fontFamily: "var(--font-geist-mono), monospace" },
      grid: { vertLines: { color: theme.grid }, horzLines: { color: theme.grid } },
      rightPriceScale: { borderColor: theme.border },
      timeScale: { borderColor: theme.border, timeVisible: true, secondsVisible: false, tickMarkFormatter: localTick },
      localization: { timeFormatter: (t: number) => new Date(t * 1000).toLocaleString() },
    });
    const d = data.detection;
    const inPattern = (ts: number) => ts >= d.startTs && ts <= d.ts;
    const series = chart.addSeries(CandlestickSeries, { upColor: theme.up, downColor: theme.down, borderVisible: false, wickUpColor: theme.up, wickDownColor: theme.down });
    // Candles outside the pattern are faded so the pattern stands out.
    series.setData(
      data.candles.map((k) => {
        const color = (k.c >= k.o ? theme.up : theme.down) + (inPattern(k.ts) ? "" : "55");
        return { time: (k.ts / 1000) as UTCTimestamp, open: k.o, high: k.h, low: k.l, close: k.c, color, wickColor: color };
      }),
    );
    const info = PATTERN_INFO[d.pattern];
    // The pattern itself: swing points joined (solid) and its trendlines / neckline (dashed).
    const color = d.direction === "bullish" ? theme.up : d.direction === "bearish" ? theme.down : theme.neutral;
    const swings = chart.addSeries(LineSeries, { color: theme.text, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    swings.setData(d.meta.points.map((p) => ({ time: (p.ts / 1000) as UTCTimestamp, value: p.p })));
    for (const l of d.meta.lines) {
      if (l.b.ts <= l.a.ts) continue;
      chart.addSeries(LineSeries, { color, lineWidth: 2, lineStyle: LineStyle.Dashed, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false })
        .setData([{ time: (l.a.ts / 1000) as UTCTimestamp, value: l.a.p }, { time: (l.b.ts / 1000) as UTCTimestamp, value: l.b.p }]);
    }
    createSeriesMarkers(series, [
      d.direction === "bullish"
        ? { time: (d.ts / 1000) as UTCTimestamp, position: "belowBar", shape: "arrowUp", color: theme.up, text: info.name }
        : d.direction === "bearish"
          ? { time: (d.ts / 1000) as UTCTimestamp, position: "aboveBar", shape: "arrowDown", color: theme.down, text: info.name }
          : { time: (d.ts / 1000) as UTCTimestamp, position: "aboveBar", shape: "circle", color: theme.neutral, text: info.name },
    ]);
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [data]);

  const d = data?.detection;
  return (
    <div className="mb-4 rounded-lg border border-line p-3">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs">
        {d ? (
          <>
            <span className={`text-sm font-semibold ${dirClass(d.direction)}`}>
              {dirIcon(d.direction)} {PATTERN_INFO[d.pattern].name}
            </span>
            <span className="text-muted">{fmtTime(d.ts)}</span>
            <span className="text-muted">
              closed {fmtPrice(d.close)} through {fmtPrice(d.meta.level)} · {d.candles} candles from first swing point
            </span>
          </>
        ) : (
          <span className="text-muted">{state.id === id && state.error ? <span className="text-down">Couldn&apos;t load: {state.error}</span> : "Loading…"}</span>
        )}
        <button onClick={onClose} className="ml-auto rounded-md bg-panel-2 px-2 py-0.5 text-muted hover:text-foreground" aria-label="Close detail">
          ✕
        </button>
      </div>
      {d && <p className="mb-2 text-xs text-muted">{PATTERN_INFO[d.pattern].definition} Thin line = swing points, dashed = pattern lines. The direction is the textbook meaning, not a guaranteed move.</p>}
      <div ref={ref} className="h-[260px] w-full overflow-hidden rounded-md border border-line" />
    </div>
  );
}
