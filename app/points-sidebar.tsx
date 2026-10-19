"use client";

import { useState } from "react";
import type { Explanation } from "@/lib/predict";
import {
  clearPoints,
  HOUR_MS,
  hm,
  hourLabel,
  type Point,
  removePoint,
  type Run,
  type RunPrediction,
  signedPct,
  useExplanation,
  useExplanationList,
} from "./points";

interface Props {
  symbol: string;
  runs: Run[] | null;
  onRunsChanged: () => void;
  points: Point[];
  selected: string; // "now", a point id, or "run:<id>:<hourTs>"
  onSelect: (id: string) => void;
  pickMode: boolean;
  onTogglePick: () => void;
  version: string;
  notice: string | null;
  onClose: () => void;
}

const UP = "text-up";
const DOWN = "text-down";

/** Left sidebar: prediction runs (start → end), the live forecast, and picked points. */
export default function PointsSidebar(props: Props) {
  const { symbol, runs, selected, onSelect, version } = props;
  const now = useExplanation(symbol, null, version);

  return (
    <div className="text-xs">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium">Prediction runs</h2>
        <CloseButton onClick={props.onClose} label="Close left sidebar" />
      </div>

      <RunForm symbol={symbol} onCreated={(r) => {
        props.onRunsChanged();
        if (r.predictions.length) onSelect(`run:${r.id}:${r.predictions[r.predictions.length - 1].targetTs}`);
      }} />

      <ul className="mt-4 space-y-1">
        <NowItem result={now} selected={selected === "now"} onSelect={() => onSelect("now")} />
      </ul>

      <div className="mt-4 space-y-2">
        {runs === null && <p className="text-muted">Loading runs…</p>}
        {runs?.length === 0 && <p className="text-muted">No runs yet. Pick a start and end time above.</p>}
        {runs?.map((r) => (
          <RunCard key={r.id} run={r} selected={selected} onSelect={onSelect} onDeleted={props.onRunsChanged} />
        ))}
      </div>

      <PickedPoints {...props} />
    </div>
  );
}

export function CloseButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button onClick={onClick} aria-label={label} title={label} className="grid h-6 w-6 place-items-center rounded-md text-muted hover:bg-panel-2 hover:text-foreground">
      ✕
    </button>
  );
}

// ---- create a run -------------------------------------------------------------

/** "YYYY-MM-DDTHH:mm" in local time, for <input type="datetime-local">. */
function toInput(ms: number): string {
  const d = new Date(ms);
  return new Date(ms - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

/** "19 Oct 17:30" in local time. */
function when(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
}

const MINUTE_MS = 60_000;
/** "Next …" presets, in minutes. Under an hour = short run from now; otherwise whole candles from the next one. */
const PRESETS = [5, 15, 30, 60, 120, 180, 240, 360, 1440];
const presetLabel = (m: number) => (m < 60 ? `${m}m` : `${m / 60}h`);

/** Window for a preset (called from click handlers only). */
function presetRange(minutes: number): [number, number] {
  const now = Date.now();
  if (minutes < 60) {
    const start = Math.floor(now / MINUTE_MS) * MINUTE_MS;
    return [start, start + minutes * MINUTE_MS];
  }
  const nextOpen = Math.ceil(now / HOUR_MS) * HOUR_MS;
  return [nextOpen, nextOpen + minutes * MINUTE_MS];
}

/** Short runs (under an hour) predict one price; longer ones predict every 1h candle. */
const isShort = (startMs: number, endMs: number) => endMs - startMs < HOUR_MS;
const span = (minutes: number) => (minutes < 60 ? `${minutes}m` : `${Math.round(minutes / 60)}h`);

function RunForm({ symbol, onCreated }: { symbol: string; onCreated: (r: Run) => void }) {
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const startMs = start ? new Date(start).getTime() : NaN;
  const endMs = end ? new Date(end).getTime() : NaN;
  const short = isShort(startMs, endMs);
  // Same snapping as the server: short runs to the minute, others to whole 1-hour candles.
  const firstOpen = Math.ceil(startMs / HOUR_MS) * HOUR_MS;
  const lastClose = Math.floor(endMs / HOUR_MS) * HOUR_MS;
  const hours = Number.isFinite(firstOpen) && Number.isFinite(lastClose) ? (lastClose - firstOpen) / HOUR_MS : NaN;
  const shortMinutes = Math.floor((endMs - startMs) / MINUTE_MS);
  const valid = short ? shortMinutes >= 1 : hours > 0;

  const preset = (minutes: number) => {
    const [a, b] = presetRange(minutes);
    setStart(toInput(a));
    setEnd(toInput(b));
    setError(null);
  };

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol, start: startMs, end: endMs }),
      });
      if (!res.ok) throw new Error(await res.text());
      onCreated(await res.json());
      setStart("");
      setEnd("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-line p-3">
      <label className="mb-2 block">
        <span className="mb-1 block text-muted">Start</span>
        <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} className="w-full rounded-md border border-line bg-panel px-2 py-1" />
      </label>
      <label className="mb-2 block">
        <span className="mb-1 block text-muted">End</span>
        <input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} className="w-full rounded-md border border-line bg-panel px-2 py-1" />
      </label>
      <div className="mb-2 flex flex-wrap items-center gap-1">
        <span className="mr-0.5 text-muted">Next</span>
        {PRESETS.map((m) => (
          <button key={m} onClick={() => preset(m)} className="rounded-md bg-panel-2 px-2 py-0.5 text-muted hover:text-foreground">
            {presetLabel(m)}
          </button>
        ))}
      </div>
      <p className="mb-2 text-muted">
        {short && shortMinutes >= 1
          ? `Predicts the price at ${when(endMs)} from the price at ${when(startMs)} (${shortMinutes} min), scaled from this hour's forecast.`
          : hours > 0
          ? `Predicts ${hours} candle${hours > 1 ? "s" : ""}: ${when(firstOpen)} → ${when(lastClose)}. Model frozen at the start.`
          : start && end
            ? "The window must contain at least one full 1-hour candle."
            : "Every 1-hour candle between start and end gets a prediction. Past windows fill in now; future ones fill in hour by hour."}
      </p>
      {error && <p className="mb-2 text-down">{error}</p>}
      <button
        onClick={create}
        disabled={busy || !valid}
        className="w-full rounded-md bg-foreground px-3 py-1.5 font-medium text-background hover:opacity-85 disabled:opacity-40"
      >
        {busy ? "Creating…" : "Start run"}
      </button>
    </div>
  );
}

