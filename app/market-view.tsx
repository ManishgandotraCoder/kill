"use client";

import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import { useBinanceStream, useStreamStatus } from "@/lib/binance/hooks";
import CandleChart, { type ChartMarker } from "./candle-chart";
import ExplainSidebar from "./explain-sidebar";
import {  useForecast } from "./forecast";
import { addPoint, HOUR_MS, useExplanation, usePoints } from "./points";
import PointsSidebar from "./points-sidebar";

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
  const { forecast, error: forecastError } = useForecast(symbol);

  // Picked points (left sidebar) and which item the right sidebar explains.
  const allPoints = usePoints();
  const points = useMemo(() => allPoints.filter((p) => p.symbol === symbol), [allPoints, symbol]);
  const [selectedId, setSelectedId] = useState("now");
  const [pickMode, setPickMode] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const selectedIdx = points.findIndex((p) => p.id === selectedId);
  const selectedPoint = selectedIdx >= 0 ? points[selectedIdx] : null;
  // "saved:<ms>" = a prediction from the DB list.
  const savedHour = selectedId.startsWith("saved:") ? Number(selectedId.slice(6)) : null;
  const selectedHour = selectedPoint?.hourTs ?? savedHour;
  // Changes each hour, so open hours re-fetch and pick up their result.
  const version = String(forecast?.targetTs ?? "");
  const explained = useExplanation(symbol, selectedHour, version);

  const onPick = useCallback(
    (timeMs: number) => {
      const currentHour = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
      if (timeMs >= currentHour + HOUR_MS) {
        setNotice("That hour hasn't started yet - pick a candle up to now.");
        return;
      }
      setNotice(null);
      setSelectedId(addPoint(symbol, timeMs).id);
    },
    [symbol],
  );

  const markers: ChartMarker[] = useMemo(
    () => [
      ...points.map((p, i) => ({ hourTs: p.hourTs, label: `P${i + 1}`, selected: p.id === selectedId })),
      ...(savedHour !== null ? [{ hourTs: savedHour, label: "saved", selected: true }] : []),
    ],
    [points, selectedId, savedHour],
  );
  const cone = explained.data ?? (selectedHour !== null ? null : forecast);

  const change = ticker ? Number(ticker.P) : 0;

  return (
    <div className="mx-auto grid w-full max-w-[1680px] gap-6 px-4 py-8 font-mono text-sm lg:grid-cols-[250px_minmax(0,1fr)] xl:grid-cols-[250px_minmax(0,1fr)_360px]">
      <aside className="order-2 lg:sticky lg:top-4 lg:order-1 lg:max-h-[calc(100vh-2rem)] lg:self-start lg:overflow-y-auto">
        <PointsSidebar
          symbol={symbol}
          points={points}
          selected={selectedPoint || savedHour !== null ? selectedId : "now"}
          onSelect={setSelectedId}
          pickMode={pickMode}
          onTogglePick={() => {
            setPickMode(!pickMode);
            setNotice(null);
          }}
          version={version}
          notice={notice}
        />
      </aside>

      <aside className="order-3 border-zinc-200 lg:col-span-2 xl:sticky xl:top-4 xl:col-span-1 xl:max-h-[calc(100vh-2rem)] xl:self-start xl:overflow-y-auto xl:border-l xl:pl-6 dark:border-zinc-800">
        <ExplainSidebar
          title={selectedPoint ? `P${selectedIdx + 1}` : savedHour !== null ? "Saved prediction" : "Now"}
          data={explained.data}
          error={explained.error}
        />
      </aside>

    <main className="order-1 min-w-0 lg:order-2">
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
          ws: <StatusDot ok={status === "open"} /> {status}
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

      <CandleChart symbol={symbol} cone={cone} markers={markers} pickMode={pickMode} onPick={onPick} />
      {/* <ForecastPanel forecast={forecast} error={forecastError} /> */}

    </main>
    </div>
  );
}

function StatusDot({ ok }: { ok: boolean }) {
  return <span className={`inline-block h-2 w-2 rounded-full ${ok ? "bg-emerald-500" : "bg-amber-500"}`} />;
}

function fmt(n: number): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 8 });
}
