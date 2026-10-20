// Background job run every minute by launchd (see scripts/com.bit.candle-sync.plist):
// saves newly closed 1m and 1h candles for every active symbol. Safe to run any time - it only
// fetches candles newer than what's in the DB, so the first run backfills 5 years of 1m candles
// (~2.6M rows per symbol, ~20 min) and later runs catch up anything missed. Then detects
// candlestick patterns in the new candles (lib/pattern-store.ts) and logs every model's signal
// (lib/signal-log.ts).
//
//   npm run sync

import { pool } from "../lib/db";
import { detectNewCandles } from "../lib/pattern-store";
import { resolveDue } from "../lib/predictions";
import { recordSignals } from "../lib/signal-log";
import { STORED_INTERVALS, syncAll } from "../lib/syncCandles";

async function main() {
  const started = new Date();
  const saved: Record<string, unknown> = {};
  for (const interval of STORED_INTERVALS) saved[interval] = await syncAll(interval);
  // Chart patterns in new 1h candles (only for symbols whose backfill was started: npm run patterns -- --interval 1h).
  saved.patterns = await detectNewCandles("1h");
  // Log each model's signal for the newest closed candle (live accuracy tracking).
  saved.signals = await recordSignals();
  // Score user-started predictions whose window just closed.
  saved.predictions = await resolveDue();
  const { rows } = await pool.query(
    "SELECT symbol, interval, to_char(MAX(time), 'YYYY-MM-DD HH24:MI TZ') AS last FROM candles GROUP BY 1, 2 ORDER BY 1, 2",
  );
  console.log(`[${started.toLocaleString()}] saved`, JSON.stringify(saved), "| last candle", rows.map((r) => `${r.symbol} ${r.interval} ${r.last}`).join(", "));
}

main()
  .catch((err) => {
    console.error(`[${new Date().toLocaleString()}] candle sync failed:`, err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
