// User-started prediction sessions: "where will price be in N minutes?"
//
// start:   take the current AI signal for the window (1m-candle model with that horizon), save the call
//          (start price, up/down + probability, expected price, typical range) as a running session.
// resolve: when the 1m candle that closes at the end of the window is stored, mark the session
//          correct / wrong / flat from the real close. Run by the per-minute sync job and on every read.
// cancel:  stop a running session (kept in history as cancelled, with the price at that moment).

import { ensureSchema, pool } from "./db";
import { getSignal, SignalError } from "./signal";

export const PREDICTION_MINUTES = [10, 15, 30, 60] as const;
/** Per user. */
const MAX_RUNNING = 20;
/** Refuse to start if the newest stored 1m candle closed longer ago than this (sync not running). */
const MAX_STALE_MS = 3 * 60_000;
/** A session whose end candle never arrives (exchange gap) is marked expired after this long. */
const EXPIRE_AFTER = "1 day";
const MINUTE = 60_000;

export class PredictionError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export interface Prediction {
  id: number;
  symbol: string;
  minutes: number;
  status: "running" | "completed" | "cancelled" | "expired";
  modelId: number;
  /** Open time of the candle the call is based on; the window runs from its close (basisTs + 1 min). */
  basisTs: number;
  startPrice: number;
  endsAt: number;
  pUp: number;
  side: "up" | "down";
  lean: "up" | "down" | "none";
  expectedPrice: number;
  rangeLow: number;
  rangeHigh: number;
  meta: Record<string, unknown>;
  startedAt: number;
  endPrice: number | null;
  outcome: "correct" | "wrong" | "flat" | null;
  resolvedAt: number | null;
  cancelledAt: number | null;
  cancelPrice: number | null;
}

const COLS = `id::float8 AS id, symbol, minutes, status, model_id::float8 AS "modelId", basis_ts::float8 AS "basisTs",
  start_price::float8 AS "startPrice", (extract(epoch FROM ends_at) * 1000)::float8 AS "endsAt", p_up AS "pUp", side, lean,
  expected_price::float8 AS "expectedPrice", range_low::float8 AS "rangeLow", range_high::float8 AS "rangeHigh", meta,
  (extract(epoch FROM started_at) * 1000)::float8 AS "startedAt", end_price::float8 AS "endPrice", outcome,
  (extract(epoch FROM resolved_at) * 1000)::float8 AS "resolvedAt", (extract(epoch FROM cancelled_at) * 1000)::float8 AS "cancelledAt",
  cancel_price::float8 AS "cancelPrice"`;

export async function startPrediction(userId: number, symbol: string, minutes: number, opts: { maxStaleMs?: number } = {}): Promise<Prediction> {
  if (!(PREDICTION_MINUTES as readonly number[]).includes(minutes)) {
    throw new PredictionError(`minutes must be one of ${PREDICTION_MINUTES.join(", ")}`);
  }
  await ensureSchema();
  const { rows: run } = await pool.query("SELECT count(*)::int AS n FROM prediction_sessions WHERE status = 'running' AND user_id = $1", [userId]);
  if (run[0].n >= MAX_RUNNING) throw new PredictionError(`At most ${MAX_RUNNING} predictions can run at once - cancel one first`, 409);

  let s;
  try {
    s = await getSignal(symbol, "1m", minutes);
  } catch (err) {
    if (err instanceof SignalError) throw new PredictionError(err.message, 404);
    throw err;
  }
  const basisClose = s.at + MINUTE;
  if (Date.now() - basisClose > (opts.maxStaleMs ?? MAX_STALE_MS)) {
    throw new PredictionError("Stored candles are behind (is the sync job running?) - try again in a minute", 409);
  }
  const side = s.pUp >= 0.5 ? "up" : "down";
  const meta = {
    horizonLabel: s.horizonLabel,
    typicalMove: s.typicalMove,
    expectedMove: s.expectedMove,
    drivers: s.drivers.slice(0, 3).map((d) => ({ label: d.label, contribution: d.contribution })),
    patterns: s.patterns.map((p) => p.name),
    modelAccuracy: s.model.test.accuracy,
    modelLeanHitRate: s.model.atLean?.hitRate ?? null,
  };
  const { rows } = await pool.query<Prediction>(
    `INSERT INTO prediction_sessions (symbol, minutes, model_id, basis_ts, start_price, ends_at, p_up, side, lean,
                                      expected_price, range_low, range_high, meta, user_id)
     VALUES ($1, $2, $3, $4, $5, to_timestamp($6 / 1000.0), $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING ${COLS}`,
    [
      symbol, minutes, s.model.id, s.at, s.close, basisClose + minutes * MINUTE, s.pUp, side, s.lean,
      s.close * (1 + s.expectedMove), s.close * (1 - s.typicalMove), s.close * (1 + s.typicalMove), JSON.stringify(meta), userId,
    ],
  );
  return rows[0];
}

