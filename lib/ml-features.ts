// Model inputs for the up/down model (lib/ml-model.ts). Pure; used identically for training
// (scripts/train-model.ts) and live signals (lib/signal.ts), so there is no train/serve skew.
//
// Every feature at candle i reads candles <= i only. Price features are scaled by recent
// volatility (avg range of the last 20 candles) so the model works across price levels.
// The same feature list is used for every timeframe; only the return lookbacks differ (FeatureSpec).

import { contiguousRuns, detectRange, PATTERN_INFO, PATTERN_KEYS, type Candle, type PatternKey } from "./pattern-detect";

export interface CandleV extends Candle {
  v: number;
}

export interface FeatureDef {
  key: string;
  /** Plain-English label (UI + LLM prompt). */
  label: string;
}

export interface FeatureSpec {
  interval: string;
  /** Lookbacks (in candles) of the return features. */
  returns: number[];
  /** Gap-free history a candle needs before it gets features (longest lookback + 1). */
  history: number;
  features: FeatureDef[];
}

/** Return lookbacks per candle timeframe: 1m -> 1, 5, 15 min, 1 h, 4 h; 1h -> 1 h, 4 h, 1 d, 3 d, 1 w. */
const RETURNS: Record<string, number[]> = { "1m": [1, 5, 15, 60, 240], "1h": [1, 4, 24, 72, 168] };
const MINUTES: Record<string, number> = { "1m": 1, "1h": 60 };

/** Human duration, e.g. 90 -> "1.5 h", 1440 -> "1 d". */
export function duration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 1440) return `${+(minutes / 60).toFixed(1)} h`;
  if (minutes % 10080 === 0) return `${minutes / 10080} w`;
  return `${+(minutes / 1440).toFixed(1)} d`;
}

export const MODEL_INTERVALS = Object.keys(RETURNS);

export function featureSpec(interval: string): FeatureSpec {
  const returns = RETURNS[interval];
  if (!returns) throw new Error(`No feature spec for ${interval} candles (have ${MODEL_INTERVALS.join(", ")})`);
  const unit = MINUTES[interval];
  return { interval, returns, history: Math.max(...returns) + 1, features: featureDefs(returns, unit) };
}

const featureDefs = (returns: number[], unit: number): FeatureDef[] => [
  ...PATTERN_KEYS.map((k) => ({ key: `pat_${k}`, label: `${PATTERN_INFO[k].name} broke out on this candle` })),
  ...returns.map((n) => ({ key: `ret_${n}`, label: `Move over last ${duration(n * unit)} (in volatility units)` })),
  { key: "volatility", label: "Volatility level (log avg range / price)" },
  { key: "range_ratio", label: "Last candle's range vs average" },
  { key: "body", label: "Last candle body (+green / -red, share of range)" },
  { key: "upper_wick", label: "Last candle upper wick share" },
  { key: "lower_wick", label: "Last candle lower wick share" },
  { key: "volume_ratio", label: "Volume vs 20-candle average (log)" },
  { key: "pos_60", label: `Position in last-${duration(60 * unit)} range (-0.5 low .. +0.5 high)` },
  { key: "hour_sin", label: "Time of day (sin, UTC)" },
  { key: "hour_cos", label: "Time of day (cos, UTC)" },
  { key: "weekend", label: "Weekend" },
];

/** Same count for every timeframe. */
export const N_FEATURES = featureDefs([0, 0, 0, 0, 0], 1).length;
const PAT_INDEX = new Map<PatternKey, number>(PATTERN_KEYS.map((k, i) => [k, i]));

/** Pattern bitmask per candle (bit i = PATTERN_KEYS[i] completed at that candle). */
export function patternMasks(c: Candle[], stepMs: number): Int32Array {
  const masks = new Int32Array(c.length);
  const { detections } = detectRange(c, stepMs);
  let j = 0;
  for (const d of detections) {
    while (c[j].ts < d.ts) j++; // detections are in candle order
    masks[j] |= 1 << PAT_INDEX.get(d.pattern)!;
  }
  return masks;
}

/**
 * Writes the features of candle i into out[offset..offset+N_FEATURES). Returns false (and writes
 * nothing) when the candle lacks spec.history gap-free candles. `runs` = contiguousRuns(c).
 */
export function featuresAt(
  spec: FeatureSpec, c: CandleV[], runs: Int32Array, masks: Int32Array, i: number, out: Float32Array | number[], offset = 0,
): boolean {
  if (i < 0 || i >= c.length || runs[i] < spec.history) return false;
  const k = c[i];
  let sumRange = 0, sumVol = 0;
  for (let j = i - 20; j < i; j++) {
    sumRange += c[j].h - c[j].l;
    sumVol += c[j].v;
  }
  const avgRange = sumRange / 20, avgVol = sumVol / 20;
  const volRel = Math.max(avgRange / k.c, 1e-6);
  let lo = Infinity, hi = -Infinity;
  for (let j = i - 59; j <= i; j++) {
    if (c[j].l < lo) lo = c[j].l;
    if (c[j].h > hi) hi = c[j].h;
  }
  const range = k.h - k.l;
  const d = new Date(k.ts);
  const hour = (d.getUTCHours() + d.getUTCMinutes() / 60) / 24;

  let f = offset;
  for (let p = 0; p < PATTERN_KEYS.length; p++) out[f++] = masks[i] & (1 << p) ? 1 : 0;
  for (const n of spec.returns) out[f++] = Math.log(k.c / c[i - n].c) / volRel;
  out[f++] = Math.log(volRel);
  out[f++] = avgRange > 0 ? range / avgRange : 1;
  out[f++] = range > 0 ? (k.c - k.o) / range : 0;
  out[f++] = range > 0 ? (k.h - Math.max(k.o, k.c)) / range : 0;
  out[f++] = range > 0 ? (Math.min(k.o, k.c) - k.l) / range : 0;
  out[f++] = Math.log((k.v + 1e-9) / (avgVol + 1e-9));
  out[f++] = hi > lo ? (k.c - lo) / (hi - lo) - 0.5 : 0;
  out[f++] = Math.sin(2 * Math.PI * hour);
  out[f++] = Math.cos(2 * Math.PI * hour);
  out[f++] = d.getUTCDay() === 0 || d.getUTCDay() === 6 ? 1 : 0;
  return true;
}

/** Label for candle i: future return over `horizon` candles, or null if that candle is missing. */
export function futureReturn(c: Candle[], i: number, horizon: number, stepMs: number): number | null {
  const j = i + horizon;
  if (j >= c.length || c[j].ts !== c[i].ts + horizon * stepMs) return null;
  return c[j].c / c[i].c - 1;
}

export { contiguousRuns };
