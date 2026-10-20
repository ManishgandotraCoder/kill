// Logs the current signal of every trained model (called by the per-minute sync job), so each
// model builds a live, forward-only record. One row per model per closed candle (idempotent).

import { ensureSchema, pool } from "./db";
import { getSignal, listModels } from "./signal";

export async function recordSignals(): Promise<Record<string, number | string>> {
  await ensureSchema();
  const { rows } = await pool.query("SELECT DISTINCT symbol FROM ml_models");
  const out: Record<string, number | string> = {};
  for (const { symbol } of rows) {
    for (const m of await listModels(symbol)) {
      const key = `${symbol} ${m.label}`;
      try {
        const s = await getSignal(symbol, m.interval, m.horizon);
        const res = await pool.query(
          `INSERT INTO signal_log (symbol, interval, horizon, model_id, ts, p_up, close)
           VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
          [symbol, m.interval, m.horizon, s.model.id, s.at, s.pUp, s.close],
        );
        out[key] = res.rowCount ?? 0;
      } catch (err) {
        out[key] = `error: ${err instanceof Error ? err.message : err}`;
      }
    }
  }
  return out;
}