/** Cancels one of the user's own running predictions. */
export async function cancelPrediction(userId: number, id: number): Promise<Prediction> {
  await ensureSchema();
  const { rows } = await pool.query<Prediction>(
    `UPDATE prediction_sessions p SET status = 'cancelled', cancelled_at = now(),
       cancel_price = (SELECT close FROM candles c WHERE c.symbol = p.symbol AND c.interval = '1m' ORDER BY ts DESC LIMIT 1)
     WHERE id = $1 AND user_id = $2 AND status = 'running' RETURNING ${COLS}`,
    [id, userId],
  );
  if (rows[0]) return rows[0];
  const { rowCount } = await pool.query("SELECT 1 FROM prediction_sessions WHERE id = $1 AND user_id = $2", [id, userId]);
  throw rowCount ? new PredictionError("This prediction is not running", 409) : new PredictionError("Not found", 404);
}

/** Scores every running session whose end candle is stored; expires ones whose candle never came. */
export async function resolveDue(): Promise<{ resolved: number; expired: number }> {
  await ensureSchema();
  const done = await pool.query(
    `UPDATE prediction_sessions p SET status = 'completed', end_price = c.close, resolved_at = now(),
       outcome = CASE WHEN c.close = p.start_price THEN 'flat'
                      WHEN (c.close > p.start_price) = (p.side = 'up') THEN 'correct' ELSE 'wrong' END
     FROM candles c
     WHERE p.status = 'running' AND c.symbol = p.symbol AND c.interval = '1m' AND c.ts = p.basis_ts + p.minutes * 60000::bigint`,
  );
  const expired = await pool.query(
    `UPDATE prediction_sessions SET status = 'expired', resolved_at = now()
     WHERE status = 'running' AND ends_at < now() - interval '${EXPIRE_AFTER}'`,
  );
  return { resolved: done.rowCount ?? 0, expired: expired.rowCount ?? 0 };
}

export interface PredictionStats {
  completed: number;
  correct: number;
  accuracy: number | null;
  /** Average move in the predicted direction, basis points. */
  avgBp: number | null;
  byMinutes: { minutes: number; completed: number; accuracy: number | null }[];
  cancelled: number;
}

export async function listPredictions(userId: number, symbol: string, limit = 100): Promise<{ running: Prediction[]; history: Prediction[]; stats: PredictionStats }> {
  await resolveDue();
  const [running, history, stats] = await Promise.all([
    pool.query<Prediction>(`SELECT ${COLS} FROM prediction_sessions WHERE user_id = $1 AND symbol = $2 AND status = 'running' ORDER BY ends_at`, [userId, symbol]),
    pool.query<Prediction>(
      `SELECT ${COLS} FROM prediction_sessions WHERE user_id = $1 AND symbol = $2 AND status <> 'running' ORDER BY started_at DESC LIMIT $3`,
      [userId, symbol, limit],
    ),
    pool.query(
      `SELECT minutes,
              count(*) FILTER (WHERE status = 'completed')::int AS completed,
              count(*) FILTER (WHERE outcome = 'correct')::int AS correct,
              count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
              (avg(CASE WHEN side = 'up' THEN 1 ELSE -1 END * (end_price / start_price - 1)) FILTER (WHERE status = 'completed') * 10000)::float8 AS avg_bp
       FROM prediction_sessions WHERE user_id = $1 AND symbol = $2 GROUP BY minutes ORDER BY minutes`,
      [userId, symbol],
    ),
  ]);
  const completed = stats.rows.reduce((a, r) => a + r.completed, 0);
  const correct = stats.rows.reduce((a, r) => a + r.correct, 0);
  const bpWeighted = stats.rows.reduce((a, r) => a + (r.avg_bp ?? 0) * r.completed, 0);
  return {
    running: running.rows,
    history: history.rows,
    stats: {
      completed,
      correct,
      accuracy: completed ? correct / completed : null,
      avgBp: completed ? bpWeighted / completed : null,
      byMinutes: stats.rows.map((r) => ({ minutes: r.minutes, completed: r.completed, accuracy: r.completed ? r.correct / r.completed : null })),
      cancelled: stats.rows.reduce((a, r) => a + r.cancelled, 0),
    },
  };
}
