"use client";

import { useState } from "react";
import type { Explanation } from "@/lib/predict";
import {
  clearPoints,
  hourLabel,
  type Point,
  removePoint,
  type SavedPrediction,
  signedPct,
  useExplanation,
  useExplanationList,
  useSavedPredictions,
} from "./points";

interface Props {
  symbol: string;
  points: Point[];
  selected: string; // "now" or a point id
  onSelect: (id: string) => void;
  pickMode: boolean;
  onTogglePick: () => void;
  version: string;
  notice: string | null;
}

/** Left sidebar: the live forecast plus every point picked on the chart. */
export default function PointsSidebar({ symbol, points, selected, onSelect, pickMode, onTogglePick, version, notice }: Props) {
  const now = useExplanation(symbol, null, version);
  const results = useExplanationList(
    symbol,
    points.map((p) => p.hourTs),
    version,
  );
  const done = points.map((p) => results.get(p.hourTs)?.data?.actual).filter((a) => a != null);
  const right = done.filter((a) => a.directionRight).length;
  const inRange = done.filter((a) => a.inRange).length;
  const saved = useSavedPredictions(symbol, version);

  return (
    <div className="text-xs">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-sm">Points</h2>
        <button
          onClick={onTogglePick}
          aria-pressed={pickMode}
          className={`rounded px-2 py-1 ${
            pickMode
              ? "bg-[#eb6834] text-white dark:bg-[#d95926]"
              : "border border-zinc-300 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
          }`}
        >
          {pickMode ? "Done picking" : "+ Pick points"}
        </button>
      </div>
      <p className="mb-3 text-zinc-500">
        {pickMode
          ? "Click candles on the chart. Each point predicts the 1-hour candle it falls in, using only data from before that hour."
          : "Pick candles on the chart to see what the model would have predicted there, and whether it was right."}
      </p>
      {notice && <p className="mb-3 text-rose-600">{notice}</p>}

      {done.length > 0 && (
        <div className="mb-3 rounded border border-zinc-200 p-2 dark:border-zinc-800">
          <div className="flex gap-3">
            <span className="text-emerald-700 dark:text-emerald-500">✓ {right} right</span>
            <span className="text-rose-600">✗ {done.length - right} wrong</span>
            {points.length > done.length && <span className="text-zinc-500">⏳ {points.length - done.length}</span>}
          </div>
          <div className="text-zinc-500">
            {inRange} of {done.length} closed inside the 80% range
          </div>
        </div>
      )}

      <ul className="space-y-1">
        <Item label="Now" result={now} fallbackHour={null} selected={selected === "now"} onSelect={() => onSelect("now")} />
      </ul>

      <SavedList rows={saved} selected={selected} onSelect={onSelect} />

      <h3 className="mt-4 mb-1 text-zinc-500">Picked points ({points.length})</h3>
      {points.length === 0 && <p className="text-zinc-400">None yet.</p>}
      <ul className="space-y-1">
        {points.map((p, i) => (
          <Item
            key={p.id}
            label={`P${i + 1}`}
            result={results.get(p.hourTs)}
            fallbackHour={p.hourTs}
            selected={selected === p.id}
            onSelect={() => onSelect(p.id)}
            onRemove={() => removePoint(p.id)}
          />
        ))}
      </ul>

      {points.length > 0 && (
        <button onClick={() => clearPoints(symbol)} className="mt-3 text-zinc-500 underline hover:text-foreground">
          Clear all points
        </button>
      )}
    </div>
  );
}

