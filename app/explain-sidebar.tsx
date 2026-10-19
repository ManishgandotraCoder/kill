"use client";

import Link from "next/link";
import { schematic } from "@/lib/candle-code";
import type { Explanation } from "@/lib/predict";
import MiniCandles from "./mini-candles";
import { hm, hourLabel, signedPct } from "./points";

const UP = "text-up";
const DOWN = "text-down";

/** Right sidebar: which discovered patterns formed just before the selected hour. */
export default function ExplainSidebar({ title, data, error }: { title: string; data: Explanation | null; error: string | null }) {
  return (
    <div className="text-xs">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium">Discovered pattern match</h2>
        <Link href="/patterns" className="text-[11px] text-muted underline hover:text-foreground">
          all patterns →
        </Link>
      </div>
      {error && <p className={DOWN}>{error}</p>}
      {!data && !error && <p className="text-muted">Checking…</p>}
      {data && <Matches title={title} d={data} />}
    </div>
  );
}

function Matches({ title, d }: { title: string; d: Explanation }) {
  const a = d.actual;
  return (
    <>
      <p className="mb-3 text-muted">
        {title} · candle {hourLabel(d.targetTs)} · patterns ending at {hm(d.basedOnUntil)}
      </p>

      {d.discovered.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line p-4 text-center text-muted">No discovered pattern matches before this candle.</p>
      ) : (
        <ul className="space-y-2">
          {d.discovered.map((p) => {
            const up = p.direction === "up";
            const right = a ? a.pct > 0 === up : null;
            return (
              <li key={p.id} className="flex gap-3 rounded-lg border border-line p-3">
                <MiniCandles candles={schematic(p.key)} className="h-14 w-11 shrink-0" />
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-[11px] text-muted">★{p.id}</span>
                    <span className={`rounded-md px-1.5 py-0.5 text-[11px] font-medium ${up ? "bg-up/10 text-up" : "bg-down/10 text-down"}`}>
                      {up ? "▲ suggests up" : "▼ suggests down"}
                    </span>
                    <span className="text-[11px] text-muted">{p.tier}</span>
                  </div>
                  <div className="mt-1 text-sm">{p.description}</div>
                  <div className="mt-1 text-muted">
                    Next hour up {p.find.upPct.toFixed(1)}% when found, {p.check.upPct.toFixed(1)}% on newer data ({p.check.n} times).
                  </div>
                  {a ? (
                    <div className="mt-1">
                      Actual: <span className={a.pct >= 0 ? UP : DOWN}>{a.pct >= 0 ? "▲" : "▼"} {signedPct(a.pct)}</span>{" "}
                      <span className={right ? UP : DOWN}>{right ? "✓ pattern right" : "✗ pattern wrong"}</span>
                    </div>
                  ) : (
                    <div className="mt-1 text-muted">⏳ candle still open</div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
