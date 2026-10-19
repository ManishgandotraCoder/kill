"use client";

import Link from "next/link";
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

export function ForecastPanel({ forecast, error }: { forecast: Forecast | null; error: string | null }) {
  const [savedFor, setSavedFor] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  if (error) return <p className="mb-8 text-xs text-rose-600">Forecast unavailable: {error}</p>;
  if (!forecast) return <p className="mb-8 text-xs text-zinc-500">Training forecast model…</p>;

  const f = forecast;
  const b = f.backtest;
  const up = f.expectedPct >= 0;
  const from = new Date(f.targetTs);
  const to = new Date(f.targetTs + HOUR_MS);
  const hm = (d: Date) => d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  const key = `${f.symbol}:${f.targetTs}`;
  const saved = f.savedManually || savedFor === key;

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch("/api/predictions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: f.symbol }),
      });
      if (!res.ok) throw new Error(await res.text());
      setSavedFor(key);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="mb-8 rounded border border-zinc-200 p-4 text-xs dark:border-zinc-800">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h2 className="text-sm">
          Next-hour forecast <span className="text-zinc-500">· candle {hm(from)}–{hm(to)} · blue cone on the chart</span>
        </h2>
        <div className="ml-auto flex items-center gap-3">
          <button
            onClick={save}
            disabled={saved || saving}
            className="rounded bg-zinc-900 px-3 py-1 text-white hover:bg-zinc-700 disabled:opacity-60 dark:bg-zinc-100 dark:text-black dark:hover:bg-zinc-300"
          >
            {saved ? "✓ Saved" : saving ? "Saving…" : "Save prediction"}
          </button>
          <Link href="/predictions" className="text-zinc-500 hover:text-foreground">
            Right / wrong →
          </Link>
        </div>
      </div>
      {saveError && <p className="mb-3 text-rose-600">{saveError}</p>}

      <dl className="mb-4 grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
        <Stat label="Predicted close" value={fmt(f.predictedClose)} />
        <Stat
          label="Expected change"
          value={
            <span className={up ? "text-emerald-600" : "text-rose-600"}>
              {up ? "▲ +" : "▼ "}
              {f.expectedPct.toFixed(3)}%
            </span>
          }
        />
        <Stat label="80% likely range" value={`${fmt(f.lower)} – ${fmt(f.upper)}`} />
        <Stat label="Chance it closes higher" value={`${f.probUp.toFixed(1)}%`} />
      </dl>

      <p className="mb-1 text-zinc-500">
        How good is it? Tested on {b.testHours.toLocaleString()} hours since{" "}
        {new Date(b.testFrom).toLocaleDateString(undefined, { dateStyle: "medium" })} that the model never saw:
      </p>
      <ul className="mb-2 list-disc pl-5 text-zinc-500">
        <li>
          Direction right <b className="font-normal text-foreground">{b.directionAccuracy.toFixed(1)}%</b> of hours (a coin flip is 50%).
        </li>
        <li>
          Average miss <b className="font-normal text-foreground">{b.modelMaePct.toFixed(3)}%</b> vs{" "}
          <b className="font-normal text-foreground">{b.naiveMaePct.toFixed(3)}%</b> for guessing &ldquo;no change&rdquo;.
        </li>
        <li>
          Price closed inside the 80% range <b className="font-normal text-foreground">{b.bandCoverage.toFixed(1)}%</b> of hours.
        </li>
        <li>
          Live record:{" "}
          {f.live.count === 0 ? (
            "no finished predictions yet (one is logged per hour)"
          ) : (
            <>
              {f.live.count} hours, direction <b className="font-normal text-foreground">{f.live.directionAccuracy?.toFixed(1)}%</b>, inside
              range <b className="font-normal text-foreground">{f.live.bandCoverage?.toFixed(1)}%</b>
            </>
          )}
        </li>
      </ul>
      <p className="text-zinc-500">
        Hourly prices are close to random: the range (how far price may move) is reliable, the direction barely beats a coin flip.
        Not trading advice.
      </p>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-zinc-500">{label}</dt>
      <dd className="text-sm">{value}</dd>
    </div>
  );
}

function fmt(n: number): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