function Item(props: {
  label: string;
  result: { data: Explanation | null; error: string | null } | undefined;
  fallbackHour: number | null;
  selected: boolean;
  onSelect: () => void;
  onRemove?: () => void;
}) {
  const data = props.result?.data;
  const error = props.result?.error;
  const up = data ? data.expectedPct >= 0 : null;
  const isNow = !props.onRemove;

  return (
    <li>
      <div
        className={`flex items-start gap-2 rounded border px-2 py-1.5 ${
          props.selected ? "border-[#2a78d6] bg-[#2a78d6]/10 dark:border-[#3987e5]" : "border-transparent hover:bg-zinc-100 dark:hover:bg-zinc-800/60"
        }`}
      >
        <button onClick={props.onSelect} className="min-w-0 flex-1 text-left">
          <div className="flex items-baseline gap-2">
            <span className={isNow ? "font-semibold" : "text-[#eb6834] dark:text-[#d95926]"}>{props.label}</span>
            <span className="truncate text-zinc-500">
              {data ? hourLabel(data.targetTs) : props.fallbackHour !== null ? hourLabel(props.fallbackHour) : "current hour"}
            </span>
          </div>
          {error && <div className="text-rose-600">{error}</div>}
          {!data && !error && <div className="text-zinc-500">analysing…</div>}
          {data && (
            <div className="flex flex-wrap gap-x-2">
              <span>
                predicted{" "}
                <span className={up ? "text-emerald-700 dark:text-emerald-500" : "text-rose-600"}>
                  {up ? "▲" : "▼"} {signedPct(data.expectedPct)}
                </span>
              </span>
              {data.actual ? (
                <span className={data.actual.directionRight ? "text-emerald-700 dark:text-emerald-500" : "text-rose-600"}>
                  {data.actual.directionRight ? "✓ right" : "✗ wrong"}
                </span>
              ) : (
                <span className="text-zinc-500">⏳ {isNow ? "live" : "pending"}</span>
              )}
            </div>
          )}
        </button>
        {props.onRemove && (
          <button onClick={props.onRemove} aria-label={`Remove ${props.label}`} className="px-1 text-zinc-400 hover:text-rose-600">
            ×
          </button>
        )}
      </div>
    </li>
  );
}

/** All predictions stored in the DB (hourly auto + saved with the button). */
function SavedList({ rows, selected, onSelect }: { rows: SavedPrediction[] | null; selected: string; onSelect: (id: string) => void }) {
  const [open, setOpen] = useState(true);
  const done = rows?.filter((r) => r.actual != null) ?? [];
  const right = done.filter((r) => Math.sign(r.predicted - r.base) === Math.sign(r.actual! - r.base)).length;

  return (
    <div className="mt-4">
      <button onClick={() => setOpen(!open)} className="mb-1 flex w-full items-baseline justify-between text-left text-zinc-500 hover:text-foreground">
        <span>
          {open ? "▾" : "▸"} Saved predictions ({rows?.length ?? "…"})
        </span>
        {done.length > 0 && (
          <span>
            <span className="text-emerald-700 dark:text-emerald-500">✓{right}</span>{" "}
            <span className="text-rose-600">✗{done.length - right}</span>
          </span>
        )}
      </button>
      {open && rows?.length === 0 && <p className="text-zinc-400">None yet - use Save prediction, or wait for the hourly job.</p>}
      {open && rows && rows.length > 0 && (
        <ul className="space-y-1">
          {rows.map((r) => {
            const id = `saved:${r.targetTs}`;
            const up = r.predicted >= r.base;
            const pct = (r.predicted / r.base - 1) * 100;
            const ok = r.actual == null ? null : Math.sign(r.predicted - r.base) === Math.sign(r.actual - r.base);
            return (
              <li key={id}>
                <button
                  onClick={() => onSelect(id)}
                  className={`w-full rounded border px-2 py-1.5 text-left ${
                    selected === id ? "border-[#2a78d6] bg-[#2a78d6]/10 dark:border-[#3987e5]" : "border-transparent hover:bg-zinc-100 dark:hover:bg-zinc-800/60"
                  }`}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span>{hourLabel(r.targetTs)}</span>
                    <span className="text-zinc-400">{r.source.replace("manual", "me").replace("auto", "hourly")}</span>
                  </div>
                  <div className="flex flex-wrap gap-x-2">
                    <span className={up ? "text-emerald-700 dark:text-emerald-500" : "text-rose-600"}>
                      {up ? "▲" : "▼"} {signedPct(pct)}
                    </span>
                    {ok === null ? (
                      <span className="text-zinc-500">⏳ pending</span>
                    ) : (
                      <span className={ok ? "text-emerald-700 dark:text-emerald-500" : "text-rose-600"}>{ok ? "✓ right" : "✗ wrong"}</span>
                    )}
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
