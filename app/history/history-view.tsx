"use client";

import { useCallback, useEffect, useState } from "react";
import type { SyncProgress } from "@/lib/syncCandles";
import HistoryChart from "./history-chart";

const INTERVALS = ["15m", "1h", "4h", "1d"];

interface Info {
  symbols: { symbol: string; active: boolean; years_back: number }[];
  stats: { symbol: string; interval: string; count: number; first: number; last: number }[];
  running: SyncProgress[];
}

export default function HistoryView() {
  const [info, setInfo] = useState<Info | null>(null);
  const [symbol, setSymbol] = useState("BTCUSDT");
  const [interval, setInterval_] = useState("1h");
  const [newSymbol, setNewSymbol] = useState("");
  const [progress, setProgress] = useState<SyncProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chartVersion, setChartVersion] = useState(0);

  const loadInfo = useCallback(async () => {
    const res = await fetch("/api/candles", { cache: "no-store" });
    if (!res.ok) throw new Error(await res.text());
    const data: Info = await res.json();
    setInfo(data);
    return data;
  }, []);

  /** Starts a sync (or attaches to a running one) and follows its progress stream. */
  const sync = useCallback(
    async (sym: string, iv: string) => {
      setError(null);
      setProgress({ symbol: sym, interval: iv, status: "running", pct: 0, saved: 0 });
      try {
        const res = await fetch("/api/sync/stream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ symbol: sym, interval: iv }),
        });
        if (!res.ok || !res.body) throw new Error(await res.text());

        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buf = "";
        let last: SyncProgress | null = null;
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += value;
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) {
            if (!line) continue;
            last = JSON.parse(line) as SyncProgress;
            setProgress(last);
          }
        }
        if (last?.status === "error") setError(last.error ?? "Sync failed");
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setProgress(null);
      }
      await loadInfo().catch(() => {});
      setChartVersion((v) => v + 1);
    },
    [loadInfo],
  );

  useEffect(() => {
    fetch("/api/candles", { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) throw new Error(await res.text());
        const data: Info = await res.json();
        setInfo(data);
        // Re-attach to a sync that was started before this page loaded.
        const running = data.running[0];
        if (running) {
          setSymbol(running.symbol);
          setInterval_(running.interval);
          void sync(running.symbol, running.interval);
        }
      })
      .catch((e) => setError(`Database unavailable: ${e instanceof Error ? e.message : e}`));
  }, [sync]);

  const busy = progress?.status === "running";
  const stat = info?.stats.find((s) => s.symbol === symbol && s.interval === interval);
  const yearsBack = info?.symbols.find((s) => s.symbol === symbol)?.years_back ?? 5;

  const addSymbol = (e: React.FormEvent) => {
    e.preventDefault();
    const s = newSymbol.trim().toUpperCase();
    if (!s) return;
    setSymbol(s);
    setNewSymbol("");
    void sync(s, interval);
  };

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-8 font-mono text-sm">
      <h1 className="mb-6 text-base font-semibold">Price history (DB)</h1>

      <section className="mb-4 flex flex-wrap items-center gap-3">
        <select
          value={symbol}
          onChange={(e) => setSymbol(e.target.value)}
          disabled={busy}
          className="rounded border border-zinc-300 bg-transparent px-2 py-1 dark:border-zinc-700"
          aria-label="Symbol"
        >
          {(info?.symbols.length ? info.symbols.map((s) => s.symbol) : [symbol]).map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <div className="flex gap-1" role="group" aria-label="Interval">
          {INTERVALS.map((i) => (
            <button
              key={i}
              onClick={() => setInterval_(i)}
              disabled={busy}
              aria-pressed={i === interval}
              className={`rounded px-2 py-0.5 disabled:opacity-50 ${
                i === interval
                  ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-black"
                  : "text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
              }`}
            >
              {i}
            </button>
          ))}
        </div>
        <button
          onClick={() => sync(symbol, interval)}
          disabled={busy}
          className="rounded bg-emerald-600 px-3 py-1 text-white hover:bg-emerald-700 disabled:opacity-50"
        >
          {busy ? "Syncing…" : stat ? "Fetch new candles from Binance" : `Fetch ${yearsBack}y from Binance → DB`}
        </button>
        <form onSubmit={addSymbol} className="flex gap-1">
          <input
            value={newSymbol}
            onChange={(e) => setNewSymbol(e.target.value)}
            placeholder="Add symbol, e.g. ETHUSDT"
            disabled={busy}
            className="w-48 rounded border border-zinc-300 bg-transparent px-2 py-1 dark:border-zinc-700"
          />
          <button disabled={busy || !newSymbol.trim()} className="rounded border border-zinc-300 px-2 py-1 disabled:opacity-50 dark:border-zinc-700">
            Add
          </button>
        </form>
      </section>

      {progress && <ProgressBar p={progress} />}
      {error && <p className="mb-4 text-rose-600">{error}</p>}

      <p className="mb-4 text-xs text-zinc-500">
        {stat
          ? `In DB: ${stat.count.toLocaleString()} × ${interval} candles · ${fmtDate(stat.first)} → ${fmtDate(stat.last)}`
          : `Nothing stored for ${symbol} ${interval} yet.`}
        <br />
        1h candles of every active symbol are refreshed automatically every hour.
      </p>

      <HistoryChart symbol={symbol} interval={interval} version={chartVersion} />

      {info && info.stats.length > 0 && (
        <table className="mt-8 w-full text-left text-xs">
          <thead className="text-zinc-500">
            <tr>
              <th className="py-1 font-normal">Symbol</th>
              <th className="py-1 font-normal">Interval</th>
              <th className="py-1 text-right font-normal">Candles</th>
              <th className="py-1 font-normal pl-4">From</th>
              <th className="py-1 font-normal">To</th>
            </tr>
          </thead>
          <tbody>
            {info.stats.map((s) => (
              <tr key={`${s.symbol}:${s.interval}`} className="border-t border-zinc-200 dark:border-zinc-800">
                <td className="py-1">{s.symbol}</td>
                <td className="py-1">{s.interval}</td>
                <td className="py-1 text-right">{s.count.toLocaleString()}</td>
                <td className="py-1 pl-4">{fmtDate(s.first)}</td>
                <td className="py-1">{fmtDate(s.last)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}

function ProgressBar({ p }: { p: SyncProgress }) {
  const pct = Math.round(p.pct * 10) / 10;
  const label =
    p.status === "running" ? `Syncing ${p.symbol} ${p.interval}` : p.status === "done" ? "Done" : "Failed";
  return (
    <div className="mb-4">
      <div className="mb-1 flex justify-between text-xs">
        <span className="text-zinc-500">
          {label} · {p.saved.toLocaleString()} candles saved
        </span>
        <span>{pct.toFixed(1)}%</span>
      </div>
      <div
        className="h-2 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className={`h-full rounded-full transition-[width] duration-300 ${p.status === "error" ? "bg-rose-600" : "bg-emerald-600"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
