// Turns candles into short "letters" so recurring sequences can be counted and
// searched (pattern discovery). Pure, shared by server and browser.
//
// One candle -> direction + body size + wick shape:
//   U / D   green / red          N   doji (body <= 10% of range)
//   s m L   small / medium / big body, vs the average body of the previous 20 candles
//   ^ v     long upper / long lower wick ("" = balanced)
// e.g. "UL" big green, "Dsv" small red with a long lower wick, "N^" doji with a long upper wick.
// A pattern key adds the trend into its first candle: "↓|DL Usv" = after a decline,
// a big red candle then a small green candle with a long lower wick.

import type { OHLC } from "./patterns";

const AVG = 20;
const TREND = 6;
/** First index whose candles can be encoded with full context. */
export const CODE_MIN_INDEX = AVG + TREND;

export function encodeCandle(b: OHLC[], t: number): string {
  const k = b[t];
  const range = k.h - k.l;
  const body = Math.abs(k.c - k.o);
  const up = k.h - Math.max(k.o, k.c);
  const lo = Math.min(k.o, k.c) - k.l;
  if (range <= 0 || body <= 0.1 * range) return "N" + (up > 2 * lo ? "^" : lo > 2 * up ? "v" : "");
  let avg = 0;
  for (let i = t - AVG; i < t; i++) avg += Math.abs(b[i].c - b[i].o);
  avg /= AVG;
  const rel = avg > 0 ? body / avg : 1;
  const size = rel < 0.6 ? "s" : rel < 1.6 ? "m" : "L";
  const wick = up >= body && up > 2 * lo ? "^" : lo >= body && lo > 2 * up ? "v" : "";
  return (k.c > k.o ? "U" : "D") + size + wick;
}

/** Trend into bar `start`: close before it vs the close TREND-1 candles earlier. */
export function trendInto(b: OHLC[], start: number): "↑" | "↓" {
  return b[start - 1].c >= b[start - TREND].c ? "↑" : "↓";
}

/** Key of the `len`-candle sequence ending at t, or null without enough history. */
export function sequenceKey(b: OHLC[], t: number, len: number, codes?: string[]): string | null {
  const start = t - len + 1;
  if (start < CODE_MIN_INDEX || t >= b.length) return null;
  const parts: string[] = [];
  for (let i = start; i <= t; i++) parts.push(codes ? codes[i] : encodeCandle(b, i));
  return `${trendInto(b, start)}|${parts.join(" ")}`;
}

const SIZE: Record<string, string> = { s: "small", m: "medium", L: "big" };

/** Plain-English description of a key. */
export function describeKey(key: string): string {
  const [trend, seq] = key.split("|");
  const candles = seq.split(" ").map((c) => {
    if (c[0] === "N") return c === "N^" ? "doji with a long upper wick" : c === "Nv" ? "doji with a long lower wick" : "doji";
    const color = c[0] === "U" ? "green" : "red";
    const wick = c.endsWith("^") ? " with a long upper wick" : c.endsWith("v") ? " with a long lower wick" : "";
    return `${SIZE[c[1]]} ${color}${wick}`;
  });
  return `After a ${trend === "↑" ? "rise" : "decline"}: ${candles.join(" → ")}`;
}
