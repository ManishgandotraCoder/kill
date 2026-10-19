import type { PatternStats } from "@/lib/predict";
import type { Direction, PatternGroup } from "@/lib/patterns";

export const GROUP_LABEL: Record<PatternGroup, string> = {
  bullish: "Bullish",
  bearish: "Bearish",
  continuation: "Continuation",
  indecision: "Indecision / momentum",
};

export function Textbook({ dir }: { dir: Direction }) {
  if (dir === "neutral") return <span className="text-muted">↔ indecision</span>;
  return <span className={dir === "up" ? "text-up" : "text-down"}>{dir === "up" ? "▲ up" : "▼ down"}</span>;
}

/** What 5 years of history says, compared with the textbook. */
export function Verdict({ textbook, stats }: { textbook: Direction; stats: PatternStats }) {
  const base = "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap";
  if (stats.verdict === "rare") return <span className={`${base} bg-panel-2 text-muted`}>too rare to judge</span>;
  if (stats.verdict === "none") return <span className={`${base} bg-panel-2 text-muted`}>no real edge</span>;
  const up = stats.verdict === "up";
  const tone = up ? "bg-up/10 text-up" : "bg-down/10 text-down";
  const arrow = up ? "▲" : "▼";
  if (textbook === "neutral") return <span className={`${base} ${tone}`}>{arrow} leans {up ? "up" : "down"}</span>;
  return textbook === stats.verdict ? (
    <span className={`${base} ${tone}`}>✓ works as textbook {arrow}</span>
  ) : (
    <span className={`${base} ${tone}`}>⇄ opposite of textbook {arrow}</span>
  );
}

/** Next-hour up-rate on a 40–60% scale, with the any-hour baseline marked. */
export function UpRateBar({ upPct, baselinePct }: { upPct: number; baselinePct: number }) {
  const lo = 40, hi = 60;
  const x = (v: number) => `${((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * 100}%`;
  const above = upPct >= baselinePct;
  return (
    <div className="relative h-4 w-full min-w-24" aria-hidden>
      <div className="absolute inset-x-0 top-1.5 h-1 rounded-full bg-panel-2" />
      <div
        className={`absolute top-1.5 h-1 rounded-full ${above ? "bg-up/60" : "bg-down/60"}`}
        style={above ? { left: x(baselinePct), width: `calc(${x(upPct)} - ${x(baselinePct)})` } : { left: x(upPct), width: `calc(${x(baselinePct)} - ${x(upPct)})` }}
      />
      <div className="absolute top-0 h-4 w-px bg-foreground/40" style={{ left: x(baselinePct) }} />
      <div className={`absolute top-0.5 h-3 w-3 -translate-x-1/2 rounded-full ring-2 ring-panel ${above ? "bg-up" : "bg-down"}`} style={{ left: x(upPct) }} />
    </div>
  );
}
