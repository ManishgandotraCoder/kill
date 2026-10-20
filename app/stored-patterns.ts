import type { PatternDirection, PatternKey, PatternMeta } from "@/lib/pattern-detect";

/** Timeframes the detector runs on (scripts/detect-patterns.ts --interval ...). */
export const STORED_PATTERN_INTERVALS = ["1h"];
export const hasStoredPatterns = (interval: string) => STORED_PATTERN_INTERVALS.includes(interval);

/** A row of GET /api/patterns. */
export interface StoredPattern {
  id: number;
  pattern: PatternKey;
  direction: PatternDirection;
  /** Open time of the completing candle, ms UTC. */
  ts: number;
  startTs: number;
  candles: number;
  open: number;
  high: number;
  low: number;
  close: number;
  meta: PatternMeta;
}
