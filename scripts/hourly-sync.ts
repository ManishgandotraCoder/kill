// Hourly job run by launchd (see scripts/com.bit.hourly-sync.plist):
// saves newly closed 1h candles for every active symbol, then fills the new
// hour of any prediction run in progress (no automatic predictions otherwise). Safe to run any time - it only fetches
// candles newer than what's in the DB, so missed hours are caught up.
//
//   npm run sync:hourly

import { pool } from "../lib/db";
import { fillActiveRuns } from "../lib/runs";
import { syncAll } from "../lib/syncCandles";

async function main() {
  const started = new Date();
  const saved = await syncAll("1h");
  const runs = await fillActiveRuns(); // predictions only inside user-defined runs
  const { rows } = await pool.query(
    "SELECT symbol, to_char(MAX(time) + interval '1 hour', 'YYYY-MM-DD HH24:MI TZ') AS until FROM candles WHERE interval='1h' GROUP BY symbol",
  );
  console.log(`[${started.toLocaleString()}] saved`, saved, "| runs filled for", runs, "symbol(s) | data until", Object.fromEntries(rows.map((r) => [r.symbol, r.until])));
}

main()
  .catch((err) => {
    console.error(`[${new Date().toLocaleString()}] hourly sync failed:`, err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
