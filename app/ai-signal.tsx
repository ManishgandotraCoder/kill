"use client";

import { useState } from "react";
import type { SignalState } from "./use-signal";

// AI signal card: the model's probability that price is higher after the horizon, what drove it,
// its out-of-sample and live record, and an on-demand explanation by a local LLM (Ollama).
// The signal itself comes from useSignal (shared with the chart's forecast line).

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const fmtDay = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: "short", year: "numeric" });

export default function AiSignal({ symbol, signal }: { symbol: string; signal: SignalState }) {
  const [explain, setExplain] = useState<{ key: string; text?: string; model?: string; error?: string; loading?: boolean } | null>(null);
  const { data: d, error, loading, models: tabs, choice, setChoice, query } = signal;
  const s = loading ? null : { error };
  const explainKey = d ? `${query}:${d.at}` : "";
  const ex = explain?.key === explainKey ? explain : null;

  const askAi = () => {
    if (!d) return;
    const key = explainKey;
    setExplain({ key, loading: true });
    fetch(`/api/signal/explain?${query}`, { method: "POST" })
      .then(async (r) => (r.ok ? r.json() : Promise.reject(new Error((await r.text()) || `HTTP ${r.status}`))))
      .then((b: { text: string; model: string }) => setExplain({ key, text: b.text, model: b.model }))
      .catch((e: Error) => setExplain({ key, error: e.message }));
  };

  return (
    <section className="card mb-5 p-4">
      <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-base font-semibold">AI signal</h2>
        <span className="text-xs text-muted">
          {symbol}
          {d && ` · next ${d.horizonLabel} · ${d.interval} candles · after the ${new Date(d.at).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false })} candle closed`}
        </span>
        {tabs.length > 0 && (
          <div className="ml-auto flex gap-0.5 rounded-lg bg-panel-2 p-0.5" role="group" aria-label="Look-ahead">
            {tabs.map((m) => {
              const on = m.interval === choice.interval && m.horizon === choice.horizon;
              return (
                <button
                  key={`${m.interval}:${m.horizon}`}
                  onClick={() => setChoice({ interval: m.interval, horizon: m.horizon })}
                  aria-pressed={on}
                  title={`Model on ${m.interval} candles · out-of-sample accuracy ${pct(m.accuracy)}`}
                  className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${on ? "bg-panel text-foreground shadow-sm" : "text-muted hover:text-foreground"}`}
                >
                  {m.label}
                  {tabs.filter((x) => x.label === m.label).length > 1 && <span className="opacity-60"> ({m.interval})</span>}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {!s && <p className="text-xs text-muted">Loading…</p>}
      {s?.error && <p className="rounded-lg bg-panel-2 p-3 text-xs text-muted">{s.error}</p>}

      {d && (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div>
            <div className="flex flex-wrap items-baseline gap-3">
              <span className="font-mono text-3xl font-semibold">{pct(d.pUp)}</span>
              <span className="text-sm text-muted">chance price is higher</span>
              <span
                className={`rounded-md px-2 py-0.5 text-xs font-medium ${
                  d.lean === "up" ? "bg-up/10 text-up" : d.lean === "down" ? "bg-down/10 text-down" : "bg-panel-2 text-muted"
                }`}
              >
                {d.lean === "up" ? "▲ Leans up" : d.lean === "down" ? "▼ Leans down" : "No clear lean"}
              </span>
            </div>
            {/* probability bar: centre = 50% */}
            <div className="relative mt-3 h-2 rounded-full bg-panel-2" aria-hidden>
              <div className="absolute top-0 left-1/2 h-2 w-px bg-line" />
              <div
                className={`absolute top-0 h-2 rounded-full ${d.pUp >= 0.5 ? "bg-up" : "bg-down"}`}
                style={{ left: `${Math.min(50, d.pUp * 100)}%`, width: `${Math.abs(d.pUp - 0.5) * 100}%` }}
              />
            </div>

            <p className="mt-3 text-xs leading-relaxed text-muted">
              Tested {d.model.evaluation === "walk-forward" ? "walk-forward " : ""}on {d.model.test.n.toLocaleString()} unseen candles ({fmtDay(d.model.test.from)} – {fmtDay(d.model.test.to)}): right{" "}
              <b className="font-medium text-foreground">{pct(d.model.test.accuracy)}</b>
              {d.model.test.accuracySe ? ` ±${(200 * d.model.test.accuracySe).toFixed(1)}` : ""} of the time (price rose in {pct(d.model.test.upRate)} of windows).
              {d.model.atLean && (
                <>
                  {" "}On {d.model.atLean.trades.toLocaleString()} separate trades when it leaned, it was right{" "}
                  <b className="font-medium text-foreground">{pct(d.model.atLean.hitRate)}</b> ±{(200 * d.model.atLean.hitRateSe).toFixed(1)}, average move{" "}
                  <b className="font-medium text-foreground">{d.model.atLean.grossBp.toFixed(1)} bp</b> vs {d.model.feeBpRoundTrip} bp round-trip fees
                  {d.model.atLean.netBp > 0 ? " — ahead of fees in this test." : " — not enough to beat fees."} Not financial advice.
                </>
              )}
            </p>

            <p className="mt-2 text-xs leading-relaxed text-muted">
              <span className="font-medium text-foreground">Live record</span>
              {d.live.checked > 0 ? (
                <>
                  {" "}since {new Date(d.live.since!).toLocaleDateString(undefined, { day: "numeric", month: "short" })}: right{" "}
                  <b className="font-medium text-foreground">{pct(d.live.accuracy!)}</b> of {d.live.checked.toLocaleString()} checked signals
                  {d.live.leaned > 0 && d.live.leanHitRate !== null && d.live.leanAvgBp !== null && (
                    <>
                      ; when leaning {pct(d.live.leanHitRate)} of {d.live.leaned.toLocaleString()}, avg move {d.live.leanAvgBp.toFixed(1)} bp
                    </>
                  )}
                  {d.live.checked < 100 && " - too few to judge yet"}
                  {d.live.pending > 0 && ` · ${d.live.pending} waiting`}.
                </>
              ) : (
                <> - tracking started; each signal is scored {d.horizonLabel} after it is made{d.live.pending > 0 && ` (${d.live.pending} waiting)`}.</>
              )}
            </p>

            {d.patterns.length > 0 && (
              <div className="mt-3 text-xs">
                <div className="eyebrow mb-1">Patterns on this candle</div>
                {d.patterns.map((p) => (
                  <div key={p.pattern}>
                    <span className={p.direction === "bullish" ? "text-up" : p.direction === "bearish" ? "text-down" : "text-muted"}>{p.name}</span>
                    <span className="text-muted"> · historically higher {d.horizonLabel} later {pct(p.historicalUpRate)} of {p.n.toLocaleString()} times</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div>
            <div className="eyebrow mb-1.5">What drove it</div>
            <ul className="space-y-1 text-xs">
              {d.drivers.map((x) => (
                <li key={x.key} className="flex items-center gap-2">
                  <span className={`w-4 text-center ${x.contribution > 0 ? "text-up" : "text-down"}`}>{x.contribution > 0 ? "▲" : "▼"}</span>
                  <span className="min-w-0 flex-1 truncate" title={x.label}>
                    {x.label}
                  </span>
                  <span className="font-mono text-muted">{x.value.toFixed(2)}</span>
                </li>
              ))}
            </ul>

            <div className="mt-4">
              <button
                onClick={askAi}
                disabled={ex?.loading}
                className="rounded-lg bg-accent/15 text-accent ring-1 ring-accent/40 hover:bg-accent/25 px-3 py-1.5 text-xs font-medium disabled:opacity-50"
              >
                {ex?.loading ? "Local AI is reading the chart…" : ex?.text ? "Explained ✓" : "Explain with AI"}
              </button>
              {ex?.error && <p className="mt-2 text-xs text-down">{ex.error}</p>}
              {ex?.text && <Markdownish text={ex.text} />}
              {ex?.model && <p className="mt-1 text-[11px] text-muted">Written by {ex.model} running locally in Ollama. Small models can misread numbers - the figures on the left are the source of truth.</p>}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

/** Minimal rendering of the LLM's bullet list (- items, **bold**). */
function Markdownish({ text }: { text: string }) {
  const bold = (line: string) =>
    line.split(/(\*\*[^*]+\*\*)/).map((part, i) => (part.startsWith("**") ? <b key={i} className="font-medium">{part.slice(2, -2)}</b> : part));
  const lines = text.split("\n").filter((l) => l.trim());
  return (
    <div className="mt-3 rounded-lg bg-panel-2 p-3 text-xs leading-relaxed">
      <ul className="list-disc space-y-1 pl-4">
        {lines.map((l, i) =>
          /^\s*[-*+•]\s/.test(l) ? <li key={i} className={/^\s/.test(l) ? "ml-4" : ""}>{bold(l.replace(/^\s*[-*+•]\s/, ""))}</li> : <p key={i} className="-ml-4">{bold(l)}</p>,
        )}
      </ul>
    </div>
  );
}
