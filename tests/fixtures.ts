// Synthetic OHLC fixtures with known outcomes for pattern tests.
import type { Candle } from "../lib/pattern-detect";

export const STEP = 60_000;
export const T0 = Date.UTC(2024, 0, 1);

export type Bar = Omit<Candle, "ts">;

/** 25 context candles ending at `end`: down/up = 3-point candles stepping 3 each (avgBody 3,
 * avgRange 9, 5-candle move -15/+15 = 1.67 avgRanges), flat = alternating 2-point candles. */
export function context(trend: "down" | "up" | "flat", end = 1000, n = 25): Bar[] {
  const out: Bar[] = [];
  for (let i = n - 1; i >= 0; i--) {
    if (trend === "flat") {
      const [o, c] = i % 2 ? [end, end + 2] : [end + 2, end];
      out.push({ o, c, h: Math.max(o, c) + 3, l: Math.min(o, c) - 3 });
    } else {
      const d = trend === "down" ? -3 : 3;
      const c = end + -d * i, o = c - d;
      out.push({ o, c, h: Math.max(o, c) + 3, l: Math.min(o, c) - 3 });
    }
  }
  return out;
}

/** Assigns consecutive 1m timestamps (optionally skipping indices to create gaps). */
export function withTs(bars: Bar[], gapsBefore: number[] = []): Candle[] {
  let ts = T0;
  return bars.map((b, i) => {
    if (gapsBefore.includes(i)) ts += STEP * 3;
    const k = { ts, ...b };
    ts += STEP;
    return k;
  });
}

/** Deterministic random walk (for look-ahead / resume tests). */
export function randomWalk(n: number, seed = 42): Bar[] {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const out: Bar[] = [];
  let p = 30000;
  for (let i = 0; i < n; i++) {
    const o = p, c = p + (rnd() - 0.5) * 40;
    const h = Math.max(o, c) + rnd() * 20, l = Math.min(o, c) - rnd() * 20;
    out.push({ o: +o.toFixed(2), c: +c.toFixed(2), h: +h.toFixed(2), l: +l.toFixed(2) });
    p = c;
  }
  return out;
}
