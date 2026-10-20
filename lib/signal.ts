// Live up/down signal: newest model from ml_models applied to the newest closed candles,
// with the model's out-of-sample record attached so the number is never shown without context.

import { ensureSchema, pool } from "./db";
import { contiguousRuns, duration, featureSpec, featuresAt, MODEL_INTERVALS, N_FEATURES, patternMasks, type CandleV } from "./ml-features";
import { contributions, predict, type LinearModel, type TradeStats } from "./ml-model";
import { DEFAULT_DETECT_CONFIG, PATTERN_INFO, PATTERN_KEYS, type PatternKey } from "./pattern-detect";
import { INTERVALS } from "./syncCandles";

/** Probability at which the signal "leans" up (or 1 - this for down). */
export const LEAN_THRESHOLD = 0.53;

export class SignalError extends Error {}

interface StoredModel {
  id: number;
  horizon: number;
  features: string[];
  model: LinearModel;
  metrics: {
    feeBpPerSide: number;
    horizonMinutes: number;
    evaluation?: string;
    test: {
      from: number; to: number; n: number; accuracy: number; accuracySe?: number; upRate: number; auc: number;
      trades: TradeStats[]; tradesSpaced?: TradeStats[];
    };
    patternStats: { pattern: PatternKey; n: number; upRate: number; avgBp: number }[];
  };
  created_at: string;
}

async function latestModel(symbol: string, interval: string, horizon: number): Promise<StoredModel> {
  await ensureSchema();
  const { rows } = await pool.query<StoredModel>(
    `SELECT id::int AS id, horizon, features, model, metrics, created_at FROM ml_models
     WHERE symbol=$1 AND interval=$2 AND horizon=$3 ORDER BY created_at DESC LIMIT 1`,
    [symbol, interval, horizon],
  );
  const m = rows[0];
  const cmd = `npm run train -- --symbol ${symbol} --interval ${interval} --horizon ${horizon}`;
  if (!m) throw new SignalError(`No trained model for ${symbol} ${interval} x${horizon} - run: ${cmd}`);
  if (m.features.join() !== featureSpec(interval).features.map((f) => f.key).join()) {
    throw new SignalError(`The saved model was trained on different features - retrain with: ${cmd}`);
  }
  return m;
}

export interface ModelSummary {
  interval: string;
  horizon: number;
  horizonMinutes: number;
  label: string;
  accuracy: number;
}

