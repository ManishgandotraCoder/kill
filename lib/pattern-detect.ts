// Chart-pattern detection engine (double tops, head & shoulders, wedges, triangles, flags, pennants).
// Pure functions, no DB or browser code; results are persisted by lib/pattern-store.ts.
//
// 1. Volatility: ATR = mean true range of the last `atrPeriod` candles.
// 2. Swing points: a ZigZag marks a swing high (H) once price has fallen `zigzagAtr` x ATR below the
//    highest high since the last swing low, and a swing low (L) the same way upward. A swing point is
//    only known from the candle that confirms it, never earlier.
// 3. Templates: the most recent confirmed swing points are matched against each pattern's shape
//    (equal tops, a higher head, converging or parallel trendlines, ...). Distances are in ATR units
//    and slopes in ATR per candle, so the same rules work at any price level.
// 4. Breakout: a pattern is recorded on the candle whose CLOSE first crosses its neckline/trendline by
//    `breakoutAtr` x ATR, within `maxBreakoutBars` of the last swing point. That candle is the
//    detection's `ts`; nothing after it is read, so there is no look-ahead.
//
// A gap in the candles (missing interval) resets the swing points: patterns never span a gap.
// Direction is the textbook meaning of the completed pattern (for symmetrical/expanding triangles,
// the breakout side), not a prediction - outcomes are measured separately (pattern_outcomes view).

export const DETECTOR_VERSION = 3;

export type PatternKey =
  | "double_top" | "double_bottom" | "triple_top" | "triple_bottom"
  | "head_and_shoulders" | "inverse_head_and_shoulders" | "rising_wedge" | "falling_wedge"
  | "bull_flag" | "bear_flag" | "bull_pennant" | "bear_pennant" | "ascending_triangle" | "descending_triangle"
  | "symmetrical_triangle" | "bullish_expanding_triangle" | "bearish_expanding_triangle";
export type PatternDirection = "bullish" | "bearish" | "neutral";
/** reversal: trend may turn; continuation: trend may carry on; bilateral: breakout side decides. */
export type PatternGroup = "reversal" | "continuation" | "bilateral";

export interface PatternInfo {
  key: PatternKey;
  name: string;
  /** Short chart-marker label. */
  code: string;
  /** Textbook meaning; "neutral" = either way, decided by the breakout. */
  direction: PatternDirection;
  group: PatternGroup;
  definition: string;
}

