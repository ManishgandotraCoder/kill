"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { PredictionRow, PredictionSummary } from "../api/predictions/route";

const HOUR_MS = 3_600_000;
const SOURCES = [
  { value: "", label: "All" },
  { value: "manual", label: "Saved by me" },
  { value: "auto", label: "Hourly auto" },
];

interface Data {
  summary: PredictionSummary;
  rows: PredictionRow[];
  symbols: string[];
}

export default function PredictionsView() {
  const [symbol, setSymbol] = useState("");
  const [source, setSource] = useState("manual");
  const [result, setResult] = useState<{ key: string; data: Data | null; error: string | null } | null>(null);
  const [tick, setTick] = useState(0);
  const key = `${symbol}:${source}:${tick}`;

  useEffect(() => {
    const ctrl = new AbortController();
    const q = new URLSearchParams({ symbol, source });
    fetch(`/api/predictions?${q}`, { signal: ctrl.signal, cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) throw new Error(await res.text());
        setResult({ key, data: await res.json(), error: null });
      })
      .catch((e) => !ctrl.signal.aborted && setResult({ key, data: null, error: String(e) }));
    // Refresh every minute so pending predictions flip to right/wrong when their hour closes.
    const timer = setTimeout(() => setTick((t) => t + 1), 60_000);
    return () => {
      ctrl.abort();
      clearTimeout(timer);
    };
  }, [symbol, source, key]);

  // Keep showing the previous data while a refresh loads.
  const data = result?.data;
  const s = data?.summary;
  const resolved = s ? s.right + s.wrong : 0;

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-8 font-mono text-sm">
      <nav className="mb-6 flex flex-wrap items-center gap-4 text-zinc-500">
        <Link href="/" className="hover:text-foreground">← Live</Link>
        <h1 className="text-base font-semibold text-foreground">Prediction results</h1>
        <Link href="/history" className="ml-auto hover:text-foreground">History (DB) →</Link>
      </nav>

      <section className="mb-6 flex flex-wrap items-center gap-3">
        <select
          value={symbol}
          onChange={(e) => setSymbol(e.target.value)}
          aria-label="Symbol"
          className="rounded border border-zinc-300 bg-transparent px-2 py-1 dark:border-zinc-700"
        >
          <option value="">All symbols</option>
          {data?.symbols.map((sym) => <option key={sym}>{sym}</option>)}
        </select>
        <div className="flex gap-1" role="group" aria-label="Which predictions">
          {SOURCES.map((o) => (
            <button
              key={o.value}
              onClick={() => setSource(o.value)}
              aria-pressed={o.value === source}
              className={`rounded px-2 py-0.5 ${
                o.value === source
                  ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-black"
                  : "text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
      </section>

      {result?.error && <p className="mb-4 text-rose-600">{result.error}</p>}

      {s && (
        <>
          <section className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Tile label="Direction right" value={s.right} sub={pct(s.right, resolved)} tone="good" icon="✓" />
            <Tile label="Direction wrong" value={s.wrong} sub={pct(s.wrong, resolved)} tone="bad" icon="✗" />
            <Tile label="Inside 80% range" value={s.inRange} sub={`${pct(s.inRange, resolved)} · ${s.outRange} outside`} />
            <Tile
              label="Waiting for result"
              value={s.pending}
              sub={s.avgErrorPct != null ? `avg price miss ${Number(s.avgErrorPct).toFixed(3)}%` : "—"}
            />
          </section>

          {resolved > 0 && <RightWrongBar right={s.right} wrong={s.wrong} />}
        </>
      )}

      {data && data.rows.length === 0 && (
        <p className="rounded border border-dashed border-zinc-300 p-6 text-center text-zinc-500 dark:border-zinc-700">
          {source === "manual" ? (
            <>
              No saved predictions yet. Press <b className="font-normal text-foreground">Save prediction</b> on the{" "}
              <Link href="/" className="underline">live page</Link>; the result shows here when that hour closes.
            </>
          ) : (
            "No predictions yet."
          )}
        </p>
      )}

      {data && data.rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-left text-xs [&_td]:px-2 [&_th]:px-2 [&_td]:whitespace-nowrap [&_th]:whitespace-nowrap">
            <thead className="text-zinc-500">
              <tr>
                <th className="py-2 font-normal">Hour</th>
                <th className="py-2 font-normal">Symbol</th>
                <th className="py-2 text-right font-normal">Start</th>
                <th className="py-2 text-right font-normal">Predicted</th>
                <th className="py-2 text-right font-normal">Actual</th>
                <th className="py-2 pl-4 font-normal">Direction</th>
                <th className="py-2 font-normal">80% range</th>
                <th className="py-2 text-right font-normal">Miss</th>
                <th className="py-2 pl-4 font-normal">Saved by</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <Row key={`${r.symbol}:${r.targetTs}`} r={r} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}

function Row({ r }: { r: PredictionRow }) {
  const predPct = ((r.predicted - r.base) / r.base) * 100;
  const actPct = r.actual != null ? ((r.actual - r.base) / r.base) * 100 : null;
  const dirRight = r.actual != null ? Math.sign(r.predicted - r.base) === Math.sign(r.actual - r.base) : null;
  const inRange = r.actual != null ? r.actual >= r.lower && r.actual <= r.upper : null;
  const start = new Date(r.targetTs);
  const end = new Date(r.targetTs + HOUR_MS);

  return (
    <tr className="border-t border-zinc-200 dark:border-zinc-800">
      <td className="py-2 whitespace-nowrap">
        {start.toLocaleDateString(undefined, { day: "numeric", month: "short" })} {hm(start)}–{hm(end)}
      </td>
      <td className="py-2">{r.symbol}</td>
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
      <td className="py-2 pl-4 text-zinc-500">{r.source.replace("manual", "me").replace("auto", "hourly")}</td>
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
