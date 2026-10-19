"use client";

import { useEffect, useState } from "react";
import { schematic } from "@/lib/candle-code";
import type { Discovered, Discovery, Tier } from "@/lib/discover";
import MiniCandles from "../mini-candles";

const yr = (ms: number) => String(new Date(ms).getFullYear()).slice(2).padStart(3, "’");
const day = (ms: number) => new Date(ms).toLocaleDateString(undefined, { dateStyle: "medium" });

/** Data-mined candle sequences, checked on data they were not found in. */
export default function DiscoveredView({ symbol }: { symbol: string }) {
  const [state, setState] = useState<{ symbol: string; d: Discovery | null; error: string | null } | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    fetch(`/api/discovered?symbol=${symbol}`, { signal: ctrl.signal, cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error(await r.text());
        setState({ symbol, d: await r.json(), error: null });
      })
      .catch((e) => !ctrl.signal.aborted && setState({ symbol, d: null, error: String(e) }));
    return () => ctrl.abort();
  }, [symbol]);

  const d = state?.symbol === symbol ? state.d : null;
  if (state?.symbol === symbol && state.error) return <p className="card p-4 text-down">{state.error}</p>;
  if (!d) return <div className="card h-64 animate-pulse" />;

  const by = (t: Tier) => d.patterns.filter((p) => p.tier === t);
  const [confirmed, weak, failed] = [by("confirmed"), by("weak"), by("failed")];

  return (
    <>
      <section className="card mb-5 p-5">
        <div className="grid gap-5 md:grid-cols-4">
          <Step n="1" title="Describe every candle">
            Each hour becomes a letter: green / red / doji, small / medium / big body, long upper or lower wick, plus the trend before it.
          </Step>
          <Step n="2" title={`Search ${d.candidates.toLocaleString()} sequences`}>
            Every 1-, 2- and 3-candle sequence from {day(d.from)} to {day(d.splitAt)}. {d.patterns.length} were followed by an unusual next hour (150+
            cases, |z| ≥ 3).
          </Step>
          <Step n="3" title="Re-check on newer data">
            Tested on {day(d.splitAt)} → {day(d.to)}, data they were not found in. Searching thousands of sequences always finds some lucky ones;
            this weeds them out.
          </Step>
          <Step n="4" title="Result">
            <span className="text-up">{confirmed.length} confirmed</span> · <span className="text-amber-600">{weak.length} weak</span> ·{" "}
            <span className="text-muted">{failed.length} failed (luck)</span>. Confirmed and weak ones are marked ★ on the 1h chart and shown in the
            sidebar when they form.
          </Step>
        </div>
      </section>

      <Group title="Confirmed" note="held up on the newer data (same direction, |z| ≥ 2)" rows={confirmed} d={d} />
      <Group title="Weak" note="same direction on the newer data, but weaker (|z| 1–2)" rows={weak} d={d} />
      {failed.length > 0 && (
        <details className="card mb-5 p-0">
          <summary className="cursor-pointer px-5 py-3 font-medium">
            Failed — {failed.length} sequences that only looked strong by luck <span className="font-normal text-muted">(click to see)</span>
          </summary>
          <div className="border-t border-line p-5 pt-3">
            <Cards rows={failed} d={d} />
          </div>
        </details>
      )}
      <p className="text-xs text-muted">
        Base rates: any hour closed higher {d.baseFindPct.toFixed(1)}% of the time in the search period and {d.baseCheckPct.toFixed(1)}% in the
        check period. Not trading advice.
      </p>
    </>
  );
}

function Step({ n, title, children }: { n: string; title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 flex items-center gap-2 font-medium">
        <span className="grid h-5 w-5 place-items-center rounded-full bg-foreground text-[11px] text-background">{n}</span>
        {title}
      </div>
      <p className="text-xs text-muted">{children}</p>
    </div>
  );
}

function Group({ title, note, rows, d }: { title: string; note: string; rows: Discovered[]; d: Discovery }) {
  if (!rows.length) return null;
  return (
    <section className="card mb-5">
      <h2 className="border-b border-line px-5 py-3 font-medium">
        {title} <span className="font-normal text-muted">— {note}</span>
      </h2>
      <div className="p-5">
        <Cards rows={rows} d={d} />
      </div>
    </section>
  );
}

function Cards({ rows, d }: { rows: Discovered[]; d: Discovery }) {
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {rows.map((p) => {
        const up = p.direction === "up";
        return (
          <div key={p.id} className="rounded-lg border border-line p-4">
            <div className="mb-2 flex items-start gap-3">
              <MiniCandles candles={schematic(p.key)} className="h-16 w-14 shrink-0" />
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs text-muted">★{p.id}</span>
                  <span className={`rounded-md px-1.5 py-0.5 text-[11px] font-medium ${up ? "bg-up/10 text-up" : "bg-down/10 text-down"}`}>
                    {up ? "▲ next hour up" : "▼ next hour down"}
                  </span>
                </div>
                <div className="mt-1 text-sm">{p.description}</div>
              </div>
            </div>
            <Compare label={`Found (${yr(d.from)}–${yr(d.splitAt)})`} s={p.find} base={d.baseFindPct} />
            <Compare label={`Checked (${yr(d.splitAt)}–${yr(d.to)})`} s={p.check} base={d.baseCheckPct} />
            <div className="mt-2 flex justify-between text-[11px] text-muted">
              <span>
                avg next-hour move{" "}
                <span className={p.all.avgPct >= 0 ? "text-up" : "text-down"}>
                  {p.all.avgPct >= 0 ? "+" : ""}
                  {p.all.avgPct.toFixed(3)}%
                </span>
              </span>
              {p.lastSeen && <span>last seen {new Date(p.lastSeen).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false })}</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Up-rate vs base rate on a 30–70% scale. */
function Compare({ label, s, base }: { label: string; s: Discovered["find"]; base: number }) {
  const x = (v: number) => `${((Math.min(70, Math.max(30, v)) - 30) / 40) * 100}%`;
  const above = s.upPct >= base;
  return (
    <div className="mt-2">
      <div className="flex justify-between text-[11px]">
        <span className="text-muted">{label}</span>
        <span className="font-mono">
          {s.n ? `${s.upPct.toFixed(1)}% up · ${s.n.toLocaleString()} times · z ${s.z >= 0 ? "+" : ""}${s.z.toFixed(1)}` : "not seen"}
        </span>
      </div>
      {s.n > 0 && (
        <div className="relative mt-1 h-2 rounded-full bg-panel-2">
          <div
            className={`absolute inset-y-0 rounded-full ${above ? "bg-up/60" : "bg-down/60"}`}
            style={above ? { left: x(base), width: `calc(${x(s.upPct)} - ${x(base)})` } : { left: x(s.upPct), width: `calc(${x(base)} - ${x(s.upPct)})` }}
          />
          <div className="absolute -top-0.5 -bottom-0.5 w-px bg-foreground/50" style={{ left: x(base) }} title={`base ${base.toFixed(1)}%`} />
        </div>
      )}
    </div>
  );
}
