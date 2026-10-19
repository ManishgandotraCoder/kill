// Classic candlestick pattern detectors. Pure functions over OHLC arrays, so the
// same code runs on the server (model features, 5-year stats) and in the browser
// (chart markers).
//
// A pattern "at t" means its last candle is bar t (it is complete once t closes).
// "Strong"/"small" candles are judged against the average body of the 20 candles
// before the pattern; trend context compares the close just before the pattern
// with the close 5 candles earlier.

export interface OHLC {
  o: number;
  h: number;
  l: number;
  c: number;
}

export type PatternGroup = "bullish" | "bearish" | "continuation" | "indecision";
export type Direction = "up" | "down" | "neutral";

interface Ctx {
  avgBody: number;
  avgRange: number;
  /** Trend into the pattern's first candle. */
  trend: "up" | "down" | "flat";
}

export interface PatternDef {
  id: string;
  name: string;
  /** Short label for chart markers. */
  code: string;
  group: PatternGroup;
  /** What the textbook says comes next. */
  textbook: Direction;
  candles: number;
  description: string;
  test: (b: OHLC[], t: number, x: Ctx) => boolean;
}

const body = (b: OHLC) => Math.abs(b.c - b.o);
const range = (b: OHLC) => b.h - b.l;
const green = (b: OHLC) => b.c > b.o;
const red = (b: OHLC) => b.c < b.o;
const upWick = (b: OHLC) => b.h - Math.max(b.o, b.c);
const loWick = (b: OHLC) => Math.min(b.o, b.c) - b.l;
const mid = (b: OHLC) => (b.o + b.c) / 2;

/** Small body, long lower wick, little upper wick (hammer / hanging man shape). */
const hammerShape = (b: OHLC) =>
  range(b) > 0 && body(b) <= range(b) / 3 && loWick(b) >= 2 * body(b) && upWick(b) <= Math.max(body(b), 0.1 * range(b));
/** Small body, long upper wick, little lower wick (inverted hammer / shooting star shape). */
const invertedShape = (b: OHLC) =>
  range(b) > 0 && body(b) <= range(b) / 3 && upWick(b) >= 2 * body(b) && loWick(b) <= Math.max(body(b), 0.1 * range(b));

const threeSame = (b: OHLC[], t: number, x: Ctx, isGreen: boolean) => {
  for (let i = 0; i < 3; i++) {
    const k = b[t - i];
    if (isGreen ? !green(k) : !red(k)) return false;
    if (body(k) < 0.6 * x.avgBody) return false; // "strong" candles
  }
  for (let i = 0; i < 2; i++) {
    const cur = b[t - i], prev = b[t - i - 1];
    const lo = Math.min(prev.o, prev.c), hi = Math.max(prev.o, prev.c);
    if (isGreen ? cur.c <= prev.c : cur.c >= prev.c) return false; // closes progressively higher/lower
    if (cur.o < lo || cur.o > hi) return false; // opens within the previous body
  }
  return true;
};

const threeMethods = (b: OHLC[], t: number, x: Ctx, rising: boolean) => {
  const first = b[t - 4], last = b[t];
  const strong = (k: OHLC) => (rising ? green(k) : red(k)) && body(k) >= x.avgBody;
  if (!strong(first) || !strong(last)) return false;
  for (let i = 1; i <= 3; i++) {
    const k = b[t - 4 + i];
    if (body(k) > 0.5 * body(first) || k.h > first.h || k.l < first.l) return false; // small, inside the first candle
  }
  return rising ? last.c > first.c : last.c < first.c;
};

