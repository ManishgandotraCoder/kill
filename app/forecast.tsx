"use client";

import { useEffect, useState } from "react";
import type { Forecast } from "@/lib/predict";

const HOUR_MS = 3_600_000;

/** Next-hour forecast from /api/predict; refetches right after each hour closes. */
export function useForecast(symbol: string) {
  const [state, setState] = useState<{ symbol: string; forecast: Forecast | null; error: string | null } | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    fetch(`/api/predict?symbol=${symbol}`, { signal: ctrl.signal, cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) throw new Error(await res.text());
        const f: Forecast = await res.json();
        setState({ symbol, forecast: f, error: null });
        // The predicted hour closes at targetTs + 1h; fetch the next forecast just after.
        timer = setTimeout(() => setTick((t) => t + 1), Math.max(5_000, f.targetTs + HOUR_MS + 10_000 - Date.now()));
      })
      .catch((e) => {
        if (ctrl.signal.aborted) return;
        setState({ symbol, forecast: null, error: e instanceof Error ? e.message : String(e) });
        timer = setTimeout(() => setTick((t) => t + 1), 60_000);
      });
    return () => {
      ctrl.abort();
      clearTimeout(timer);
    };
  }, [symbol, tick]);

  return state?.symbol === symbol ? state : { symbol, forecast: null, error: null };
}

/** Current time, updated every `ms`; null until mounted (server render has no clock). */
function useNow(ms: number) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const t = setInterval(tick, ms);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [ms]);
  return now;
}

export function ForecastPanel({
  forecast,
  error,
  livePrice,
}: {
  forecast: Forecast | null;
  error: string | null;
  livePrice?: number | null;
}) {
  const now = useNow(1000);

  if (error) {
    return (
      <section className="card mb-6 p-5 text-sm">
        <div className="eyebrow mb-1">Next-hour forecast</div>
        <p className="text-down">Unavailable: {error}</p>
      </section>
    );
  }
  if (!forecast) {
    return (
      <section className="card mb-6 animate-pulse p-5 text-sm">
        <div className="eyebrow mb-2">Next-hour forecast</div>
        <div className="h-8 w-48 rounded bg-panel-2" />
      </section>
    );
  }

  const f = forecast;
  const b = f.backtest;
  const up = f.expectedPct >= 0;
  const closeAt = f.targetTs + HOUR_MS;
  const left = now === null ? null : Math.max(0, closeAt - now);
  const elapsed = now === null ? 0 : Math.min(1, (now - f.targetTs) / HOUR_MS);
  return (
    <section className="card mb-6 p-5 text-sm">
      {/* header */}
      <div className="mb-4 flex flex-wrap items-start gap-3">
        <div>
          <div className="eyebrow">Next-hour forecast</div>
          <div className="text-muted">
            Candle {hm(f.targetTs)}–{hm(closeAt)} · <span className="text-accent">blue cone</span> on the chart
          </div>
        </div>
      </div>

      <div className="grid gap-5 md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.6fr)]">
        {/* headline */}
        <div>
          <div className="text-xs text-muted">Predicted close</div>
          <div className="font-mono text-3xl font-semibold tracking-tight">{fmt(f.predictedClose)}</div>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <span className={`rounded-md px-2 py-0.5 font-medium ${up ? "bg-up/10 text-up" : "bg-down/10 text-down"}`}>
              {up ? "▲" : "▼"} {up ? "+" : ""}
              {f.expectedPct.toFixed(3)}%
            </span>
            <span className="text-muted">from {fmt(f.baseClose)}</span>
          </div>
          <div className="mt-4">
            <div className="mb-1 flex justify-between text-xs text-muted">
              <span>Closes in</span>
              <span className="font-mono text-foreground">{left === null ? "--:--" : mmss(left)}</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-panel-2">
              <div className="h-full rounded-full bg-accent transition-[width] duration-1000" style={{ width: `${elapsed * 100}%` }} />
            </div>
          </div>
        </div>

        {/* range + probability */}
        <div className="space-y-5">
          <RangeBar lower={f.lower} upper={f.upper} predicted={f.predictedClose} base={f.baseClose} live={livePrice ?? null} />
          <ProbBar probUp={f.probUp} />
        </div>
      </div>

      {/* reliability */}
      <details className="group mt-5 border-t border-line pt-4">
        <summary className="flex cursor-pointer list-none items-center gap-2 text-muted hover:text-foreground">
          <span className="transition-transform group-open:rotate-90">›</span>
          How reliable is this?
          <span className="ml-auto text-xs">
            direction {b.directionAccuracy.toFixed(1)}% · range {b.bandCoverage.toFixed(1)}%
          </span>
        </summary>
        <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Metric label="Direction right" value={`${b.directionAccuracy.toFixed(1)}%`} note="coin flip = 50%" />
          <Metric label="Inside 80% range" value={`${b.bandCoverage.toFixed(1)}%`} note="target = 80%" />
          <Metric label="Average miss" value={`${b.modelMaePct.toFixed(3)}%`} note={`"no change" = ${b.naiveMaePct.toFixed(3)}%`} />
          <Metric
            label="Run record"
            value={f.live.count ? `${f.live.directionAccuracy?.toFixed(0)}%` : "—"}
            note={f.live.count ? `${f.live.count} hours · range ${f.live.bandCoverage?.toFixed(0)}%` : "none finished yet"}
          />
        </div>
        <p className="mt-3 text-xs text-muted">
          Tested on {b.testHours.toLocaleString()} hours since {new Date(b.testFrom).toLocaleDateString(undefined, { dateStyle: "medium" })} that
          the model never saw. Hourly prices are close to random: the range is reliable, the direction barely beats a coin flip. Not
          trading advice.
        </p>
      </details>
    </section>
  );
}

