"use client";

import { useEffect, useState } from "react";
import { detectRange, PATTERN_INFO, type PatternGroup, type PatternKey } from "@/lib/pattern-detect";
import { EXAMPLE_PREROLL, exampleCandles, PATTERN_EXAMPLES } from "@/lib/pattern-examples";
import type { GuideEntry, Outcome } from "@/lib/pattern-guide";
import { PatternDetail } from "../pattern-panel";

// Pattern guide: a learning page for every chart pattern the detector stores - a drawn example (the
// detector's own swing points and lines on a textbook price path), the exact rule, how often it
// occurred, and what BTC actually did afterwards.

const SYMBOL = "BTCUSDT";
const GROUPS: { key: PatternGroup | "all"; label: string; blurb?: string }[] = [
  { key: "all", label: "All" },
  { key: "reversal", label: "Reversal", blurb: "The trend may turn: tops and bottoms, head and shoulders, wedges." },
  { key: "continuation", label: "Continuation", blurb: "The trend may carry on: flags, pennants, ascending and descending triangles." },
  { key: "bilateral", label: "Bilateral", blurb: "Could break either way - the breakout side decides the direction." },
];

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const dirClass = (d: string) => (d === "bullish" ? "text-up" : d === "bearish" ? "text-down" : "text-muted");
const dirLabel = (d: string) => (d === "bullish" ? "▲ Bullish" : d === "bearish" ? "▼ Bearish" : "● Neutral");

const VERDICT: Record<Outcome["verdict"], { text: string; cls: string }> = {
  "as-textbook": { text: "as textbook", cls: "bg-up/10 text-up" },
  opposite: { text: "opposite", cls: "bg-down/10 text-down" },
  "leans-up": { text: "leans up", cls: "bg-panel-2 text-foreground" },
  "leans-down": { text: "leans down", cls: "bg-panel-2 text-foreground" },
  "no-clear-effect": { text: "no clear effect", cls: "bg-panel-2 text-muted" },
};

