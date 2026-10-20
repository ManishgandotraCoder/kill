"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { Prediction } from "@/lib/predictions";
import type { PredictionsState } from "./use-predictions";

// Right sidebar: running predictions (countdown, live price vs. the call, cancel) and the saved history.

const fmt = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const bp = (from: number, to: number) => ((to / from - 1) * 1e4).toFixed(1);
const clock = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
const windowLabel = (m: number) => (m >= 60 ? `${m / 60} h` : `${m} min`);

function left(ms: number) {
  if (ms <= 0) return "checking…";
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} left`;
}

export default function PredictionsSidebar({ symbol, predictions, livePrice, loggedIn, onClose }: {
  symbol: string;
  predictions: PredictionsState;
  livePrice: number | null;
  loggedIn: boolean;
  onClose: () => void;
}) {
  const { running, history, stats, loading, error } = predictions;
  // Ticking clock for countdowns (set from a timer callback, never during render).
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const first = window.setTimeout(tick, 0);
    const timer = window.setInterval(tick, 1000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, []);

  return (
    <aside className="card flex max-h-[calc(100vh-6rem)] flex-col overflow-hidden lg:sticky lg:top-20" aria-label="Predictions">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <h2 className="text-sm font-semibold">Predictions</h2>
        <span className="text-xs text-muted">{symbol}</span>
        <button onClick={onClose} className="ml-auto rounded-md bg-panel-2 px-2 py-0.5 text-xs text-muted hover:text-foreground" aria-label="Close predictions sidebar">
          ✕
        </button>
      </div>

      {!loggedIn ? (
        <div className="space-y-3 p-4 text-xs text-muted">
          <p>Predictions are saved to your account, with your full history and track record.</p>
          <div className="flex gap-2">
            <Link href="/login" className="rounded-lg bg-accent/15 text-accent ring-1 ring-accent/40 hover:bg-accent/25 px-3 py-1.5 font-semibold">
              Log in
            </Link>
            <Link href="/register" className="rounded-lg bg-panel-2 px-3 py-1.5 text-foreground hover:opacity-90">
              Create account
            </Link>
          </div>
        </div>
      ) : (
        <div className="flex-1 space-y-4 overflow-y-auto p-4">
          {error && <p className="text-xs text-down">{error}</p>}

          {stats && stats.completed > 0 && (
            <div className="rounded-lg bg-panel-2 p-3 text-xs">
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-lg font-semibold">{pct(stats.accuracy!)}</span>
                <span className="text-muted">
                  right · {stats.correct} of {stats.completed} finished
                </span>
              </div>
              <div className="mt-1 text-muted">
                avg move in the called direction {stats.avgBp! >= 0 ? "+" : ""}
                {stats.avgBp!.toFixed(1)} bp
                {stats.byMinutes.some((b) => b.completed) &&
                  " · " + stats.byMinutes.filter((b) => b.completed).map((b) => `${windowLabel(b.minutes)} ${pct(b.accuracy!)} (${b.completed})`).join(", ")}
              </div>
            </div>
          )}

          <section>
            <div className="eyebrow mb-2">Running {running.length > 0 && `(${running.length})`}</div>
            {loading && <p className="text-xs text-muted">Loading…</p>}
            {!loading && !running.length && <p className="text-xs text-muted">No prediction running. Use ▶ Start Predicting above.</p>}
            <div className="space-y-2">
              {running.map((p) => (
                <RunningCard key={p.id} p={p} now={now} livePrice={livePrice} onCancel={() => predictions.cancel(p.id)} />
              ))}
            </div>
          </section>

          <section>
            <div className="eyebrow mb-2">History {history.length > 0 && `(${history.length})`}</div>
            {!loading && !history.length && <p className="text-xs text-muted">Finished and cancelled predictions are saved here.</p>}
            <ul className="space-y-1.5">
              {history.map((p) => (
                <HistoryRow key={p.id} p={p} />
              ))}
            </ul>
          </section>
        </div>
      )}
    </aside>
  );
}

function Call({ p }: { p: Prediction }) {
  const up = p.side === "up";
  return (
    <span className={`font-medium ${up ? "text-up" : "text-down"}`}>
      {up ? "▲ Up" : "▼ Down"} {pct(up ? p.pUp : 1 - p.pUp)}
      {p.lean === "none" && <span className="font-normal text-muted"> (weak)</span>}
    </span>
  );
}

function RunningCard({ p, now, livePrice, onCancel }: { p: Prediction; now: number | null; livePrice: number | null; onCancel: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const start = p.basisTs + 60_000;
  const elapsed = now === null ? 0 : Math.min(1, Math.max(0, (now - start) / (p.endsAt - start)));
  const moved = livePrice === null ? null : livePrice - p.startPrice;
  const onTrack = moved === null || moved === 0 ? null : (moved > 0) === (p.side === "up");

  return (
    <div className="rounded-lg border border-line p-3 text-xs">
      <div className="flex items-baseline gap-2">
        <span className="font-semibold">{windowLabel(p.minutes)}</span>
        <Call p={p} />
        <span className="ml-auto font-mono text-muted">{now === null ? "" : left(p.endsAt - now)}</span>
      </div>
      <div className="mt-2 h-1.5 rounded-full bg-panel-2" aria-hidden>
        <div className="h-1.5 rounded-full bg-accent/60" style={{ width: `${elapsed * 100}%` }} />
      </div>
      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">
        <dt className="text-muted">Start ({clock(start)})</dt>
        <dd className="text-right font-mono">{fmt(p.startPrice)}</dd>
        <dt className="text-muted">Expected at {clock(p.endsAt)}</dt>
        <dd className="text-right font-mono">{fmt(p.expectedPrice)}</dd>
        <dt className="text-muted">Usual range</dt>
        <dd className="text-right font-mono text-muted">
          {fmt(p.rangeLow)} – {fmt(p.rangeHigh)}
        </dd>
        <dt className="text-muted">Now</dt>
        <dd className="text-right font-mono">
          {livePrice === null ? "—" : fmt(livePrice)}
          {moved !== null && (
            <span className={moved > 0 ? "text-up" : moved < 0 ? "text-down" : "text-muted"}>
              {" "}
              ({moved > 0 ? "+" : ""}
              {bp(p.startPrice, livePrice!)} bp)
            </span>
          )}
        </dd>
      </dl>
      <div className="mt-2 flex items-center gap-2">
        {onTrack !== null && (
          <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${onTrack ? "bg-up/10 text-up" : "bg-down/10 text-down"}`}>
            {onTrack ? "on track so far" : "against the call so far"}
          </span>
        )}
        <button
          onClick={() => {
            setBusy(true);
            setErr(null);
            onCancel()
              .catch((e: Error) => setErr(e.message))
              .finally(() => setBusy(false));
          }}
          disabled={busy}
          className="ml-auto rounded-md bg-panel-2 px-2.5 py-1 text-muted hover:text-down disabled:opacity-50"
        >
          {busy ? "Cancelling…" : "Cancel"}
        </button>
      </div>
      {err && <p className="mt-1 text-down">{err}</p>}
    </div>
  );
}

