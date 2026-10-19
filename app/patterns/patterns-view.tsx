"use client";

import { useEffect, useState } from "react";
import type { patternScoreboard } from "@/lib/predict";
import type { PatternGroup } from "@/lib/patterns";
import { GROUP_LABEL, Textbook, UpRateBar, Verdict } from "../pattern-ui";
import DiscoveredView from "./discovered-view";

type Board = Awaited<ReturnType<typeof patternScoreboard>>;
const GROUPS: PatternGroup[] = ["bullish", "bearish", "continuation", "indecision"];

export default function PatternsView() {
  const [symbol, setSymbol] = useState("BTCUSDT");
  const [symbols, setSymbols] = useState<string[]>(["BTCUSDT"]);
  const [tab, setTab] = useState<"discovered" | "classic">("discovered");
  const [state, setState] = useState<{ symbol: string; board: Board | null; error: string | null } | null>(null);

  useEffect(() => {
    fetch("/api/candles", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { symbols: { symbol: string }[] }) => setSymbols(d.symbols.map((s) => s.symbol)))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    fetch(`/api/patterns?symbol=${symbol}`, { signal: ctrl.signal, cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error(await r.text());
        setState({ symbol, board: await r.json(), error: null });
      })
      .catch((e) => !ctrl.signal.aborted && setState({ symbol, board: null, error: String(e) }));
    return () => ctrl.abort();
  }, [symbol]);

  const board = state?.symbol === symbol ? state.board : null;
  const error = state?.symbol === symbol ? state.error : null;

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-6 text-sm">
      <div className="mb-5 flex flex-wrap items-end gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Candlestick patterns</h1>
          <p className="max-w-3xl text-muted">
            What 5 years of 1-hour candles actually did after each pattern: sequences the app discovered on its own, and the 20 classic
            textbook patterns.
          </p>
          <div className="mt-3 flex gap-0.5 rounded-lg bg-panel-2 p-0.5 text-xs font-medium" role="tablist">
            {(["discovered", "classic"] as const).map((t) => (
              <button
                key={t}
                role="tab"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
                className={`rounded-md px-3 py-1.5 ${tab === t ? "bg-panel shadow-sm" : "text-muted hover:text-foreground"}`}
              >
                {t === "discovered" ? "Discovered patterns" : "Classic 20"}
              </button>
            ))}
          </div>
        </div>
        <div className="ml-auto flex gap-2">
          {symbols.map((s) => (
            <button
              key={s}
              onClick={() => setSymbol(s)}
              className={`rounded-full px-3 py-1 text-xs font-medium ${s === symbol ? "bg-foreground text-background" : "bg-panel-2 text-muted hover:text-foreground"}`}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {tab === "discovered" && <DiscoveredView symbol={symbol} />}
      {tab === "classic" && error && <p className="card p-4 text-down">{error}</p>}
      {tab === "classic" && !board && !error && <div className="card h-64 animate-pulse" />}

      {tab === "classic" && board && (
        <>
          <section className="card mb-5 grid gap-4 p-5 sm:grid-cols-3">
            <div>
              <div className="eyebrow">History analysed</div>
              <div className="text-lg">{board.hours.toLocaleString()} hours</div>
              <div className="text-xs text-muted">
                {new Date(board.from).toLocaleDateString(undefined, { dateStyle: "medium" })} → {new Date(board.to).toLocaleDateString(undefined, { dateStyle: "medium" })}
              </div>
            </div>
            <div>
              <div className="eyebrow">Bar to beat</div>
              <div className="text-lg">{board.baselineUpPct.toFixed(1)}% up</div>
              <div className="text-xs text-muted">how often any hour closes higher</div>
            </div>
            <div>
              <div className="eyebrow">How to read the verdict</div>
              <div className="text-xs text-muted">
                A pattern counts only if its up-rate differs from the bar to beat by at least 2 standard errors (|z| ≥ 2) and it was seen 30+
                times. Otherwise it is <i>no real edge</i> — the next hour was a coin flip.
              </div>
            </div>
          </section>

          {GROUPS.map((g) => {
            const rows = board.patterns.filter((p) => p.group === g);
            return (
              <section key={g} className="card mb-5 overflow-hidden">
                <h2 className="border-b border-line px-5 py-3 font-medium">{GROUP_LABEL[g]}</h2>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[860px] text-left text-xs">
                    <thead className="text-muted">
                      <tr className="[&>th]:px-3 [&>th]:py-2 [&>th]:font-normal">
                        <th className="w-[34%] !pl-5">Pattern</th>
                        <th>Textbook</th>
                        <th className="text-right">Seen</th>
                        <th className="w-40">Next hour up (40–60% scale)</th>
                        <th className="text-right">Up</th>
                        <th className="text-right">Avg move</th>
                        <th className="text-right">Up after 4h</th>
                        <th className="!pr-5">History says</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((p) => (
                        <tr key={p.id} className="border-t border-line align-top [&>td]:px-3 [&>td]:py-3">
                          <td className="!pl-5">
                            <div className="font-medium">
                              {p.name} <span className="font-mono text-[10px] text-muted">{p.code}</span>
                            </div>
                            <div className="text-muted">{p.description}</div>
                          </td>
                          <td className="whitespace-nowrap">
                            <Textbook dir={p.textbook} />
                          </td>
                          <td className="text-right font-mono">{p.stats.count.toLocaleString()}</td>
                          <td className="pt-4">{p.stats.count > 0 && <UpRateBar upPct={p.stats.upPct} baselinePct={board.baselineUpPct} />}</td>
                          <td className="text-right font-mono">{p.stats.count ? `${p.stats.upPct.toFixed(1)}%` : "—"}</td>
                          <td className={`text-right font-mono ${p.stats.avgPct >= 0 ? "text-up" : "text-down"}`}>
                            {p.stats.count ? `${p.stats.avgPct >= 0 ? "+" : ""}${p.stats.avgPct.toFixed(3)}%` : "—"}
                          </td>
                          <td className="text-right font-mono">{p.up4hPct != null ? `${p.up4hPct.toFixed(1)}%` : "—"}</td>
                          <td className="!pr-5">
                            <Verdict textbook={p.textbook} stats={p.stats} />
                            {p.lastSeen && (
                              <div className="mt-1 text-[11px] text-muted">
                                last: {new Date(p.lastSeen).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false })}
                              </div>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            );
          })}
          <p className="text-xs text-muted">
            20 patterns are tested, so about one could cross |z| ≥ 2 by luck alone; the strongest results (|z| above 3) are the most
            trustworthy. Not trading advice.
          </p>
        </>
      )}
    </main>
  );
}
