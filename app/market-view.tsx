"use client";

import { useCallback, useMemo, useState } from "react";
import { useBinanceStream, useStreamStatus } from "@/lib/binance/hooks";
import CandleChart, { type ChartMarker } from "./candle-chart";
import ExplainSidebar from "./explain-sidebar";
import { ForecastPanel, useForecast } from "./forecast";
import { addPoint, HOUR_MS, useDiscovered, useExplanation, usePoints, useRuns } from "./points";
import PointsSidebar, { CloseButton } from "./points-sidebar";

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
  const discovered = useDiscovered(symbol);

  // Left sidebar: prediction runs + picked points. Right sidebar explains the selection:
  // "now", a point id, or "run:<id>:<hourTs>".
  const allPoints = usePoints();
  const points = useMemo(() => allPoints.filter((p) => p.symbol === symbol), [allPoints, symbol]);
  const [selectedId, setSelectedId] = useState("now");
  const [pickMode, setPickMode] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  // Changes each hour, so open hours re-fetch and pick up their result.
  const version = String(forecast?.targetTs ?? "");
  const { runs, reload: reloadRuns } = useRuns(symbol, version);

  const selectedIdx = points.findIndex((p) => p.id === selectedId);
  const selectedPoint = selectedIdx >= 0 ? points[selectedIdx] : null;
  const runSel = selectedId.match(/^run:(\d+):(\d+)$/);
  const selectedRun = runSel ? (runs?.find((r) => r.id === Number(runSel[1])) ?? null) : null;
  const runHour = runSel ? Number(runSel[2]) : null;
  const selectedHour = selectedPoint?.hourTs ?? runHour;
  // Run hours are explained with the run's frozen model, so they match what the run stored.
  const explained = useExplanation(symbol, selectedHour, version, selectedRun?.startTs);

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
      ...(runHour !== null && runSel ? [{ hourTs: runHour, label: `R${runSel[1]}`, selected: true }] : []),
    ],
    [points, selectedId, runHour, runSel],
  );
  const cone = explained.data ?? (selectedHour !== null ? null : forecast);
  const title = selectedPoint ? `P${selectedIdx + 1}` : runSel ? `Run #${runSel[1]}` : "Now";

  const grid = leftOpen && rightOpen
    ? "lg:grid-cols-[264px_minmax(0,1fr)] xl:grid-cols-[264px_minmax(0,1fr)_380px]"
    : leftOpen
      ? "lg:grid-cols-[264px_minmax(0,1fr)]"
      : rightOpen
        ? "xl:grid-cols-[minmax(0,1fr)_380px]"
        : "";

  const change = ticker ? Number(ticker.P) : 0;
  const livePrice = ticker ? Number(ticker.c) : null;

  return (
    <div className={`mx-auto grid w-full max-w-[1680px] gap-5 px-4 py-5 text-sm ${grid}`}>
      {leftOpen && (
        <aside className="card order-2 p-4 lg:sticky lg:top-[72px] lg:order-1 lg:max-h-[calc(100vh-88px)] lg:self-start lg:overflow-y-auto">
          <PointsSidebar
            symbol={symbol}
            runs={runs}
            onRunsChanged={reloadRuns}
            points={points}
            selected={selectedPoint || selectedRun ? selectedId : "now"}
            onSelect={setSelectedId}
            pickMode={pickMode}
            onTogglePick={() => {
              setPickMode(!pickMode);
              setNotice(null);
            }}
            version={version}
            notice={notice}
            onClose={() => setLeftOpen(false)}
          />
        </aside>
      )}

      {rightOpen && (
        <aside
          className={`card order-3 p-4 xl:sticky xl:top-[72px] xl:col-span-1 xl:max-h-[calc(100vh-88px)] xl:self-start xl:overflow-y-auto ${leftOpen ? "lg:col-span-2" : ""}`}
        >
          <div className="mb-1 flex justify-end">
            <CloseButton onClick={() => setRightOpen(false)} label="Close right sidebar" />
          </div>
          <ExplainSidebar title={title} data={explained.data} error={explained.error} />
        </aside>
      )}

      <main className={`order-1 min-w-0 ${leftOpen ? "lg:order-2" : ""}`}>
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
            <span className="ml-auto flex gap-1">
              <SidebarToggle open={leftOpen} onClick={() => setLeftOpen(!leftOpen)} label="Runs" side="left" />
              <SidebarToggle open={rightOpen} onClick={() => setRightOpen(!rightOpen)} label="Why" side="right" />
            </span>
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
          <CandleChart symbol={symbol} cone={cone} markers={markers} pickMode={pickMode} onPick={onPick} discovered={discovered} />
        </section>

        <ForecastPanel forecast={forecast} error={forecastError} livePrice={livePrice} />
      </main>
    </div>
  );
}

function SidebarToggle({ open, onClick, label, side }: { open: boolean; onClick: () => void; label: string; side: "left" | "right" }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={open}
      title={`${open ? "Hide" : "Show"} ${side} sidebar`}
      className={`rounded-md px-2 py-1 text-xs font-medium ${open ? "bg-panel-2 text-foreground" : "text-muted hover:bg-panel-2"}`}
    >
      {side === "left" ? `◧ ${label}` : `${label} ◨`}
    </button>
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
