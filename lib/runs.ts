// Prediction runs: the user picks a start and end time; every 1-hour candle in
// that window gets a prediction. The model is frozen at the start (trained only
// on candles that closed before it), like switching a bot on at that moment.
// Hours that have started are filled on request and by the hourly job; nothing
// is predicted outside a run.
//
// Windows shorter than an hour ("short runs", e.g. next 15 minutes) make one
// prediction: the price at the end vs the price at the start, using the current
// hour's frozen forecast scaled to the window (move x f, range x sqrt f, like the
// chart's cone). Prices come from Binance 1-minute candles.

import { ensureSchema, pool } from "./db";
import { barBefore, ForecastError, modelAsOf, predictAfter, prepare, resolvePredictions, type Series } from "./predict";

const HOUR_MS = 3_600_000;
const MAX_HOURS = 24 * 30;
const MINUTE_MS = 60_000;
const KLINES = "https://data-api.binance.vision/api/v3/klines";

export interface RunPrediction {
  targetTs: number;
  /** 60 for a 1h candle; less for a short run (covers targetTs -> targetTs + minutes). */
  minutes: number;
  base: number;
  predicted: number;
  lower: number;
  upper: number;
  actual: number | null;
}

export interface Run {
  id: number;
  symbol: string;
  startTs: number;
  endTs: number;
  hours: number;
  status: "scheduled" | "running" | "finished";
  predictions: RunPrediction[];
}

/**
 * Windows under an hour become a short run (to the minute). Longer ones snap to
 * whole candles: first candle opening at/after start, last closing at/before end.
 */
export async function createRun(symbol: string, startMs: number, endMs: number): Promise<Run> {
  const short = endMs - startMs < HOUR_MS;
  const startTs = short ? Math.floor(startMs / MINUTE_MS) * MINUTE_MS : Math.ceil(startMs / HOUR_MS) * HOUR_MS;
  const endTs = short ? Math.floor(endMs / MINUTE_MS) * MINUTE_MS : Math.floor(endMs / HOUR_MS) * HOUR_MS;
  if (short && endTs - startTs < MINUTE_MS) throw new ForecastError("Pick a window of at least 1 minute.");
  if (!(endTs > startTs)) throw new ForecastError("The window must contain at least one full 1-hour candle.");
  if ((endTs - startTs) / HOUR_MS > MAX_HOURS) throw new ForecastError(`Keep runs to ${MAX_HOURS / 24} days or less.`);
  const s = await prepare(symbol);
  const k = barBefore(s, startTs);
  if (startTs <= s.bars[0].ts || k < 2200) throw new ForecastError("Not enough history before that start time.");
  if (startTs > s.bars[s.bars.length - 1].ts + 30 * 24 * HOUR_MS) throw new ForecastError("Start within the next 30 days.");

  const { rows } = await pool.query(
    "INSERT INTO prediction_runs (symbol, start_ts, end_ts) VALUES ($1, $2, $3) RETURNING id",
    [symbol, startTs, endTs],
  );
  await fillRun(s, rows[0].id, startTs, endTs);
  return (await listRuns(symbol)).find((r) => r.id === rows[0].id)!;
}

/** One 1-minute candle from Binance (open time `ts`), or null if not available yet. */
async function minuteCandle(symbol: string, ts: number): Promise<{ o: number; c: number } | null> {
  const res = await fetch(`${KLINES}?symbol=${symbol}&interval=1m&startTime=${ts}&limit=1`, { cache: "no-store" });
  if (!res.ok) return null;
  const [k] = (await res.json()) as [number, string, string, string, string][];
  return k && k[0] === ts ? { o: Number(k[1]), c: Number(k[4]) } : null;
}

/** Short run: once it has started, predict the price at the end from the price at the start. */
async function fillShortRun(s: Series, id: number, startTs: number, endTs: number) {
  if (Date.now() < startTs) return;
  const { rows } = await pool.query("SELECT 1 FROM predictions WHERE run_id=$1", [id]);
  if (rows.length) return;
  const k = barBefore(s, Math.floor(startTs / HOUR_MS) * HOUR_MS); // last hour closed before the hour containing start
  if (s.bars[k].ts + HOUR_MS !== Math.floor(startTs / HOUR_MS) * HOUR_MS) return; // not synced yet
  const first = await minuteCandle(s.symbol, startTs);
  if (!first) return;
  const p = predictAfter(s, k, modelAsOf(s, k));
  const f = (endTs - startTs) / HOUR_MS;
  const base = first.o;
  const mu = p.mu * f;
  const half = p.half * Math.sqrt(f);
  await pool.query(
    `INSERT INTO predictions (symbol, target_ts, base_close, predicted_close, lower, upper, source, run_id, horizon_min)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (symbol, target_ts, source) DO NOTHING`,
    [s.symbol, startTs, base, base * Math.exp(mu), base * Math.exp(mu - half), base * Math.exp(mu + half), `run:${id}`, id, (endTs - startTs) / MINUTE_MS],
  );
}