// Order here is the display order (UI chips, filter list).
export const PATTERN_INFO: Record<PatternKey, PatternInfo> = {
  // ---- reversal ----
  double_top: {
    key: "double_top", name: "Double Top", code: "DT", direction: "bearish", group: "reversal",
    definition: "After a rise, two swing highs at about the same level (within 1 ATR) with a dip of at least 2 ATR between them. Confirmed when a close breaks below that dip (the neckline).",
  },
  double_bottom: {
    key: "double_bottom", name: "Double Bottom", code: "DB", direction: "bullish", group: "reversal",
    definition: "After a fall, two swing lows at about the same level (within 1 ATR) with a bounce of at least 2 ATR between them. Confirmed when a close breaks above that bounce (the neckline).",
  },
  triple_top: {
    key: "triple_top", name: "Triple Top", code: "TT", direction: "bearish", group: "reversal",
    definition: "After a rise, three swing highs within 1 ATR of each other with dips between them. Confirmed when a close breaks below the lower of the two dips.",
  },
  triple_bottom: {
    key: "triple_bottom", name: "Triple Bottom", code: "TB", direction: "bullish", group: "reversal",
    definition: "After a fall, three swing lows within 1 ATR of each other with bounces between them. Confirmed when a close breaks above the higher of the two bounces.",
  },
  head_and_shoulders: {
    key: "head_and_shoulders", name: "Head and Shoulders", code: "HS", direction: "bearish", group: "reversal",
    definition: "After a rise, three swing highs: a head at least 1 ATR above two shoulders that are within 1.5 ATR of each other. Confirmed when a close breaks below the neckline joining the two dips.",
  },
  inverse_head_and_shoulders: {
    key: "inverse_head_and_shoulders", name: "Inverse Head and Shoulders", code: "iHS", direction: "bullish", group: "reversal",
    definition: "After a fall, three swing lows: a head at least 1 ATR below two shoulders within 1.5 ATR of each other. Confirmed when a close breaks above the neckline joining the two bounces.",
  },
  rising_wedge: {
    key: "rising_wedge", name: "Rising Wedge", code: "RW", direction: "bearish", group: "reversal",
    definition: "Swing highs and lows both rising, with the lows rising faster so the lines converge. Confirmed when a close breaks below the lower line.",
  },
  falling_wedge: {
    key: "falling_wedge", name: "Falling Wedge", code: "FW", direction: "bullish", group: "reversal",
    definition: "Swing highs and lows both falling, with the highs falling faster so the lines converge. Confirmed when a close breaks above the upper line.",
  },
  // ---- continuation ----
  bull_flag: {
    key: "bull_flag", name: "Bull Flag", code: "BF", direction: "bullish", group: "continuation",
    definition: "A sharp rise (the pole, at least 6 ATR) then a short, flat or downward-sloping parallel channel that gives back at most half the pole. Confirmed when a close breaks above the channel.",
  },
  bear_flag: {
    key: "bear_flag", name: "Bear Flag", code: "BrF", direction: "bearish", group: "continuation",
    definition: "A sharp fall (the pole, at least 6 ATR) then a short, flat or upward-sloping parallel channel that retraces at most half the pole. Confirmed when a close breaks below the channel.",
  },
  bull_pennant: {
    key: "bull_pennant", name: "Bull Pennant", code: "BP", direction: "bullish", group: "continuation",
    definition: "A sharp rise (the pole) then a small converging triangle (falling highs, rising lows). Confirmed when a close breaks above the upper line.",
  },
  bear_pennant: {
    key: "bear_pennant", name: "Bear Pennant", code: "BrP", direction: "bearish", group: "continuation",
    definition: "A sharp fall (the pole) then a small converging triangle (falling highs, rising lows). Confirmed when a close breaks below the lower line.",
  },
  ascending_triangle: {
    key: "ascending_triangle", name: "Ascending Triangle", code: "AT", direction: "bullish", group: "continuation",
    definition: "Flat swing highs (resistance) and rising swing lows, converging. Confirmed when a close breaks above the flat top.",
  },
  descending_triangle: {
    key: "descending_triangle", name: "Descending Triangle", code: "DsT", direction: "bearish", group: "continuation",
    definition: "Flat swing lows (support) and falling swing highs, converging. Confirmed when a close breaks below the flat bottom.",
  },
  // ---- bilateral ----
  symmetrical_triangle: {
    key: "symmetrical_triangle", name: "Symmetrical Triangle", code: "ST", direction: "neutral", group: "bilateral",
    definition: "Falling swing highs and rising swing lows converging toward a point. Either breakout counts: the direction is the side the close breaks out of.",
  },
  bullish_expanding_triangle: {
    key: "bullish_expanding_triangle", name: "Bullish Expanding Triangle", code: "ET▲", direction: "bullish", group: "bilateral",
    definition: "Rising swing highs and falling swing lows: the range widens (a megaphone). Recorded as bullish when a close breaks above the upper line.",
  },
  bearish_expanding_triangle: {
    key: "bearish_expanding_triangle", name: "Bearish Expanding Triangle", code: "ET▼", direction: "bearish", group: "bilateral",
    definition: "Rising swing highs and falling swing lows: the range widens (a megaphone). Recorded as bearish when a close breaks below the lower line.",
  },
};

export const PATTERN_KEYS = Object.keys(PATTERN_INFO) as PatternKey[];