const BADGE: Record<string, { text: string; cls: string }> = {
  correct: { text: "Correct", cls: "bg-up/10 text-up" },
  wrong: { text: "Wrong", cls: "bg-down/10 text-down" },
  flat: { text: "Flat", cls: "bg-panel-2 text-muted" },
  cancelled: { text: "Cancelled", cls: "bg-panel-2 text-muted" },
  expired: { text: "No data", cls: "bg-panel-2 text-muted" },
};

function HistoryRow({ p }: { p: Prediction }) {
  const badge = BADGE[p.status === "completed" ? (p.outcome ?? "flat") : p.status];
  const end = p.status === "completed" ? p.endPrice : p.cancelPrice;
  return (
    <li className="rounded-lg border border-line/70 px-3 py-2 text-xs">
      <div className="flex items-baseline gap-2">
        <span className="text-muted">
          {new Date(p.startedAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })} {clock(p.basisTs + 60_000)}
        </span>
        <span className="font-medium">{windowLabel(p.minutes)}</span>
        <Call p={p} />
        <span className={`ml-auto rounded px-1.5 py-0.5 text-[11px] font-medium ${badge.cls}`}>{badge.text}</span>
      </div>
      <div className="mt-1 font-mono text-muted">
        {fmt(p.startPrice)} → {end === null ? "—" : fmt(end)}
        {end !== null && (
          <span className={end > p.startPrice ? "text-up" : end < p.startPrice ? "text-down" : ""}>
            {" "}
            ({end > p.startPrice ? "+" : ""}
            {bp(p.startPrice, end)} bp)
          </span>
        )}
        {p.status === "cancelled" && p.cancelledAt && <span> · cancelled {clock(p.cancelledAt)}</span>}
      </div>
    </li>
  );
}
