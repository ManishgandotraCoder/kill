"use client";

import { useState } from "react";
import type { Explanation, MiniCandle } from "@/lib/predict";
import { hm, hourLabel, price, signedPct } from "./points";

const UP = "text-emerald-700 dark:text-emerald-500";
const DOWN = "text-rose-600";
const TOP_DRIVERS = 7;

/** Right sidebar: why the model predicted what it did for the selected item. */
export default function ExplainSidebar({
  title,
  data,
  error,
}: {
  title: string;
  data: Explanation | null;
  error: string | null;
}) {
  if (error) return <Shell title={title}><p className={DOWN}>{error}</p></Shell>;
  if (!data) return <Shell title={title}><p className="text-zinc-500">Analysing 5 years of candles…</p></Shell>;

  const d = data;
  const up = d.expectedPct >= 0;

  return (
    <Shell title={`${title} · ${hourLabel(d.targetTs)}`}>
      {/* ---- summary ---- */}
      <section className="mb-5">
        <div className="mb-1 text-zinc-500">
          Predicted close of this 1-hour candle, starting from {price(d.baseClose)} (close at {hm(d.basedOnUntil)})
        </div>
        <div className="flex flex-wrap items-baseline gap-x-3">
          <span className="text-lg">{price(d.predictedClose)}</span>
          <span className={up ? UP : DOWN}>
            {up ? "▲" : "▼"} {signedPct(d.expectedPct)}
          </span>
          <span className="text-zinc-500">{d.probUp.toFixed(1)}% chance up</span>
        </div>
        <div className="text-zinc-500">
          80% range {price(d.lower)} – {price(d.upper)}
        </div>
        {d.actual ? (
          <div className="mt-2 rounded border border-zinc-200 p-2 dark:border-zinc-800">
            Actual close {price(d.actual.close)}{" "}
            <span className={d.actual.pct >= 0 ? UP : DOWN}>
              ({d.actual.pct >= 0 ? "▲" : "▼"} {signedPct(d.actual.pct)})
            </span>
            <div className="flex gap-3">
              <Verdict ok={d.actual.directionRight} yes="✓ direction right" no="✗ direction wrong" />
              <Verdict ok={d.actual.inRange} yes="✓ inside range" no="✗ outside range" />
            </div>
          </div>
        ) : (
          <div className="mt-1 text-zinc-500">⏳ This hour hasn&rsquo;t closed yet.</div>
        )}
        <p className="mt-2 text-zinc-500">
          Model trained on {d.trainedOn.hours.toLocaleString()} hours ({new Date(d.trainedOn.from).getFullYear()} → {hm(d.trainedOn.to)}{" "}
          {new Date(d.trainedOn.to).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}) — nothing after
          this hour started.
        </p>
      </section>

      <Drivers d={d} />

      {/* ---- range ---- */}
      <section className="mb-5">
        <H>How big the move could be</H>
        <p className="text-zinc-500">
          Recent volatility <b className="font-normal text-foreground">{d.volatility.recentPct.toFixed(3)}%</b> per hour ×{" "}
          <b className="font-normal text-foreground">{d.volatility.hourFactor.toFixed(2)}×</b> for this time of day
          {d.volatility.hourFactor > 1.1 ? " (a busy hour)" : d.volatility.hourFactor < 0.9 ? " (a quiet hour)" : ""} × {d.volatility.z.toFixed(2)}{" "}
          (sized so 80% of past hours fit) = <b className="font-normal text-foreground">±{d.volatility.rangePct.toFixed(3)}%</b>. Big moves
          cluster, so this part is far more reliable than the direction.
        </p>
      </section>

      <Similar d={d} />
    </Shell>
  );
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="text-xs">
      <h2 className="mb-3 text-sm">Why: {title}</h2>
      {children}
    </div>
  );
}

function H({ children }: { children: React.ReactNode }) {
  return <h3 className="mb-2 text-[11px] font-semibold tracking-wide text-zinc-500 uppercase">{children}</h3>;
}

