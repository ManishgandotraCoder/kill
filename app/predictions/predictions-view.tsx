"use client";

import { useEffect, useState } from "react";
import type { Run, RunPrediction } from "@/lib/runs";


/** Results of the prediction runs created in the live page's left sidebar. */
export default function PredictionsView() {
  const [symbol, setSymbol] = useState("BTCUSDT");
  const [symbols, setSymbols] = useState<string[]>(["BTCUSDT"]);
  const [runId, setRunId] = useState<number | null>(null);
  const [result, setResult] = useState<{ symbol: string; runs: Run[] | null; error: string | null } | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    fetch("/api/candles", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { symbols: { symbol: string }[] }) => setSymbols(d.symbols.map((x) => x.symbol)))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    fetch(`/api/runs?symbol=${symbol}`, { signal: ctrl.signal, cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) throw new Error(await res.text());
        setResult({ symbol, runs: await res.json(), error: null });
      })
      .catch((e) => !ctrl.signal.aborted && setResult({ symbol, runs: null, error: String(e) }));
    // Refresh every minute so pending hours flip to right/wrong when they close.
    const timer = setTimeout(() => setTick((t) => t + 1), 60_000);
    return () => {
      ctrl.abort();
      clearTimeout(timer);
    };
  }, [symbol, tick]);

  const runs = result?.symbol === symbol ? result.runs : null;
  const run = runs?.find((r) => r.id === runId) ?? runs?.[0] ?? null;
  const rows = run ? [...run.predictions].reverse() : [];
  const done = rows.filter((r) => r.actual != null);
  const right = done.filter((r) => Math.sign(r.predicted - r.base) === Math.sign(r.actual! - r.base)).length;
  const inRange = done.filter((r) => r.actual! >= r.lower && r.actual! <= r.upper).length;
  const avgMiss = done.length ? done.reduce((a, r) => a + Math.abs(r.actual! - r.predicted) / r.actual!, 0) / done.length * 100 : null;

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-6 text-sm">
      <div className="mb-5 flex flex-wrap items-end gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Prediction runs</h1>
          <p className="text-muted">Create runs in the left sidebar of the Live page: pick a start and end time, and every 1-hour candle in between is predicted.</p>
        </div>
        <div className="ml-auto flex gap-2">
          {symbols.map((x) => (
            <button
              key={x}
              onClick={() => {
                setSymbol(x);
                setRunId(null);
              }}
              className={`rounded-full px-3 py-1 text-xs font-medium ${x === symbol ? "bg-foreground text-background" : "bg-panel-2 text-muted hover:text-foreground"}`}
            >
              {x}
            </button>
          ))}
        </div>
      </div>

      {result?.error && <p className="card mb-4 p-4 text-rose-600">{result.error}</p>}
      {runs && runs.length === 0 && <p className="card p-6 text-center text-muted">No runs yet for {symbol}. Create one in the left sidebar of the Live page.</p>}

      {runs && runs.length > 0 && (
        <div className="mb-5 flex flex-wrap gap-2">
          {runs.map((r) => (
            <button
              key={r.id}
              onClick={() => setRunId(r.id)}
              className={`rounded-lg border px-3 py-1.5 text-left text-xs ${r.id === run?.id ? "border-accent bg-accent/10" : "border-line bg-panel hover:bg-panel-2"}`}
            >
              <div className="font-medium">Run #{r.id} · {r.status}</div>
              <div className="text-muted">{span(r.startTs, r.endTs)}</div>
            </button>
          ))}
        </div>
      )}

      {run && (
        <>
          <section className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Tile label="Direction right" value={right} sub={pct(right, done.length)} tone="good" icon="✓" />
            <Tile label="Direction wrong" value={done.length - right} sub={pct(done.length - right, done.length)} tone="bad" icon="✗" />
            <Tile label="Inside 80% range" value={inRange} sub={`${pct(inRange, done.length)} · ${done.length - inRange} outside`} />
            <Tile
              label="Still to come"
              value={Math.max(1, Math.floor(run.hours)) - done.length}
              sub={avgMiss != null ? `avg price miss ${avgMiss.toFixed(3)}%` : "—"}
            />
          </section>
          {done.length > 0 && <RightWrongBar right={right} wrong={done.length - right} />}

          {rows.length === 0 ? (
            <p className="card p-6 text-center text-muted">This run starts {new Date(run.startTs).toLocaleString()}. Predictions appear as each hour begins.</p>
          ) : (
            <div className="card overflow-x-auto p-2">
              <table className="w-full min-w-[760px] text-left text-xs [&_td]:px-2 [&_td]:whitespace-nowrap [&_th]:px-2 [&_th]:whitespace-nowrap">
                <thead className="text-zinc-500">
                  <tr>
                    <th className="py-2 font-normal">Hour</th>
                    <th className="py-2 text-right font-normal">Start</th>
                    <th className="py-2 text-right font-normal">Predicted</th>
                    <th className="py-2 text-right font-normal">Actual</th>
                    <th className="py-2 pl-4 font-normal">Direction</th>
                    <th className="py-2 font-normal">80% range</th>
                    <th className="py-2 text-right font-normal">Miss</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <Row key={r.targetTs} r={r} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </main>
  );
}

function span(a: number, b: number): string {
  const d = (ms: number) => new Date(ms).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
  const min = Math.round((b - a) / 60_000);
  return `${d(a)} → ${d(b)} · ${min < 60 ? `${min}m` : `${min / 60}h`}`;
}

function Row({ r }: { r: RunPrediction }) {
  const predPct = ((r.predicted - r.base) / r.base) * 100;
  const actPct = r.actual != null ? ((r.actual - r.base) / r.base) * 100 : null;
  const dirRight = r.actual != null ? Math.sign(r.predicted - r.base) === Math.sign(r.actual - r.base) : null;
  const inRange = r.actual != null ? r.actual >= r.lower && r.actual <= r.upper : null;
  const start = new Date(r.targetTs);
  const end = new Date(r.targetTs + r.minutes * 60_000);

  return (
    <tr className="border-t border-zinc-200 dark:border-zinc-800">
      <td className="py-2 whitespace-nowrap">
        {start.toLocaleDateString(undefined, { day: "numeric", month: "short" })} {hm(start)}–{hm(end)}
      </td>
      <td className="py-2 text-right">{fmt(r.base)}</td>
      <td className="py-2 text-right whitespace-nowrap">
        {fmt(r.predicted)} <Change pct={predPct} />
      </td>
      <td className="py-2 text-right whitespace-nowrap">
        {r.actual != null ? (
          <>
            {fmt(r.actual)} <Change pct={actPct!} />
          </>
        ) : (
          <span className="text-zinc-500">closes {hm(end)}</span>
        )}
      </td>
      <td className="py-2 pl-4">
        <Verdict ok={dirRight} yes="Right" no="Wrong" />
      </td>
      <td className="py-2 whitespace-nowrap">
        <Verdict ok={inRange} yes="Inside" no="Outside" />
        <span className="ml-2 text-zinc-500">
          {fmt(r.lower)}–{fmt(r.upper)}
        </span>
      </td>
      <td className="py-2 text-right">
        {r.actual != null ? `${((Math.abs(r.actual - r.predicted) / r.actual) * 100).toFixed(3)}%` : ""}
      </td>
    </tr>
  );
}

function Verdict({ ok, yes, no }: { ok: boolean | null; yes: string; no: string }) {
  if (ok === null) return <span className="text-zinc-500">⏳ Pending</span>;
  return ok ? <span className="text-emerald-700 dark:text-emerald-500">✓ {yes}</span> : <span className="text-rose-600">✗ {no}</span>;
}

function Change({ pct }: { pct: number }) {
  return (
    <span className="text-zinc-500">
      ({pct >= 0 ? "▲ +" : "▼ "}
      {pct.toFixed(3)}%)
    </span>
  );
}

function Tile({ label, value, sub, tone, icon }: { label: string; value: number; sub: string; tone?: "good" | "bad"; icon?: string }) {
  const color = tone === "good" ? "text-emerald-700 dark:text-emerald-500" : tone === "bad" ? "text-rose-600" : "";
  return (
    <div className="rounded border border-zinc-200 p-3 dark:border-zinc-800">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className={`text-2xl ${color}`}>
        {icon && <span aria-hidden>{icon} </span>}
        {value}
      </div>
      <div className="text-xs text-zinc-500">{sub}</div>
    </div>
  );
}

function RightWrongBar({ right, wrong }: { right: number; wrong: number }) {
  const total = right + wrong;
  return (
    <div className="mb-8">
      <div className="flex h-3 w-full gap-[2px] overflow-hidden rounded" role="img" aria-label={`${right} right, ${wrong} wrong`}>
        {right > 0 && <div className="bg-emerald-600" style={{ width: `${(right / total) * 100}%` }} />}
        {wrong > 0 && <div className="bg-rose-600" style={{ width: `${(wrong / total) * 100}%` }} />}
      </div>
      <div className="mt-1 flex justify-between text-xs text-zinc-500">
        <span>✓ {pct(right, total)} right</span>
        <span>coin flip = 50%</span>
        <span>{pct(wrong, total)} wrong ✗</span>
      </div>
    </div>
  );
}

function pct(n: number, of: number): string {
  return of ? `${((n / of) * 100).toFixed(1)}%` : "—";
}

function hm(d: Date): string {
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
}

function fmt(n: number): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