/** Short-run predictions whose window has ended get the 1-minute close at the end. */
async function resolveShort(symbol: string) {
  const { rows } = await pool.query(
    `SELECT target_ts::float8 AS t, horizon_min AS m, source FROM predictions
     WHERE symbol=$1 AND horizon_min < 60 AND actual_close IS NULL AND target_ts + horizon_min * 60000 <= $2`,
    [symbol, Date.now() - 5_000],
  );
  for (const r of rows) {
    const last = await minuteCandle(symbol, r.t + r.m * MINUTE_MS - MINUTE_MS);
    if (last) await pool.query("UPDATE predictions SET actual_close=$1 WHERE symbol=$2 AND target_ts=$3 AND source=$4", [last.c, symbol, r.t, r.source]);
  }
}

/** Predicts every candle of the run that has started and isn't stored yet. */
async function fillRun(s: Series, id: number, startTs: number, endTs: number) {
  if (endTs - startTs < HOUR_MS) return fillShortRun(s, id, startTs, endTs);
  const currentOpen = s.bars[s.bars.length - 1].ts + HOUR_MS; // the hour now in progress
  if (startTs > currentOpen) return;
  const model = modelAsOf(s, barBefore(s, startTs)); // frozen at the run's start
  const values: (number | string)[] = [];
  for (let t = startTs; t < endTs && t <= currentOpen; t += HOUR_MS) {
    const k = barBefore(s, t);
    if (s.bars[k].ts + HOUR_MS !== t) continue; // Binance gap
    const p = predictAfter(s, k, model);
    values.push(s.symbol, t, p.baseClose, p.predictedClose, p.lower, p.upper, `run:${id}`, id);
  }
  if (!values.length) return;
  const tuples = Array.from({ length: values.length / 8 }, (_, i) => `(${Array.from({ length: 8 }, (_, j) => `$${i * 8 + j + 1}`).join(",")})`);
  await pool.query(
    `INSERT INTO predictions (symbol, target_ts, base_close, predicted_close, lower, upper, source, run_id)
     VALUES ${tuples.join(",")} ON CONFLICT (symbol, target_ts, source) DO NOTHING`,
    values,
  );
}

/** All runs for a symbol, newest first, with their predictions filled and scored. */
export async function listRuns(symbol: string): Promise<Run[]> {
  await ensureSchema();
  const { rows: runs } = await pool.query(
    "SELECT id, start_ts::float8 AS start, end_ts::float8 AS end FROM prediction_runs WHERE symbol=$1 ORDER BY id DESC",
    [symbol],
  );
  if (!runs.length) return [];
  const s = await prepare(symbol);
  for (const r of runs) await fillRun(s, r.id, r.start, r.end);
  await resolvePredictions();
  await resolveShort(symbol);

  const { rows: preds } = await pool.query(
    `SELECT run_id, target_ts::float8 AS "targetTs", horizon_min AS minutes, base_close::float8 AS base, predicted_close::float8 AS predicted,
            lower::float8 AS lower, upper::float8 AS upper, actual_close::float8 AS actual
     FROM predictions WHERE run_id = ANY($1) ORDER BY target_ts`,
    [runs.map((r) => r.id)],
  );
  const now = Date.now();
  return runs.map((r) => ({
    id: r.id,
    symbol,
    startTs: r.start,
    endTs: r.end,
    hours: (r.end - r.start) / HOUR_MS, // fractional for short runs
    status: now < r.start ? "scheduled" : now < r.end ? "running" : "finished",
    predictions: preds
      .filter((p) => p.run_id === r.id)
      .map((p): RunPrediction => ({ targetTs: p.targetTs, minutes: p.minutes, base: p.base, predicted: p.predicted, lower: p.lower, upper: p.upper, actual: p.actual })),
  }));
}

export async function deleteRun(id: number): Promise<void> {
  await pool.query("DELETE FROM prediction_runs WHERE id=$1", [id]);
}

/** Hourly job: fill the new hour of every run that is in progress. */
export async function fillActiveRuns(): Promise<number> {
  await ensureSchema();
  const now = Date.now();
  const { rows } = await pool.query(
    "SELECT DISTINCT symbol FROM prediction_runs WHERE start_ts <= $1 AND end_ts > $1 - $2",
    [now, HOUR_MS],
  );
  for (const { symbol } of rows) await listRuns(symbol);
  return rows.length;
}