/** Newest model per timeframe/horizon for a symbol, shortest horizon first. */
export async function listModels(symbol: string): Promise<ModelSummary[]> {
  await ensureSchema();
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (interval, horizon) interval, horizon, (metrics->>'horizonMinutes')::float8 AS minutes,
            (metrics->'test'->>'accuracy')::float8 AS accuracy
     FROM ml_models WHERE symbol=$1 AND interval = ANY($2) ORDER BY interval, horizon, created_at DESC`,
    [symbol, MODEL_INTERVALS],
  );
  return rows
    .map((r) => ({ interval: r.interval, horizon: r.horizon, horizonMinutes: r.minutes, label: duration(r.minutes), accuracy: r.accuracy }))
    .sort((a, b) => a.horizonMinutes - b.horizonMinutes);
}

export interface Signal {
  symbol: string;
  interval: string;
  horizon: number;
  horizonMinutes: number;
  /** e.g. "15 min", "4 h", "1 d". */
  horizonLabel: string;
  /** Open time of the last closed candle used (ms UTC); the forecast window starts at its close. */
  at: number;
  close: number;
  pUp: number;
  lean: "up" | "down" | "none";
  /** Model candle length (ms); the forecast window runs from at + stepMs to at + stepMs + horizon * stepMs. */
  stepMs: number;
  /** Mean absolute price change over one horizon in the recent candles (fraction, e.g. 0.002 = 0.2%). */
  typicalMove: number;
  /**
   * Expected change implied by the model, approximated as (2 pUp - 1) x typicalMove (fraction).
   * Small by construction: a 53% call on a 0.2% typical move is a 0.012% tilt.
   */
  expectedMove: number;
  drivers: { key: string; label: string; value: number; contribution: number }[];
  patterns: { pattern: PatternKey; name: string; direction: string; historicalUpRate: number; historicalAvgBp: number; n: number }[];
  model: {
    id: number;
    trainedAt: string;
    test: { from: number; to: number; n: number; accuracy: number; accuracySe: number | null; upRate: number; auc: number };
    evaluation: string;
    /** Out-of-sample trades taken when the model leaned (non-overlapping when available). */
    atLean: TradeStats | null;
    feeBpRoundTrip: number;
  };
  /** Forward-only record of this model's logged live signals (signal_log). */
  live: LiveRecord;
  recent: { ts: number; o: number; h: number; l: number; c: number; v: number }[];
}

export interface LiveRecord {
  since: number | null;
  /** Signals whose window has closed (unchanged-price windows left out). */
  checked: number;
  accuracy: number | null;
  /** Of those, the ones where the model leaned (overlapping windows on short timeframes). */
  leaned: number;
  leanHitRate: number | null;
  leanAvgBp: number | null;
  /** Logged signals still waiting for their window to close. */
  pending: number;
}

/** Live record of one model: logged signals joined to the candle `horizon` steps later. */
export async function liveRecord(symbol: string, interval: string, horizon: number, modelId: number): Promise<LiveRecord> {
  const step = INTERVALS[interval];
  const { rows } = await pool.query(
    `SELECT min(l.ts)::float8 AS since,
            count(f.ts) FILTER (WHERE f.close <> l.close)::int AS checked,
            avg(((f.close > l.close) = (l.p_up >= 0.5))::int) FILTER (WHERE f.close <> l.close)::float8 AS accuracy,
            count(f.ts) FILTER (WHERE f.close <> l.close AND (l.p_up >= $5 OR l.p_up <= 1 - $5))::int AS leaned,
            avg(((f.close > l.close) = (l.p_up >= 0.5))::int) FILTER (WHERE f.close <> l.close AND (l.p_up >= $5 OR l.p_up <= 1 - $5))::float8 AS lean_hit,
            (avg(CASE WHEN l.p_up >= 0.5 THEN 1 ELSE -1 END * (f.close / l.close - 1)) FILTER (WHERE l.p_up >= $5 OR l.p_up <= 1 - $5) * 10000)::float8 AS lean_bp,
            count(*) FILTER (WHERE f.ts IS NULL)::int AS pending
     FROM signal_log l
     LEFT JOIN candles f ON f.symbol = l.symbol AND f.interval = l.interval AND f.ts = l.ts + l.horizon * $6::bigint
     WHERE l.symbol=$1 AND l.interval=$2 AND l.horizon=$3 AND l.model_id=$4`,
    [symbol, interval, horizon, modelId, LEAN_THRESHOLD, step],
  );
  const r = rows[0];
  return {
    since: r.since, checked: r.checked, accuracy: r.accuracy, leaned: r.leaned,
    leanHitRate: r.lean_hit, leanAvgBp: r.lean_bp, pending: r.pending,
  };
}

export async function getSignal(symbol: string, interval = "1m", horizon = 15): Promise<Signal> {
  const spec = featureSpec(interval);
  const m = await latestModel(symbol, interval, horizon);
  const step = INTERVALS[interval];
  const { rows } = await pool.query<CandleV>(
    `SELECT ts::float8 AS ts, open::float8 AS o, high::float8 AS h, low::float8 AS l, close::float8 AS c, volume::float8 AS v
     FROM candles WHERE symbol=$1 AND interval=$2 AND ts + $3 <= $4 ORDER BY ts DESC LIMIT $5`,
    // Chart patterns need their swing points rebuilt exactly as in training: load the warm-up too.
    [symbol, interval, step, Date.now(), spec.history + DEFAULT_DETECT_CONFIG.warmupBars],
  );
  const c = rows.reverse();
  if (!c.length) throw new SignalError(`No ${symbol} candles stored`);
  const i = c.length - 1;
  const x = new Array<number>(N_FEATURES);
  if (!featuresAt(spec, c, contiguousRuns(c, step), patternMasks(c, step), i, x)) {
    throw new SignalError("Not enough gap-free recent candles (a sync may be catching up)");
  }

  const pUp = predict(m.model, x);
  // Typical size of a horizon-long move in the loaded recent candles (gap-free windows only).
  let sumAbs = 0, windows = 0;
  for (let j = 0; j + horizon < c.length; j++) {
    if (c[j + horizon].ts !== c[j].ts + horizon * step) continue;
    sumAbs += Math.abs(c[j + horizon].c / c[j].c - 1);
    windows++;
  }
  const typicalMove = windows ? sumAbs / windows : 0;
  const contrib = contributions(m.model, x);
  const stats = new Map(m.metrics.patternStats.map((s) => [s.pattern, s]));
  const patterns = PATTERN_KEYS.filter((_, p) => x[p] === 1).map((k) => {
    const s = stats.get(k)!;
    return { pattern: k, name: PATTERN_INFO[k].name, direction: PATTERN_INFO[k].direction, historicalUpRate: s.upRate, historicalAvgBp: s.avgBp, n: s.n };
  });
  const t = m.metrics.test;
  const leanTrades = t.tradesSpaced ?? t.trades;
  return {
    symbol,
    interval,
    horizon,
    horizonMinutes: m.metrics.horizonMinutes ?? m.horizon,
    horizonLabel: duration(m.metrics.horizonMinutes ?? m.horizon),
    at: c[i].ts,
    close: c[i].c,
    pUp,
    lean: pUp >= LEAN_THRESHOLD ? "up" : pUp <= 1 - LEAN_THRESHOLD ? "down" : "none",
    stepMs: step,
    typicalMove,
    expectedMove: (2 * pUp - 1) * typicalMove,
    drivers: spec.features.map((f, j) => ({ key: f.key, label: f.label, value: x[j], contribution: contrib[j] }))
      .filter((d) => d.contribution !== 0)
      .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
      .slice(0, 6),
    patterns,
    model: {
      id: m.id,
      trainedAt: m.created_at,
      test: { from: t.from, to: t.to, n: t.n, accuracy: t.accuracy, accuracySe: t.accuracySe ?? null, upRate: t.upRate, auc: t.auc },
      evaluation: m.metrics.evaluation ?? "single test period",
      atLean: leanTrades.find((x) => x.threshold === LEAN_THRESHOLD) ?? null,
      feeBpRoundTrip: 2 * m.metrics.feeBpPerSide,
    },
    live: await liveRecord(symbol, interval, horizon, m.id),
    recent: c.slice(-30),
  };
}
