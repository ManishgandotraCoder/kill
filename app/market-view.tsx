"use client";

import Link from "next/link";
import { useState } from "react";
import { useBinanceStream, useOrderBook, useStreamStatus } from "@/lib/binance/hooks";
import type { Level } from "@/lib/binance/orderbook";
import CandleChart from "./candle-chart";

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
  const { view, state } = useOrderBook(symbol);

  const change = ticker ? Number(ticker.P) : 0;

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-8 font-mono text-sm">
      <header className="mb-6 flex flex-wrap items-center gap-3">
        <select
          value={symbol}
          onChange={(e) => setSymbol(e.target.value)}
          className="rounded border border-zinc-300 bg-transparent px-2 py-1 dark:border-zinc-700"
        >
          {SYMBOLS.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <span className="text-zinc-500">
          ws: <StatusDot ok={status === "open"} /> {status} · book: <StatusDot ok={state === "live"} /> {state}
        </span>
        <Link href="/history" className="ml-auto text-zinc-500 hover:text-foreground">
          History (DB) →
        </Link>
      </header>

      <section className="mb-6 flex flex-wrap items-baseline gap-x-6 gap-y-1">
        <span className="text-3xl font-semibold">{ticker ? fmt(Number(ticker.c)) : "—"}</span>
        <span className={change >= 0 ? "text-emerald-600" : "text-rose-600"}>
          {ticker ? `${change >= 0 ? "+" : ""}${change.toFixed(2)}%` : ""}
        </span>
        {ticker && (
          <span className="text-zinc-500">
            H {fmt(Number(ticker.h))} · L {fmt(Number(ticker.l))} · Vol {Number(ticker.v).toFixed(0)}
          </span>
        )}
      </section>

      {trade && (
        <p className="mb-6 text-zinc-500">
          last trade{" "}
          <span className={trade.m ? "text-rose-600" : "text-emerald-600"}>
            {trade.m ? "SELL" : "BUY"} {Number(trade.q)} @ {fmt(Number(trade.p))}
          </span>
        </p>
      )}

      <CandleChart symbol={symbol} />

      <div className="grid grid-cols-2 gap-4">
        <BookSide title="Bids" levels={view?.bids ?? []} side="bid" />
        <BookSide title="Asks" levels={view?.asks ?? []} side="ask" />
      </div>
      {view && <p className="mt-4 text-xs text-zinc-500">lastUpdateId {view.lastUpdateId}</p>}
    </main>
  );
}

function BookSide({ title, levels, side }: { title: string; levels: Level[]; side: "bid" | "ask" }) {
  const max = Math.max(...levels.map(([, q]) => q), 0);
  return (
    <div>
      <h2 className="mb-2 text-zinc-500">{title}</h2>
      <ul>
        {levels.map(([price, qty]) => (
          <li key={price} className="relative flex justify-between px-1 py-0.5">
            <span
              className={`absolute inset-y-0 right-0 ${side === "bid" ? "bg-emerald-500/15" : "bg-rose-500/15"}`}
              style={{ width: `${(qty / max) * 100}%` }}
            />
            <span className={`relative ${side === "bid" ? "text-emerald-600" : "text-rose-600"}`}>{fmt(price)}</span>
            <span className="relative">{qty.toFixed(4)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function StatusDot({ ok }: { ok: boolean }) {
  return <span className={`inline-block h-2 w-2 rounded-full ${ok ? "bg-emerald-500" : "bg-amber-500"}`} />;
}

function fmt(n: number): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 8 });
}