export interface Candle {
  /** Open time, ms UTC. */
  ts: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

export interface DetectConfig {
  atrPeriod: number;
  /** Reversal (in ATR) that confirms a swing point. */
  zigzagAtr: number;
  /** A breakout close must clear the line by this many ATR. */
  breakoutAtr: number;
  /** The breakout must come within this many candles of the last swing point. */
  maxBreakoutBars: number;
  /** Pattern length limits (first swing point to last), in candles. */
  minSpan: number;
  maxSpan: number;
  /** Tops/bottoms count as "equal" within this many ATR. */
  equalAtr: number;
  /** Minimum depth of the dip/bounce between double/triple tops/bottoms and H&S shoulders, in ATR. */
  minDepthAtr: number;
  headAndShoulders: { minHeadAtr: number; shoulderAtr: number; maxNeckSlope: number };
  /** Triangles / wedges: a line is "flat" when |slope| <= flatSlope ATR per candle; swing points must sit within fitAtr of their line. */
  lines: { flatSlope: number; fitAtr: number; converge: number; diverge: number };
  flag: { minPoleAtr: number; maxPoleBars: number; maxBars: number; maxRetrace: number; parallelSlope: number };
  /** Candles of history loaded before an incremental scan so swing points are rebuilt exactly. */
  warmupBars: number;
}

export const DEFAULT_DETECT_CONFIG: DetectConfig = {
  atrPeriod: 14,
  zigzagAtr: 2,
  breakoutAtr: 0.1,
  maxBreakoutBars: 30,
  minSpan: 10,
  maxSpan: 300,
  equalAtr: 1,
  minDepthAtr: 2,
  headAndShoulders: { minHeadAtr: 1, shoulderAtr: 1.5, maxNeckSlope: 0.1 },
  lines: { flatSlope: 0.015, fitAtr: 1, converge: 0.75, diverge: 1.33 },
  flag: { minPoleAtr: 6, maxPoleBars: 25, maxBars: 40, maxRetrace: 0.5, parallelSlope: 0.06 },
  warmupBars: 5000,
};

export interface Detection {
  pattern: PatternKey;
  direction: PatternDirection;
  /** Open time of the breakout candle (the one whose close completes the pattern). */
  ts: number;
  /** Open time of the pattern's first swing point. */
  startTs: number;
  /** Candles from the first swing point to the breakout. */
  candles: number;
  meta: PatternMeta;
}

export interface Pt {
  ts: number;
  p: number;
}

export interface PatternMeta {
  /** Swing points that form the pattern, oldest first. */
  points: (Pt & { type: "H" | "L" })[];
  /** Neckline / trendlines, drawn from the first relevant swing point to the breakout candle. */
  lines: { a: Pt; b: Pt }[];
  /** Price level the close crossed. */
  level: number;
  atr: number;
  [k: string]: unknown;
}

const isValid = (k: Candle) =>
  [k.ts, k.o, k.h, k.l, k.c].every(Number.isFinite) && k.l > 0 && k.h >= Math.max(k.o, k.c) && k.l <= Math.min(k.o, k.c);

/** Sorts by time, drops invalid candles and duplicate timestamps (keeps the first one seen). */
export function prepareCandles(input: Candle[]) {
  let unsorted = false;
  for (let i = 1; i < input.length; i++) if (input[i].ts < input[i - 1].ts) unsorted = true;
  const valid = input.filter(isValid);
  const sorted = unsorted ? [...valid].sort((a, b) => a.ts - b.ts) : valid;
  const candles = sorted.filter((k, i) => i === 0 || k.ts !== sorted[i - 1].ts);
  return { candles, unsorted, invalid: input.length - valid.length, duplicates: valid.length - candles.length };
}

/** runs[i] = length of the gap-free run of candles ending at i (1 = previous candle missing). */
export function contiguousRuns(c: Candle[], stepMs: number): Int32Array {
  const runs = new Int32Array(c.length);
  for (let i = 0; i < c.length; i++) runs[i] = i > 0 && c[i].ts - c[i - 1].ts === stepMs ? runs[i - 1] + 1 : 1;
  return runs;
}

export function validateConfig(cfg: DetectConfig) {
  if (!(cfg.atrPeriod >= 2 && cfg.zigzagAtr > 0 && cfg.minSpan >= 2 && cfg.maxSpan > cfg.minSpan && cfg.warmupBars >= cfg.maxSpan)) {
    throw new Error("DetectConfig: need atrPeriod >= 2, zigzagAtr > 0, 2 <= minSpan < maxSpan <= warmupBars");
  }
}

export interface Pivot {
  i: number;
  p: number;
  type: "H" | "L";
}

/** Straight line through two points, evaluated at candle index x. */
const lineAt = (a: { i: number; p: number }, b: { i: number; p: number }) => (x: number) => a.p + ((b.p - a.p) * (x - a.i)) / (b.i - a.i || 1);

interface Match {
  key: PatternKey;
  direction: PatternDirection;
  pivots: Pivot[];
  lines: [{ i: number; p: number }, { i: number; p: number }][];
  level: number;
}

/**
 * Pattern templates checked at candle t, given confirmed swing points `pv` (oldest first) and ATR.
 * `crossUp(level)` / `crossDown(level)` tell whether candle t's close is the FIRST to clear a level
 * (functions of the candle index, so sloped lines are evaluated at t and t - 1).
 */
function matchAt(
  c: Candle[], pv: Pivot[], t: number, atr: number, cfg: DetectConfig,
  crossUp: (f: (x: number) => number) => boolean, crossDown: (f: (x: number) => number) => boolean,
): Match | null {
  const n = pv.length;
  if (!n || t - pv[n - 1].i > cfg.maxBreakoutBars || t <= pv[n - 1].i) return null;
  const last = (k: number) => (n >= k ? pv.slice(n - k) : null);
  const spanOk = (first: Pivot) => t - first.i >= cfg.minSpan && t - first.i <= cfg.maxSpan;
  const lastType = pv[n - 1].type;

  // ---- head & shoulders, triple, double (reversal, horizontal or near-horizontal neckline) ----
  const six = last(6), four = last(4);
  for (const bearish of [true, false]) {
    // bearish: L0 H1 L2 H3 L4 H5 ... ; bullish mirror: H0 L1 H2 L3 H4 L5
    if (lastType !== (bearish ? "H" : "L")) continue;
    const s = bearish ? 1 : -1; // flip prices so "top" logic serves both
    if (six) {
      const [p0, s1, n2, h3, n4, s5] = six;
      const v = (x: Pivot) => s * x.p;
      const neck = lineAt(n2, n4);
      const neckSlope = Math.abs(n4.p - n2.p) / (n4.i - n2.i) / atr;
      const hs = cfg.headAndShoulders;
      if (
        spanOk(s1) &&
        v(h3) >= Math.max(v(s1), v(s5)) + hs.minHeadAtr * atr &&
        Math.abs(s1.p - s5.p) <= hs.shoulderAtr * atr &&
        Math.min(v(s1), v(s5)) - Math.max(v(n2), v(n4)) >= cfg.minDepthAtr * atr &&
        v(p0) < Math.min(v(n2), v(n4)) &&
        neckSlope <= hs.maxNeckSlope &&
        (bearish ? crossDown(neck) : crossUp(neck))
      ) {
        return { key: bearish ? "head_and_shoulders" : "inverse_head_and_shoulders", direction: bearish ? "bearish" : "bullish", pivots: six.slice(1), lines: [[n2, { i: t, p: neck(t) }]], level: neck(t) };
      }
      const tops = [s1, h3, s5].map(v);
      const neckLevel = bearish ? Math.min(n2.p, n4.p) : Math.max(n2.p, n4.p);
      const level = () => neckLevel;
      if (
        spanOk(s1) &&
        Math.max(...tops) - Math.min(...tops) <= cfg.equalAtr * atr &&
        Math.min(...tops) - Math.max(v(n2), v(n4)) >= cfg.minDepthAtr * atr &&
        v(p0) < Math.min(v(n2), v(n4)) &&
        (bearish ? crossDown(level) : crossUp(level))
      ) {
        const anchor = bearish ? (n2.p <= n4.p ? n2 : n4) : n2.p >= n4.p ? n2 : n4;
        return { key: bearish ? "triple_top" : "triple_bottom", direction: bearish ? "bearish" : "bullish", pivots: six.slice(1), lines: [[anchor, { i: t, p: neckLevel }]], level: neckLevel };
      }
    }
    if (four) {
      const [p0, a, m, b] = four;
      const v = (x: Pivot) => s * x.p;
      const level = () => m.p;
      if (
        spanOk(a) &&
        b.i - a.i >= 5 &&
        Math.abs(a.p - b.p) <= cfg.equalAtr * atr &&
        Math.min(v(a), v(b)) - v(m) >= cfg.minDepthAtr * atr &&
        v(p0) < v(m) &&
        (bearish ? crossDown(level) : crossUp(level))
      ) {
        return { key: bearish ? "double_top" : "double_bottom", direction: bearish ? "bearish" : "bullish", pivots: four.slice(1), lines: [[m, { i: t, p: m.p }]], level: m.p };
      }
    }
  }

  // ---- flags & pennants: pole, then a short consolidation, breakout in the pole's direction ----
  const five = last(5);
  if (five) {
    for (const bull of [true, false]) {
      // bull: L0 H1 L2 H3 L4 (pole L0 -> H1); bear: H0 L1 H2 L3 H4 (pole H0 -> L1)
      if (five[0].type !== (bull ? "L" : "H")) continue;
      const [p0, p1, p2, p3, p4] = five;
      const f = cfg.flag;
      const pole = Math.abs(p1.p - p0.p);
      if (pole < f.minPoleAtr * atr || p1.i - p0.i > f.maxPoleBars || p4.i - p1.i > f.maxBars || t - p1.i > f.maxBars + cfg.maxBreakoutBars) continue;
      const giveBack = bull ? p1.p - Math.min(p2.p, p4.p) : Math.max(p2.p, p4.p) - p1.p;
      if (giveBack > f.maxRetrace * pole) continue;
      // bull: upper line through highs p1, p3; lower through lows p2, p4 (bear: the reverse)
      const [hiA, hiB, loA, loB] = bull ? [p1, p3, p2, p4] : [p2, p4, p1, p3];
      const upper = lineAt(hiA, hiB), lower = lineAt(loA, loB);
      const su = (hiB.p - hiA.p) / (hiB.i - hiA.i) / atr, sl = (loB.p - loA.p) / (loB.i - loA.i) / atr;
      const fl = cfg.lines.flatSlope;
      const parallel = Math.abs(su - sl) <= f.parallelSlope;
      const flag = parallel && (bull ? su <= fl : su >= -fl);
      const pennant = su < -fl && sl > fl;
      if (!flag && !pennant) continue;
      if (bull ? crossUp(upper) : crossDown(lower)) {
        const key: PatternKey = bull ? (flag ? "bull_flag" : "bull_pennant") : flag ? "bear_flag" : "bear_pennant";
        return {
          key, direction: bull ? "bullish" : "bearish", pivots: five,
          lines: [[hiA, { i: t, p: upper(t) }], [loA, { i: t, p: lower(t) }]], level: bull ? upper(t) : lower(t),
        };
      }
    }
  }

  // ---- triangles, wedges, expanding triangles: trendlines through the last 4-5 swing points ----
  for (const k of [5, 4]) {
    const pts = last(k);
    if (!pts || !spanOk(pts[0])) continue;
    const highs = pts.filter((x) => x.type === "H"), lows = pts.filter((x) => x.type === "L");
    if (highs.length < 2 || lows.length < 2) continue;
    const upper = lineAt(highs[0], highs[highs.length - 1]), lower = lineAt(lows[0], lows[lows.length - 1]);
    const L = cfg.lines;
    if (!pts.every((x) => Math.abs(x.p - (x.type === "H" ? upper(x.i) : lower(x.i))) <= L.fitAtr * atr)) continue;
    const su = (highs[highs.length - 1].p - highs[0].p) / (highs[highs.length - 1].i - highs[0].i) / atr;
    const sl = (lows[lows.length - 1].p - lows[0].p) / (lows[lows.length - 1].i - lows[0].i) / atr;
    const i0 = pts[0].i, i1 = pts[k - 1].i;
    const w0 = upper(i0) - lower(i0), w1 = upper(i1) - lower(i1);
    if (w0 <= 0 || w1 <= 0) continue;
    const converging = w1 <= L.converge * w0, diverging = w1 >= L.diverge * w0;
    const fu = Math.abs(su) <= L.flatSlope, fl = Math.abs(sl) <= L.flatSlope;
    const up = crossUp(upper), down = crossDown(lower);
    if (!up && !down) continue;
    let key: PatternKey | null = null;
    if (converging && fu && sl > L.flatSlope && up) key = "ascending_triangle";
    else if (converging && fl && su < -L.flatSlope && down) key = "descending_triangle";
    else if (converging && su < -L.flatSlope && sl > L.flatSlope) key = "symmetrical_triangle";
    else if (converging && su > L.flatSlope && sl > su && down) key = "rising_wedge";
    else if (converging && sl < -L.flatSlope && su < sl && up) key = "falling_wedge";
    else if (diverging && su > L.flatSlope && sl < -L.flatSlope) key = up ? "bullish_expanding_triangle" : "bearish_expanding_triangle";
    if (!key) continue;
    return {
      key, direction: up ? "bullish" : "bearish", pivots: pts,
      lines: [[highs[0], { i: t, p: upper(t) }], [lows[0], { i: t, p: lower(t) }]], level: up ? upper(t) : lower(t),
    };
  }
  return null;
}

/**
 * Streaming ATR + ZigZag. step(t) must be called for t = 0, 1, 2, ... ; it returns ATR at t (null
 * while warming up) and updates `pivots` with the swing points confirmed by candle t.
 */
class ZigZag {
  pivots: Pivot[] = [];
  private dir = 0; // 1 = tracking a rise (extreme = highest high), -1 = a fall, 0 = not started
  private ext = 0; // index of the current extreme
  private runStart = 0;
  private trSum = 0;
  private tr: number[] = [];