function Verdict({ ok, yes, no }: { ok: boolean; yes: string; no: string }) {
  return <span className={ok ? UP : DOWN}>{ok ? yes : no}</span>;
}

/** Each feature's push on the forecast. Baseline + all pushes = the forecast exactly. */
function Drivers({ d }: { d: Explanation }) {
  const [all, setAll] = useState(false);
  const shown = all ? d.drivers : d.drivers.slice(0, TOP_DRIVERS);
  const rest = d.drivers.slice(TOP_DRIVERS).reduce((a, x) => a + x.contributionPct, 0);
  const max = Math.max(...d.drivers.map((x) => Math.abs(x.contributionPct)), 1e-9);
  const pushUp = d.drivers.filter((x) => x.contributionPct > 0).reduce((a, x) => a + x.contributionPct, 0);
  const pushDown = d.drivers.filter((x) => x.contributionPct < 0).reduce((a, x) => a + x.contributionPct, 0);

  return (
    <section className="mb-5">
      <H>What pushed the forecast</H>
      <p className="mb-2 text-zinc-500">
        Up-pushes total <span className={UP}>{signedPct(pushUp, 4)}</span>, down-pushes{" "}
        <span className={DOWN}>{signedPct(pushDown, 4)}</span>. They mostly cancel, which is why the forecast is small.
      </p>
      <ul className="space-y-2">
        {shown.map((x) => {
          const pos = x.contributionPct >= 0;
          const w = (Math.abs(x.contributionPct) / max) * 50;
          return (
            <li key={x.label}>
              <div className="flex items-baseline justify-between gap-2">
                <span>
                  {x.label} <span className="text-zinc-500">· {x.detail}</span>
                </span>
                <span className={`shrink-0 ${pos ? UP : DOWN}`}>{signedPct(x.contributionPct, 4)}</span>
              </div>
              {/* diverging bar around a centre line */}
              <div className="relative my-0.5 h-1.5 rounded bg-zinc-100 dark:bg-zinc-800" aria-hidden>
                <div className="absolute inset-y-0 left-1/2 w-px bg-zinc-400" />
                <div
                  className={`absolute inset-y-0 rounded ${pos ? "bg-emerald-600" : "bg-rose-600"}`}
                  style={pos ? { left: "50%", width: `${w}%` } : { right: "50%", width: `${w}%` }}
                />
              </div>
              <div className="text-zinc-500">Learned: {x.learned}.</div>
            </li>
          );
        })}
      </ul>
      {d.drivers.length > TOP_DRIVERS && (
        <button onClick={() => setAll(!all)} className="mt-2 text-zinc-500 underline hover:text-foreground">
          {all ? "Show fewer" : `+ ${d.drivers.length - TOP_DRIVERS} smaller effects (${signedPct(rest, 4)} together)`}
        </button>
      )}
      <p className="mt-2 border-t border-zinc-200 pt-2 text-zinc-500 dark:border-zinc-800">
        Average hour {signedPct(d.baselinePct, 4)} + all pushes = forecast{" "}
        <span className={d.expectedPct >= 0 ? UP : DOWN}>{signedPct(Math.log(1 + d.expectedPct / 100) * 100, 4)}</span>
      </p>
    </section>
  );
}