export const PATTERNS: PatternDef[] = [
  // ---- bullish ----
  {
    id: "bullish-engulfing", name: "Bullish Engulfing", code: "BE", group: "bullish", textbook: "up", candles: 2,
    description: "A green candle's body completely covers the previous red candle's body, after a decline.",
    test: (b, t, x) => {
      const p = b[t - 1], c = b[t];
      return x.trend === "down" && red(p) && green(c) && c.o <= p.c && c.c >= p.o && body(c) > body(p);
    },
  },
  {
    id: "hammer", name: "Hammer", code: "H", group: "bullish", textbook: "up", candles: 1,
    description: "Small body near the top with a long lower wick, after a decline: sellers pushed down, buyers recovered.",
    test: (b, t, x) => x.trend === "down" && hammerShape(b[t]),
  },
  {
    id: "morning-star", name: "Morning Star", code: "MS", group: "bullish", textbook: "up", candles: 3,
    description: "Strong red candle, small indecision candle, then a strong green candle closing above the first one's midpoint.",
    test: (b, t, x) => {
      const a = b[t - 2], m = b[t - 1], c = b[t];
      return x.trend === "down" && red(a) && body(a) >= x.avgBody && body(m) <= 0.3 * body(a) && green(c) && body(c) >= 0.5 * x.avgBody && c.c > mid(a);
    },
  },
  {
    id: "piercing-line", name: "Piercing Line", code: "PL", group: "bullish", textbook: "up", candles: 2,
    description: "A green candle opens below the previous red candle's close and closes above the middle of its body.",
    test: (b, t, x) => {
      const p = b[t - 1], c = b[t];
      return x.trend === "down" && red(p) && body(p) >= 0.6 * x.avgBody && green(c) && c.o < p.c && c.c > mid(p) && c.c < p.o;
    },
  },
  {
    id: "three-white-soldiers", name: "Three White Soldiers", code: "3W", group: "bullish", textbook: "up", candles: 3,
    description: "Three strong green candles in a row, each opening inside the last and closing higher.",
    test: (b, t, x) => threeSame(b, t, x, true),
  },
  {
    id: "inverted-hammer", name: "Inverted Hammer", code: "IH", group: "bullish", textbook: "up", candles: 1,
    description: "Small body with a long upper wick after a decline: buyers tried to push higher.",
    test: (b, t, x) => x.trend === "down" && invertedShape(b[t]),
  },
  {
    id: "tweezer-bottom", name: "Tweezer Bottom", code: "TB", group: "bullish", textbook: "up", candles: 2,
    description: "Two candles (red then green) with almost the same low, after a decline: possible support.",
    test: (b, t, x) => {
      const p = b[t - 1], c = b[t];
      return x.trend === "down" && red(p) && green(c) && Math.abs(c.l - p.l) <= 0.1 * x.avgRange;
    },
  },
  // ---- bearish ----
  {
    id: "bearish-engulfing", name: "Bearish Engulfing", code: "BrE", group: "bearish", textbook: "down", candles: 2,
    description: "A red candle's body completely covers the previous green candle's body, after an advance.",
    test: (b, t, x) => {
      const p = b[t - 1], c = b[t];
      return x.trend === "up" && green(p) && red(c) && c.o >= p.c && c.c <= p.o && body(c) > body(p);
    },
  },
  {
    id: "shooting-star", name: "Shooting Star", code: "SS", group: "bearish", textbook: "down", candles: 1,
    description: "Small body near the bottom with a long upper wick, after an advance: buyers pushed up, sellers forced it back.",
    test: (b, t, x) => x.trend === "up" && invertedShape(b[t]),
  },
  {
    id: "evening-star", name: "Evening Star", code: "ES", group: "bearish", textbook: "down", candles: 3,
    description: "Strong green candle, small candle, then a strong red candle closing below the first one's midpoint.",
    test: (b, t, x) => {
      const a = b[t - 2], m = b[t - 1], c = b[t];
      return x.trend === "up" && green(a) && body(a) >= x.avgBody && body(m) <= 0.3 * body(a) && red(c) && body(c) >= 0.5 * x.avgBody && c.c < mid(a);
    },
  },
  {
    id: "dark-cloud-cover", name: "Dark Cloud Cover", code: "DC", group: "bearish", textbook: "down", candles: 2,
    description: "A red candle opens above the previous green candle's close and closes below the middle of its body.",
    test: (b, t, x) => {
      const p = b[t - 1], c = b[t];
      return x.trend === "up" && green(p) && body(p) >= 0.6 * x.avgBody && red(c) && c.o > p.c && c.c < mid(p) && c.c > p.o;
    },
  },
  {
    id: "three-black-crows", name: "Three Black Crows", code: "3B", group: "bearish", textbook: "down", candles: 3,
    description: "Three strong red candles in a row, each opening inside the last and closing lower.",
    test: (b, t, x) => threeSame(b, t, x, false),
  },
  {
    id: "hanging-man", name: "Hanging Man", code: "HM", group: "bearish", textbook: "down", candles: 1,
    description: "Hammer shape (small body, long lower wick) appearing after an advance.",
    test: (b, t, x) => x.trend === "up" && hammerShape(b[t]),
  },
  {
    id: "tweezer-top", name: "Tweezer Top", code: "TT", group: "bearish", textbook: "down", candles: 2,
    description: "Two candles (green then red) with almost the same high, after an advance: possible resistance.",
    test: (b, t, x) => {
      const p = b[t - 1], c = b[t];
      return x.trend === "up" && green(p) && red(c) && Math.abs(c.h - p.h) <= 0.1 * x.avgRange;
    },
  },
  // ---- continuation ----
  {
    id: "rising-three-methods", name: "Rising Three Methods", code: "R3", group: "continuation", textbook: "up", candles: 5,
    description: "Strong green candle, three small candles inside its range, then another strong green candle closing higher.",
    test: (b, t, x) => threeMethods(b, t, x, true),
  },
  {
    id: "falling-three-methods", name: "Falling Three Methods", code: "F3", group: "continuation", textbook: "down", candles: 5,
    description: "Strong red candle, three small candles inside its range, then another strong red candle closing lower.",
    test: (b, t, x) => threeMethods(b, t, x, false),
  },
  // ---- indecision / momentum ----
  {
    id: "doji", name: "Doji", code: "D", group: "indecision", textbook: "neutral", candles: 1,
    description: "Open and close almost equal (body at most 10% of the range): indecision.",
    test: (b, t) => range(b[t]) > 0 && body(b[t]) <= 0.1 * range(b[t]),
  },
  {
    id: "spinning-top", name: "Spinning Top", code: "ST", group: "indecision", textbook: "neutral", candles: 1,
    description: "Small body with wicks on both sides longer than the body: neither side in control.",
    test: (b, t) => {
      const k = b[t];
      return range(k) > 0 && body(k) > 0.1 * range(k) && body(k) <= 0.3 * range(k) && upWick(k) >= body(k) && loWick(k) >= body(k);
    },
  },
  {
    id: "bullish-marubozu", name: "Bullish Marubozu", code: "M▲", group: "indecision", textbook: "up", candles: 1,
    description: "A strong green candle with almost no wicks: buyers in control the whole hour.",
    test: (b, t, x) => green(b[t]) && body(b[t]) >= 0.95 * range(b[t]) && body(b[t]) >= x.avgBody,
  },
  {
    id: "bearish-marubozu", name: "Bearish Marubozu", code: "M▼", group: "indecision", textbook: "down", candles: 1,
    description: "A strong red candle with almost no wicks: sellers in control the whole hour.",
    test: (b, t, x) => red(b[t]) && body(b[t]) >= 0.95 * range(b[t]) && body(b[t]) >= x.avgBody,
  },
];