// ---- runs ---------------------------------------------------------------------

const isRight = (p: RunPrediction) => p.actual != null && Math.sign(p.predicted - p.base) === Math.sign(p.actual - p.base);

function RunCard({ run, selected, onSelect, onDeleted }: { run: Run; selected: string; onSelect: (id: string) => void; onDeleted: () => void }) {
  const active = selected.startsWith(`run:${run.id}:`);
  const [open, setOpen] = useState(active);
  const done = run.predictions.filter((p) => p.actual != null);
  const right = done.filter(isRight).length;
  const chip =
    run.status === "running" ? "bg-up/10 text-up" : run.status === "scheduled" ? "bg-accent/10 text-accent" : "bg-panel-2 text-muted";

  const remove = async () => {
    if (!confirm(`Delete run #${run.id} and its ${run.predictions.length} predictions?`)) return;
    await fetch(`/api/runs?id=${run.id}`, { method: "DELETE" });
    if (active) onSelect("now");
    onDeleted();
  };

  return (
    <div className={`rounded-lg border ${active ? "border-accent" : "border-line"}`}>
      <div className="flex items-start gap-2 p-2">
        <button onClick={() => setOpen(!open)} className="min-w-0 flex-1 text-left" aria-expanded={open}>
          <div className="flex items-center gap-2">
            <span className="text-muted">{open ? "▾" : "▸"}</span>
            <span className="font-medium">Run #{run.id}</span>
            <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${chip}`}>{run.status}</span>
          </div>
          <div className="mt-0.5 pl-4 text-muted">
            {when(run.startTs)} → {when(run.endTs)} · {span(Math.round((run.endTs - run.startTs) / MINUTE_MS))}
          </div>
          <div className="pl-4">
            {done.length > 0 && (
              <>
                <span className={UP}>✓{right}</span> <span className={DOWN}>✗{done.length - right}</span>{" "}
              </>
            )}
            <span className="text-muted">
              {run.predictions.length}/{Math.max(1, Math.floor(run.hours))} predicted
            </span>
          </div>
        </button>
        <button onClick={remove} aria-label={`Delete run ${run.id}`} title="Delete run" className="px-1 text-zinc-400 hover:text-rose-600">
          ×
        </button>
      </div>
      {open && (
        <ul className="max-h-72 space-y-0.5 overflow-y-auto border-t border-line p-1">
          {run.predictions.length === 0 && <li className="p-2 text-muted">Starts {new Date(run.startTs).toLocaleString()}.</li>}
          {[...run.predictions].reverse().map((p) => {
            const id = `run:${run.id}:${p.targetTs}`;
            const pct = (p.predicted / p.base - 1) * 100;
            return (
              <li key={p.targetTs}>
                <button
                  onClick={() => onSelect(id)}
                  className={`flex w-full items-center justify-between gap-2 rounded-md px-2 py-1 text-left ${selected === id ? "bg-accent/10" : "hover:bg-panel-2"}`}
                >
                  <span>{p.minutes < 60 ? `${when(p.targetTs)}–${hm(p.targetTs + p.minutes * MINUTE_MS)}` : hourLabel(p.targetTs)}</span>
                  <span className="flex gap-2">
                    <span className={pct >= 0 ? UP : DOWN}>{pct >= 0 ? "▲" : "▼"} {signedPct(pct)}</span>
                    {p.actual == null ? <span className="text-muted">⏳</span> : isRight(p) ? <span className={UP}>✓</span> : <span className={DOWN}>✗</span>}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ---- now + picked points ---------------------------------------------------------

function NowItem({ result, selected, onSelect }: { result: { data: Explanation | null; error: string | null }; selected: boolean; onSelect: () => void }) {
  const d = result.data;
  const up = d ? d.expectedPct >= 0 : null;
  return (
    <li>
      <button
        onClick={onSelect}
        className={`w-full rounded-lg border px-2 py-1.5 text-left ${selected ? "border-accent bg-accent/10" : "border-line hover:bg-panel-2"}`}
      >
        <div className="flex items-baseline gap-2">
          <span className="font-semibold">Now</span>
          <span className="text-muted">{d ? hourLabel(d.targetTs) : "current hour"}</span>
        </div>
        {result.error && <div className="text-down">{result.error}</div>}
        {d && (
          <div>
            live forecast{" "}
            <span className={up ? UP : DOWN}>
              {up ? "▲" : "▼"} {signedPct(d.expectedPct)}
            </span>
          </div>
        )}
      </button>
    </li>
  );
}

function PickedPoints({ symbol, points, selected, onSelect, pickMode, onTogglePick, version, notice }: Props) {
  const results = useExplanationList(
    symbol,
    points.map((p) => p.hourTs),
    version,
  );
  return (
    <details className="mt-5 border-t border-line pt-3" open={pickMode || points.length > 0}>
      <summary className="mb-2 flex cursor-pointer list-none items-center justify-between">
        <span className="text-muted">▸ Picked points ({points.length})</span>
        <button
          onClick={(e) => {
            e.preventDefault();
            onTogglePick();
          }}
          aria-pressed={pickMode}
          className={`rounded-md px-2 py-0.5 ${pickMode ? "bg-point text-white" : "bg-panel-2 text-muted hover:text-foreground"}`}
        >
          {pickMode ? "Done" : "+ Pick"}
        </button>
      </summary>
      {pickMode && <p className="mb-2 text-muted">Click candles on the chart. Each point predicts the 1-hour candle it falls in.</p>}
      {notice && <p className="mb-2 text-down">{notice}</p>}
      <ul className="space-y-1">
        {points.map((p, i) => {
          const d = results.get(p.hourTs)?.data;
          const err = results.get(p.hourTs)?.error;
          const up = d ? d.expectedPct >= 0 : null;
          return (
            <li key={p.id} className={`flex items-start gap-2 rounded-md px-2 py-1 ${selected === p.id ? "bg-accent/10" : "hover:bg-panel-2"}`}>
              <button onClick={() => onSelect(p.id)} className="min-w-0 flex-1 text-left">
                <span className="text-point">P{i + 1}</span> <span className="text-muted">{hourLabel(p.hourTs)}</span>
                {err && <div className="text-down">{err}</div>}
                {d && (
                  <div>
                    <span className={up ? UP : DOWN}>{up ? "▲" : "▼"} {signedPct(d.expectedPct)}</span>{" "}
                    {d.actual ? (d.actual.directionRight ? <span className={UP}>✓</span> : <span className={DOWN}>✗</span>) : <span className="text-muted">⏳</span>}
                  </div>
                )}
              </button>
              <button onClick={() => removePoint(p.id)} aria-label={`Remove P${i + 1}`} className="px-1 text-zinc-400 hover:text-rose-600">
                ×
              </button>
            </li>
          );
        })}
      </ul>
      {points.length > 0 && (
        <button onClick={() => clearPoints(symbol)} className="mt-2 text-muted underline hover:text-foreground">
          Clear points
        </button>
      )}
    </details>
  );
}
