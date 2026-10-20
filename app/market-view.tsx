"use client";

import { useState } from "react";
import { useBinanceStream, useStreamStatus } from "@/lib/binance/hooks";
import Link from "next/link";
import { useAuth } from "./auth";
import CandleChart from "./candle-chart";
import { useDiscovered } from "./discovered";
import AiSignal from "./ai-signal";
import PatternPanel from "./pattern-panel";
import PredictionsSidebar from "./predictions-sidebar";
import StartPrediction from "./start-prediction";
import { usePredictions } from "./use-predictions";
import { useSignal } from "./use-signal";

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT"];

interface Ticker {
  c: string; // last price
  P: string; // 24h change %
  h: string;
  l: string;
  v: string;
}

interface Trade {
  p: string;
  q: string;
  m: boolean; // buyer is maker -> sell aggressor
  T: number;
}

export default function MarketView() {
  const [symbol, setSymbol] = useState(SYMBOLS[0]);
  const status = useStreamStatus();
  const ticker = useBinanceStream<Ticker>(`${symbol.toLowerCase()}@ticker`);
  const trade = useBinanceStream<Trade>(`${symbol.toLowerCase()}@trade`);
  const discovered = useDiscovered(symbol);
  const signal = useSignal(symbol);
  const { user, loading: authLoading } = useAuth();
  const predictions = usePredictions(symbol, !!user);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const change = ticker ? Number(ticker.P) : 0;
  const livePrice = ticker ? Number(ticker.c) : null;

  return (
    <div
      className={`mx-auto grid w-full max-w-[1680px] items-start gap-5 px-4 py-5 text-sm ${sidebarOpen ? "lg:grid-cols-[minmax(0,1fr)_360px]" : ""}`}
    >
      <main className="min-w-0">
        {/* symbol + price */}
        {/* relative z-20: the Start Predicting popover must sit above the cards below (each card is its own stacking layer because of backdrop-blur) */}
        <section className="card relative z-20 mb-5 p-5">
          <div className="mb-4 flex flex-wrap items-center gap-2" role="tablist" aria-label="Symbol">
            {SYMBOLS.map((s) => (
              <button
                key={s}
                role="tab"
                aria-selected={s === symbol}
                onClick={() => setSymbol(s)}
                className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                  s === symbol ? "bg-accent/15 text-accent ring-1 ring-accent/30" : "bg-panel-2 text-muted hover:text-foreground"
                }`}
              >
                {s.replace("USDT", "")}
                <span className="opacity-60">/USDT</span>
              </button>
            ))}
            {status !== "open" && <span className="text-xs text-amber-400">connection: {status}</span>}
            <div className="ml-auto flex items-center gap-2">
              {user ? (
                <StartPrediction
                  symbol={symbol}
                  onStart={async (m) => {
                    await predictions.start(m);
                    setSidebarOpen(true);
                  }}
                />
              ) : (
                !authLoading && (
                  <Link href="/login" className="rounded-lg bg-accent/15 text-accent ring-1 ring-accent/40 hover:bg-accent/25 px-3 py-1.5 text-xs font-semibold">
                    ▶ Log in to predict
                  </Link>
                )
              )}
              <button
                onClick={() => setSidebarOpen(!sidebarOpen)}
                aria-pressed={sidebarOpen}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${sidebarOpen ? "bg-panel-2 text-foreground" : "bg-panel-2 text-muted hover:text-foreground"}`}
              >
                Predictions{predictions.running.length > 0 && ` · ${predictions.running.length} running`}
              </button>
            </div>
          </div>

          <div className="flex flex-wrap items-end gap-x-8 gap-y-4">
            <div>
              <div className="eyebrow mb-1">{symbol.replace("USDT", " / USDT")}</div>
              <div className="flex items-baseline gap-3">
                <span className="font-mono text-4xl font-semibold tracking-tight">{livePrice ? fmt(livePrice) : "—"}</span>
                {ticker && (
                  <span className={`rounded-md px-2 py-0.5 text-sm font-medium ${change >= 0 ? "bg-up/10 text-up" : "bg-down/10 text-down"}`}>
                    {change >= 0 ? "▲ +" : "▼ "}
                    {change.toFixed(2)}%
                  </span>
                )}
              </div>
            </div>
            <dl className="flex flex-wrap gap-x-8 gap-y-2">
              <Stat label="24h high" value={ticker ? fmt(Number(ticker.h)) : "—"} />
              <Stat label="24h low" value={ticker ? fmt(Number(ticker.l)) : "—"} />
              <Stat label="24h volume" value={ticker ? Number(ticker.v).toLocaleString(undefined, { maximumFractionDigits: 0 }) : "—"} />
              <Stat
                label="Last trade"
                value={
                  trade ? (
                    <span className={trade.m ? "text-down" : "text-up"}>
                      {trade.m ? "Sell" : "Buy"} {Number(trade.q)}
                    </span>
                  ) : (
                    "—"
                  )
                }
              />
            </dl>
          </div>
        </section>

        <section className="card mb-5 p-4">
          <CandleChart symbol={symbol} discovered={discovered} forecast={signal.data} />
        </section>

        <AiSignal symbol={symbol} signal={signal} />

        <PatternPanel symbol={symbol} />
      </main>
      {sidebarOpen && (
        <PredictionsSidebar symbol={symbol} predictions={predictions} livePrice={livePrice} loggedIn={!!user} onClose={() => setSidebarOpen(false)} />
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="font-mono">{value}</dd>
    </div>
  );
}

function fmt(n: number): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 8 });
}