/** Likely range as a track: band = 80% range, blue tick = forecast, dot = live price. */
function RangeBar({ lower, upper, predicted, base, live }: { lower: number; upper: number; predicted: number; base: number; live: number | null }) {
  const vals = [lower, upper, base, ...(live ? [live] : [])];
  const span = Math.max(...vals) - Math.min(...vals);
  const lo = Math.min(...vals) - span * 0.12;
  const hi = Math.max(...vals) + span * 0.12;
  const x = (v: number) => `${((v - lo) / (hi - lo)) * 100}%`;
  const inside = live != null && live >= lower && live <= upper;

  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between text-xs">
        <span className="text-muted">80% likely range</span>
        {live != null && (
          <span className={inside ? "text-up" : "text-down"}>
            live price {inside ? "inside" : "outside"} range
          </span>
        )}
      </div>
      <div className="relative h-10">
        <div className="absolute inset-x-0 top-4 h-2 rounded-full bg-panel-2" />
        <div className="absolute top-4 h-2 rounded-full bg-accent/25" style={{ left: x(lower), width: `calc(${x(upper)} - ${x(lower)})` }} />
        <div className="absolute top-2.5 h-5 w-px border-l border-dashed border-muted" style={{ left: x(base) }} title={`Start ${fmt(base)}`} />
        <div className="absolute top-2 h-6 w-0.5 rounded bg-accent" style={{ left: x(predicted) }} title={`Forecast ${fmt(predicted)}`} />
        {live != null && (
          <div
            className={`absolute top-3.5 h-3 w-3 -translate-x-1/2 rounded-full ring-2 ring-panel transition-[left] duration-500 ${live >= base ? "bg-up" : "bg-down"}`}
            style={{ left: x(live) }}
            title={`Live ${fmt(live)}`}
          />
        )}
      </div>
      <div className="relative h-4 font-mono text-[11px] text-muted">
        <span className="absolute -translate-x-1/2" style={{ left: x(lower) }}>{fmt(lower)}</span>
        <span className="absolute -translate-x-1/2" style={{ left: x(upper) }}>{fmt(upper)}</span>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-4 text-[11px] text-muted">
        <span><span className="mr-1 inline-block h-2 w-3 rounded-sm bg-accent/25 align-middle" />80% range</span>
        <span><span className="mr-1 inline-block h-3 w-0.5 bg-accent align-middle" />forecast</span>
        <span><span className="mr-1 inline-block h-3 w-px border-l border-dashed border-muted align-middle" />start</span>
        {live != null && <span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-muted align-middle" />live price {fmt(live)}</span>}
      </div>
    </div>
  );
}

function ProbBar({ probUp }: { probUp: number }) {
  return (
    <div>
      <div className="mb-1 flex justify-between text-xs">
        <span className="text-muted">Chance it closes higher</span>
        <span className="font-mono">{probUp.toFixed(1)}%</span>
      </div>
      <div className="relative h-2 rounded-full bg-panel-2">
        <div className="absolute inset-y-0 left-0 rounded-full bg-accent" style={{ width: `${probUp}%` }} />
        <div className="absolute -top-1 -bottom-1 left-1/2 w-px bg-foreground/40" />
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-muted">
        <span>down</span>
        <span>50% = coin flip</span>
        <span>up</span>
      </div>
    </div>
  );
}

function Metric({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="rounded-lg bg-panel-2 px-3 py-2">
      <div className="text-xs text-muted">{label}</div>
      <div className="font-mono text-lg">{value}</div>
      <div className="text-[11px] text-muted">{note}</div>
    </div>
  );
}

function hm(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
}

function mmss(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function fmt(n: number): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