  constructor(private c: Candle[], private cfg: DetectConfig, private keep = 12) {}

  step(t: number, run: number): number | null {
    const { c, cfg } = this;
    const k = c[t];
    if (run === 1) {
      // start of data or after a gap: forget everything
      this.pivots = [];
      this.dir = 0;
      this.ext = t;
      this.runStart = t;
      this.trSum = 0;
      this.tr.length = 0;
    }
    const range = run > 1 ? Math.max(k.h, c[t - 1].c) - Math.min(k.l, c[t - 1].c) : k.h - k.l;
    this.tr.push(range);
    this.trSum += range;
    if (this.tr.length > cfg.atrPeriod) this.trSum -= this.tr[this.tr.length - 1 - cfg.atrPeriod];
    if (this.tr.length < cfg.atrPeriod) return null;
    const atr = this.trSum / cfg.atrPeriod;
    const thr = cfg.zigzagAtr * atr;
    const pv = this.pivots;

    if (this.dir === 0) {
      // first leg: whichever side first moves thr away from the opposite extreme of the run so far
      let hi = this.runStart, lo = this.runStart;
      for (let j = this.runStart; j <= t; j++) {
        if (c[j].h >= c[hi].h) hi = j;
        if (c[j].l <= c[lo].l) lo = j;
      }
      if (k.h - c[lo].l >= thr && lo < t) {
        pv.push({ i: lo, p: c[lo].l, type: "L" });
        this.dir = 1;
        this.ext = t;
      } else if (c[hi].h - k.l >= thr && hi < t) {
        pv.push({ i: hi, p: c[hi].h, type: "H" });
        this.dir = -1;
        this.ext = t;
      }
    } else if (this.dir === 1) {
      if (k.h >= c[this.ext].h) this.ext = t;
      else if (c[this.ext].h - k.l >= thr) {
        pv.push({ i: this.ext, p: c[this.ext].h, type: "H" });
        let lo = this.ext + 1;
        for (let j = this.ext + 1; j <= t; j++) if (c[j].l < c[lo].l) lo = j;
        this.dir = -1;
        this.ext = lo;
      }
    } else {
      if (k.l <= c[this.ext].l) this.ext = t;
      else if (k.h - c[this.ext].l >= thr) {
        pv.push({ i: this.ext, p: c[this.ext].l, type: "L" });
        let hi = this.ext + 1;
        for (let j = this.ext + 1; j <= t; j++) if (c[j].h > c[hi].h) hi = j;
        this.dir = 1;
        this.ext = hi;
      }
    }
    if (pv.length > this.keep) this.pivots = pv.slice(-this.keep);
    return atr;
  }
}

/** All swing points confirmed by the end of the candles (for debugging and drawing). */
export function swingPoints(c: Candle[], stepMs: number, cfg: DetectConfig = DEFAULT_DETECT_CONFIG): (Pivot & { ts: number })[] {
  const runs = contiguousRuns(c, stepMs);
  const zz = new ZigZag(c, cfg, Infinity);
  for (let t = 0; t < c.length; t++) zz.step(t, runs[t]);
  return zz.pivots.map((p) => ({ ...p, ts: c[p.i].ts }));
}

export interface ScanResult {
  detections: Detection[];
  /** Candles examined (indices from..end). */
  scanned: number;
  /** Examined candles without enough gap-free history for ATR (start of data or after a gap). */
  skipped: number;
}

/**
 * Detects patterns whose breakout candle is in [from, end) of a sorted, de-duplicated array.
 * Swing points are built from index 0, so pass enough history before `from` (cfg.warmupBars).
 */
export function detectRange(c: Candle[], stepMs: number, from = 0, cfg: DetectConfig = DEFAULT_DETECT_CONFIG): ScanResult {
  validateConfig(cfg);
  const runs = contiguousRuns(c, stepMs);
  const detections: Detection[] = [];
  let skipped = 0;

  const zz = new ZigZag(c, cfg);
  const used = new Set<string>();

  for (let t = 0; t < c.length; t++) {
    const k = c[t];
    const atr = zz.step(t, runs[t]);
    if (atr === null) {
      if (t >= from) skipped++;
      continue;
    }
    const pv = zz.pivots;

    // ---- breakouts ----
    const buf = cfg.breakoutAtr * atr;
    const prev = c[t - 1].c;
    const crossUp = (f: (x: number) => number) => k.c > f(t) + buf && prev <= f(t - 1) + buf;
    const crossDown = (f: (x: number) => number) => k.c < f(t) - buf && prev >= f(t - 1) - buf;
    const m = matchAt(c, pv, t, atr, cfg, crossUp, crossDown);
    if (!m) continue;
    const sig = `${m.key}:${m.pivots[0].i}`;
    if (used.has(sig)) continue;
    used.add(sig);
    if (t < from) continue;
    const pt = (x: { i: number; p: number }): Pt => ({ ts: c[x.i].ts, p: r6(x.p) });
    detections.push({
      pattern: m.key,
      direction: m.direction,
      ts: k.ts,
      startTs: c[m.pivots[0].i].ts,
      candles: t - m.pivots[0].i + 1,
      meta: {
        points: m.pivots.map((x) => ({ ...pt(x), type: x.type })),
        lines: m.lines.map(([a, b]) => ({ a: pt(a), b: pt(b) })),
        level: r6(m.level),
        atr: r6(atr),
      },
    });
  }
  return { detections, scanned: Math.max(0, c.length - from), skipped };
}

const r6 = (n: number) => Number(n.toPrecision(8));