/** Nearest past 12-candle patterns and what happened after them. */
function Similar({ d }: { d: Explanation }) {
  const s = d.similar.stats;
  const modelUp = d.expectedPct >= 0;
  const upShare = s.count ? (s.up / s.count) * 100 : 50;
  const agree = upShare === 50 ? null : upShare > 50 === modelUp;

  return (
    <section>
      <H>This pattern (last 12 hours)</H>
      <MiniCandles candles={d.pattern} ghost={{ base: d.baseClose, close: d.predictedClose, low: d.lower, high: d.upper }} />
      <p className="mb-4 text-zinc-500">Blue dashed candle = this forecast, whiskers = 80% range.</p>

      <H>Similar past patterns</H>
      <p className="mb-1 text-zinc-500">
        The {s.count} closest 12-hour shapes in history (scaled by volatility, so a calm and a wild version of the same shape match):
      </p>
      <p className="mb-1">
        <span className={UP}>{s.up} went up</span> · <span className={DOWN}>{s.down} went down</span> · average next hour{" "}
        <span className={s.meanPct >= 0 ? UP : DOWN}>{signedPct(s.meanPct)}</span>, median{" "}
        <span className={s.medianPct >= 0 ? UP : DOWN}>{signedPct(s.medianPct)}</span>
      </p>
      <p className="mb-3 text-zinc-500">
        {agree === null
          ? "Similar patterns split evenly - no lean either way."
          : agree
            ? `They agree with the model (${modelUp ? "up" : "down"}).`
            : `They lean ${modelUp ? "down" : "up"}, against the model - a sign the call is weak.`}
      </p>

      <ul className="space-y-3">
        {d.similar.matches.map((m) => (
          <li key={m.endTs} className="rounded border border-zinc-200 p-2 dark:border-zinc-800">
            <div className="mb-1 flex items-baseline justify-between gap-2">
              <span>
                {new Date(m.endTs).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })} {hm(m.endTs)}
              </span>
              <span className="text-zinc-500">{m.similarity.toFixed(0)}% shape match</span>
            </div>
            <MiniCandles candles={m.candles} highlightLast />
            <div className="mb-1">
              Next hour:{" "}
              <span className={m.nextPct >= 0 ? UP : DOWN}>
                {m.nextPct >= 0 ? "▲" : "▼"} {signedPct(m.nextPct)}
              </span>
            </div>
            <ul className="list-disc pl-4 text-zinc-500">
              {m.why.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Small candlestick chart as inline SVG. */
function MiniCandles({
  candles,
  highlightLast = false,
  ghost,
}: {
  candles: MiniCandle[];
  highlightLast?: boolean;
  ghost?: { base: number; close: number; low: number; high: number };
}) {
  const slots = candles.length + (ghost ? 1 : 0);
  const W = slots * 10;
  const H = 64;
  let lo = Math.min(...candles.map((c) => c[3]));
  let hi = Math.max(...candles.map((c) => c[2]));
  if (ghost) {
    lo = Math.min(lo, ghost.low);
    hi = Math.max(hi, ghost.high);
  }
  const pad = (hi - lo) * 0.06 || 1;
  lo -= pad;
  hi += pad;
  const y = (v: number) => H - ((v - lo) / (hi - lo)) * H;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="mb-1 h-16 w-full" preserveAspectRatio="none" role="img" aria-label="candlestick pattern">
      {highlightLast && <rect x={(candles.length - 1) * 10} y={0} width={10} height={H} className="fill-zinc-200 dark:fill-zinc-800" />}
      {candles.map(([, o, h, l, c], i) => {
        const x = i * 10 + 5;
        const upC = c >= o;
        const cls = upC ? "fill-[#0ca30c] stroke-[#0ca30c]" : "fill-[#d03b3b] stroke-[#d03b3b]";
        return (
          <g key={i} className={cls}>
            <line x1={x} x2={x} y1={y(h)} y2={y(l)} strokeWidth={1} vectorEffect="non-scaling-stroke" />
            <rect x={x - 3} y={Math.min(y(o), y(c))} width={6} height={Math.max(1, Math.abs(y(o) - y(c)))} strokeWidth={0} />
          </g>
        );
      })}
      {ghost && (
        <g className="fill-none stroke-[#2a78d6] dark:stroke-[#3987e5]">
          <line
            x1={candles.length * 10 + 5}
            x2={candles.length * 10 + 5}
            y1={y(ghost.high)}
            y2={y(ghost.low)}
            strokeWidth={1}
            strokeDasharray="2 2"
            vectorEffect="non-scaling-stroke"
          />
          <rect
            x={candles.length * 10 + 2}
            y={Math.min(y(ghost.base), y(ghost.close))}
            width={6}
            height={Math.max(1.5, Math.abs(y(ghost.base) - y(ghost.close)))}
            strokeWidth={1}
            strokeDasharray="2 1"
            vectorEffect="non-scaling-stroke"
          />
        </g>
      )}
    </svg>
  );
}
