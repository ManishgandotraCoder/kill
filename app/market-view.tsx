"use client";

import { useState } from "react";
import { useBinanceStream, useStreamStatus } from "@/lib/binance/hooks";
import CandleChart from "./candle-chart";
import { useDiscovered } from "./discovered";

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

  const change = ticker ? Number(ticker.P) : 0;
  const livePrice = ticker ? Number(ticker.c) : null;

  return (
    <div className="mx-auto w-full max-w-[1680px] px-4 py-5 text-sm">
      <main className="min-w-0">
        {/* symbol + price */}
        <section className="card mb-5 p-5">
          <div className="mb-4 flex flex-wrap items-center gap-2" role="tablist" aria-label="Symbol">
            {SYMBOLS.map((s) => (
              <button
                key={s}
                role="tab"
                aria-selected={s === symbol}
                onClick={() => setSymbol(s)}
                className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                  s === symbol ? "bg-foreground text-background" : "bg-panel-2 text-muted hover:text-foreground"
                }`}
              >
                {s.replace("USDT", "")}
                <span className="opacity-60">/USDT</span>
              </button>
            ))}
            {status !== "open" && <span className="text-xs text-amber-600">connection: {status}</span>}
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
          <CandleChart symbol={symbol} discovered={discovered} />
        </section>
      </main>
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
