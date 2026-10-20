// Textbook example of each chart pattern, as a price path through key points [candle index, price].
// exampleCandles() turns a path into hourly candles; lib/pattern-detect.ts must detect each example
// as its own pattern (checked in tests/pattern-detect.test.ts), and the Pattern guide draws the
// detector's own swing points and trendlines on it - so the pictures always match the rules.

import { PATTERN_KEYS, type Candle, type PatternKey } from "./pattern-detect";

type Path = [number, number][];

/** Flips a path upside down around `mid` (turns a bearish example into its bullish twin). */
const mirror = (path: Path, mid = 120): Path => path.map(([x, y]) => [x, 2 * mid - y]);

const BEARISH: Partial<Record<PatternKey, Path>> = {
  double_top: [[0, 100], [20, 130], [32, 118], [44, 130], [64, 105]],
  triple_top: [[0, 100], [20, 130], [32, 118], [44, 130], [56, 118], [68, 130], [90, 105]],
  head_and_shoulders: [[0, 100], [20, 125], [32, 113], [50, 140], [68, 113], [80, 125], [100, 100]],
  rising_wedge: [[0, 100], [10, 120], [20, 106], [40, 128], [55, 121], [70, 136], [90, 86]],
  bear_flag: mirror([[0, 100], [20, 140], [30, 130], [40, 136], [50, 126], [65, 146]]),
  bear_pennant: mirror([[0, 100], [20, 140], [30, 128], [40, 137], [50, 132], [60, 146]]),
  descending_triangle: mirror([[0, 100], [15, 130], [30, 108], [50, 130], [65, 118], [80, 130], [88, 125], [100, 140]]),
  bearish_expanding_triangle: [[0, 120], [10, 130], [20, 115], [35, 135], [50, 108], [70, 140], [90, 90]],
};

export const PATTERN_EXAMPLES: Record<PatternKey, Path> = {
  double_top: BEARISH.double_top!,
  double_bottom: mirror(BEARISH.double_top!),
  triple_top: BEARISH.triple_top!,
  triple_bottom: mirror(BEARISH.triple_top!),
  head_and_shoulders: BEARISH.head_and_shoulders!,
  inverse_head_and_shoulders: mirror(BEARISH.head_and_shoulders!),
  rising_wedge: BEARISH.rising_wedge!,
  falling_wedge: mirror(BEARISH.rising_wedge!),
  bull_flag: mirror(BEARISH.bear_flag!),
  bear_flag: BEARISH.bear_flag!,
  bull_pennant: mirror(BEARISH.bear_pennant!),
  bear_pennant: BEARISH.bear_pennant!,
  ascending_triangle: mirror(BEARISH.descending_triangle!),
  descending_triangle: BEARISH.descending_triangle!,
  symmetrical_triangle: [[0, 120], [10, 140], [30, 100], [50, 132], [70, 108], [90, 124], [105, 100]],
  bullish_expanding_triangle: mirror(BEARISH.bearish_expanding_triangle!),
  bearish_expanding_triangle: BEARISH.bearish_expanding_triangle!,
};

/** Quiet candles before each path so ATR is ready when the pattern starts. */
export const EXAMPLE_PREROLL = 20;
const WICK = 0.2;
const HOUR = 3_600_000;

/**
 * Candles following a path: a 20-candle quiet pre-roll, then one candle per index whose close
 * follows the straight segments between points (open = previous close, small wicks).
 */
export function exampleCandles(path: Path, stepMs = HOUR, t0 = Date.UTC(2024, 0, 1)): Candle[] {
  const closes: number[] = [];
  for (let i = 0; i < EXAMPLE_PREROLL; i++) closes.push(path[0][1] + (i % 2 ? 0.3 : -0.3));
  for (let s = 0; s < path.length - 1; s++) {
    const [x0, y0] = path[s], [x1, y1] = path[s + 1];
    for (let x = x0; x < x1; x++) closes.push(y0 + ((y1 - y0) * (x - x0)) / (x1 - x0));
  }
  closes.push(path[path.length - 1][1]);
  return closes.map((c, i) => {
    const o = i ? closes[i - 1] : c;
    return { ts: t0 + i * stepMs, o, c, h: Math.max(o, c) + WICK, l: Math.min(o, c) - WICK };
  });
}

export const EXAMPLE_KEYS = PATTERN_KEYS;