const LOOKBACK = 20;
const MAX_CANDLES = Math.max(...PATTERNS.map((p) => p.candles));
/** First index where every pattern can be tested. */
export const PATTERN_MIN_INDEX = MAX_CANDLES - 1 + LOOKBACK;

/** Bitmask of PATTERNS completed at bar t (bit i = PATTERNS[i]). 0 if not enough history. */
export function detectMask(b: OHLC[], t: number): number {
  if (t < PATTERN_MIN_INDEX || t >= b.length) return 0;
  let mask = 0;
  const ctxCache = new Map<number, Ctx>();
  PATTERNS.forEach((p, i) => {
    const start = t - p.candles + 1;
    let x = ctxCache.get(start);
    if (!x) {
      let sb = 0, sr = 0;
      for (let k = start - LOOKBACK; k < start; k++) {
        sb += body(b[k]);
        sr += range(b[k]);
      }
      const before = b[start - 1].c, earlier = b[start - 6].c;
      x = { avgBody: sb / LOOKBACK, avgRange: sr / LOOKBACK, trend: before > earlier ? "up" : before < earlier ? "down" : "flat" };
      ctxCache.set(start, x);
    }
    if (p.test(b, t, x)) mask |= 1 << i;
  });
  return mask;
}

export function patternsIn(mask: number): PatternDef[] {
  return PATTERNS.filter((_, i) => mask & (1 << i));
}