export default function PatternGuide() {
  const [group, setGroup] = useState<PatternGroup | "all">("all");
  const [state, setState] = useState<{ data?: GuideEntry[]; error?: string } | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    fetch(`/api/patterns/guide?symbol=${SYMBOL}`, { signal: ctrl.signal, cache: "no-store" })
      .then(async (r) => (r.ok ? r.json() : Promise.reject(new Error((await r.text()) || `HTTP ${r.status}`))))
      .then((b: { patterns: GuideEntry[] }) => setState({ data: b.patterns }))
      .catch((e: Error) => e.name !== "AbortError" && setState({ error: e.message }));
    return () => ctrl.abort();
  }, []);

  const byKey = new Map(state?.data?.map((e) => [e.key, e]));
  const keys = (Object.keys(PATTERN_INFO) as PatternKey[]).filter((k) => group === "all" || PATTERN_INFO[k].group === group);

  return (
    <div className="mx-auto w-full max-w-[1680px] px-4 py-5 text-sm">
      <section className="card mb-5 p-5">
        <h1 className="text-xl font-semibold tracking-tight">Chart pattern guide</h1>
        <p className="mt-2 max-w-3xl text-muted">
          Every chart pattern the detector looks for in {SYMBOL}&apos;s 5 years of 1-hour candles. Each card shows what the pattern looks like,
          the exact rule used to detect it, how often it happened, and what the price actually did after the breakout compared with after{" "}
          <i>any</i> candle. &ldquo;Bullish&rdquo; or &ldquo;bearish&rdquo; is the textbook meaning, not a guarantee.
        </p>
        <ul className="mt-3 grid gap-x-6 gap-y-1 text-xs text-muted sm:grid-cols-2 lg:grid-cols-4">
          <li><b className="font-medium text-foreground">Swing points</b> = turning points, confirmed once price reverses 2 ATR.</li>
          <li><b className="font-medium text-foreground">ATR</b> = average candle range over the last 14 hours; all sizes are measured in it.</li>
          <li><b className="font-medium text-foreground">Breakout</b> = the first close beyond the neckline / trendline. Patterns are only counted once they break out.</li>
          <li><b className="font-medium text-foreground">Higher after</b> = share of times price was higher at the end of the window. 1 bp = 0.01%; fees ≈ 20 bp.</li>
        </ul>
        <div className="mt-4 flex flex-wrap gap-1.5" role="group" aria-label="Pattern group">
          {GROUPS.map((g) => (
            <button
              key={g.key}
              onClick={() => setGroup(g.key)}
              aria-pressed={group === g.key}
              title={g.blurb}
              className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${group === g.key ? "bg-accent/15 text-accent ring-1 ring-accent/30" : "bg-panel-2 text-muted hover:text-foreground"}`}
            >
              {g.label}
            </button>
          ))}
        </div>
        {group !== "all" && <p className="mt-2 text-xs text-muted">{GROUPS.find((g) => g.key === group)?.blurb}</p>}
      </section>

      {state?.error && <p className="card mb-5 p-4 text-xs text-down">Couldn&apos;t load pattern statistics: {state.error}</p>}

      <div className="grid gap-5 lg:grid-cols-2">
        {keys.map((k) => (
          <PatternCard key={k} k={k} entry={byKey.get(k)} loading={!state} />
        ))}
      </div>
    </div>
  );
}

function PatternCard({ k, entry, loading }: { k: PatternKey; entry?: GuideEntry; loading: boolean }) {
  const info = PATTERN_INFO[k];
  const [example, setExample] = useState<number | null>(null);
  const ex = PATTERN_EXAMPLES[k];

  return (
    <article className="card flex min-w-0 flex-col p-4" id={k}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-base font-semibold">{info.name}</h2>
        <span className={`text-xs font-medium ${dirClass(info.direction)}`}>{dirLabel(info.direction)}</span>
        <span className="text-xs text-muted">
          {info.group[0].toUpperCase() + info.group.slice(1)} · chart code <code className="font-mono">{info.code}</code>
        </span>
      </div>

      <div className="mt-3 flex flex-col gap-4 sm:flex-row">
        <figure className="w-fit shrink-0">
          <Sketch k={k} path={ex} />
          <figcaption className="mt-1 text-[11px] text-muted">dots = swing points · dashed = pattern lines · arrow = breakout</figcaption>
        </figure>
        <div className="min-w-0 flex-1">
          <div className="eyebrow mb-1">How it&apos;s detected</div>
          <p className="text-xs leading-relaxed">{info.definition}</p>
          <p className="mt-2 text-xs text-muted">
            Found{" "}
            {loading ? "…" : <b className="font-medium text-foreground">{(entry?.counts["1h"] ?? 0).toLocaleString()}</b>} times in 5 years of 1h candles.
          </p>
        </div>
      </div>

      <div className="mt-4">
        <div className="eyebrow mb-1">What BTC did after the breakout</div>
        {loading ? (
          <p className="text-xs text-muted">Loading…</p>
        ) : !entry?.outcomes.length ? (
          <p className="text-xs text-muted">No statistics yet - train the models (npm run train).</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-muted">
                <tr className="border-b border-line">
                  <th className="py-1.5 pr-3 font-medium">Window</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Higher after</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Any candle</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Avg move</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Times</th>
                  <th className="py-1.5 font-medium">Verdict</th>
                </tr>
              </thead>
              <tbody>
                {entry.outcomes.map((o) => (
                  <tr key={o.label} className="border-b border-line/60">
                    <td className="py-1.5 pr-3">
                      {o.label} <span className="text-muted">({o.interval})</span>
                    </td>
                    <td className="py-1.5 pr-3 text-right font-mono">{pct(o.upRate)}</td>
                    <td className="py-1.5 pr-3 text-right font-mono text-muted">{pct(o.baseUpRate)}</td>
                    <td className={`py-1.5 pr-3 text-right font-mono ${o.avgBp > 0 ? "text-up" : o.avgBp < 0 ? "text-down" : ""}`}>
                      {o.avgBp > 0 ? "+" : ""}
                      {o.avgBp.toFixed(1)} bp
                    </td>
                    <td className="py-1.5 pr-3 text-right font-mono text-muted">{o.n.toLocaleString()}</td>
                    <td className="py-1.5">
                      <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${VERDICT[o.verdict].cls}`}>{VERDICT[o.verdict].text}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
        {(["1h"] as const).map((iv) =>
          entry?.latest[iv] ? (
            <button
              key={iv}
              onClick={() => setExample(example === entry.latest[iv] ? null : entry.latest[iv])}
              aria-pressed={example === entry.latest[iv]}
              className={`rounded-md px-2.5 py-1 transition-colors ${example === entry.latest[iv] ? "bg-accent/15 text-accent ring-1 ring-accent/30" : "bg-panel-2 text-muted hover:text-foreground"}`}
            >
              Latest real example ({iv})
            </button>
          ) : null,
        )}
      </div>
      {example !== null && (
        <div className="mt-3">
          <PatternDetail id={example} onClose={() => setExample(null)} />
        </div>
      )}
    </article>
  );
}

/**
 * SVG drawing of the textbook example: the price path (closes), the swing points and lines the
 * detector itself found on it, and an arrow at the breakout - the same rules as on real data.
 */
function Sketch({ k, path }: { k: PatternKey; path: [number, number][] }) {
  const c = exampleCandles(path);
  const d = detectRange(c, 3_600_000).detections.find((x) => x.pattern === k);
  const from = EXAMPLE_PREROLL - 4;
  const shown = c.slice(from);
  const hi = Math.max(...shown.map((x) => x.h)), lo = Math.min(...shown.map((x) => x.l));
  const W = 220, H = 120, PAD = 10;
  const x = (ts: number) => PAD + ((ts - shown[0].ts) / (shown[shown.length - 1].ts - shown[0].ts)) * (W - 2 * PAD);
  const y = (p: number) => PAD + ((hi - p) / (hi - lo || 1)) * (H - 2 * PAD);
  const color = d?.direction === "bullish" ? "text-up" : d?.direction === "bearish" ? "text-down" : "text-muted";
  const brk = d && c.find((q) => q.ts === d.ts);
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="rounded-lg border border-line bg-panel-2" role="img" aria-label={`${PATTERN_INFO[k].name} example`}>
      <polyline points={shown.map((q) => `${x(q.ts)},${y(q.c)}`).join(" ")} fill="none" stroke="currentColor" strokeWidth={1.5} className="text-foreground/70" />
      {d && (
        <g className={color}>
          {d.meta.lines.map((l, i) => (
            <line key={i} x1={x(l.a.ts)} y1={y(l.a.p)} x2={x(l.b.ts)} y2={y(l.b.p)} stroke="currentColor" strokeWidth={1.5} strokeDasharray="4 3" />
          ))}
          {d.meta.points.map((p, i) => (
            <circle key={i} cx={x(p.ts)} cy={y(p.p)} r={2.5} fill="currentColor" />
          ))}
          {brk && (
            <text x={x(brk.ts)} y={d.direction === "bullish" ? y(brk.h) - 4 : y(brk.l) + 12} textAnchor="middle" fontSize={12} fill="currentColor">
              {d.direction === "bullish" ? "▲" : "▼"}
            </text>
          )}
        </g>
      )}
    </svg>
  );
}
