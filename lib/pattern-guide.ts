// Data for the Pattern guide page: per pattern, how often it was detected, its latest real example,
// and what price did after the breakout (from the 1h models' pattern stats - the same 1h candles the
// stored patterns come from) vs. after any candle.

import { ensureSchema, pool } from "./db";
import { duration } from "./ml-features";
import { PATTERN_INFO, PATTERN_KEYS, type PatternKey } from "./pattern-detect";

export interface Outcome {
  /** e.g. "15 min", "1 d". */
  label: string;
  interval: string;
  n: number;
  upRate: number;
  avgBp: number;
  baseUpRate: number;
  baseAvgBp: number;
  /** Whether the difference from the baseline is bigger than chance (2 standard errors). */
  verdict: "as-textbook" | "opposite" | "leans-up" | "leans-down" | "no-clear-effect";
}

export interface GuideEntry {
  key: PatternKey;
  counts: Record<string, number>;
  /** Latest detection id per timeframe, for the real-example chart. */
  latest: Record<string, number>;
  outcomes: Outcome[];
}

interface ModelRow {
  interval: string;
  minutes: number;
  baseline: { upRate: number; avgBp: number } | null;
  stats: { pattern: PatternKey; n: number; upRate: number; avgBp: number }[];
}

function verdict(key: PatternKey, upRate: number, base: number, n: number): Outcome["verdict"] {
  const se = Math.sqrt((base * (1 - base)) / Math.max(n, 1));
  const diff = upRate - base;
  if (Math.abs(diff) < 2 * se) return "no-clear-effect";
  const dir = PATTERN_INFO[key].direction;
  if (dir === "neutral") return diff > 0 ? "leans-up" : "leans-down";
  return (diff > 0) === (dir === "bullish") ? "as-textbook" : "opposite";
}

export async function patternGuide(symbol: string): Promise<{ symbol: string; patterns: GuideEntry[] }> {
  await ensureSchema();
  const [counts, latest, models] = await Promise.all([
    pool.query("SELECT interval, pattern, count(*)::int AS n FROM pattern_detections WHERE symbol=$1 GROUP BY 1, 2", [symbol]),
    pool.query(
      `SELECT DISTINCT ON (interval, pattern) interval, pattern, id::float8 AS id
       FROM pattern_detections WHERE symbol=$1 ORDER BY interval, pattern, ts DESC`,
      [symbol],
    ),
    pool.query<ModelRow>(
      `SELECT DISTINCT ON (interval, horizon) interval, (metrics->>'horizonMinutes')::float8 AS minutes,
              metrics->'baseline' AS baseline, metrics->'patternStats' AS stats
       FROM ml_models WHERE symbol=$1 AND interval = '1h' ORDER BY interval, horizon, created_at DESC`,
      [symbol],
    ),
  ]);
  const usable = models.rows.filter((m) => m.baseline).sort((a, b) => a.minutes - b.minutes);

  return {
    symbol,
    patterns: PATTERN_KEYS.map((key) => ({
      key,
      counts: Object.fromEntries(counts.rows.filter((r) => r.pattern === key).map((r) => [r.interval, r.n])),
      latest: Object.fromEntries(latest.rows.filter((r) => r.pattern === key).map((r) => [r.interval, r.id])),
      outcomes: usable.flatMap((m) => {
        const s = m.stats.find((x) => x.pattern === key);
        if (!s || !s.n || !m.baseline) return [];
        return [{
          label: duration(m.minutes), interval: m.interval, n: s.n, upRate: s.upRate, avgBp: s.avgBp,
          baseUpRate: m.baseline.upRate, baseAvgBp: m.baseline.avgBp, verdict: verdict(key, s.upRate, m.baseline.upRate, s.n),
        }];
      }),
    })),
  };
}
