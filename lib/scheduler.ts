import { STORED_INTERVALS, syncAll } from "./syncCandles";

// Keeps stored candles (1m + 1h) for every active symbol fresh while the server runs:
// fires a few seconds past each minute, right after the previous minute's candle closes.
// For serverless deploys, disable this (ENABLE_HOURLY_SYNC=false) and hit
// /api/sync?interval=1m from an external cron instead.

const MINUTE = 60_000;
const OFFSET = 5_000;

const g = globalThis as unknown as { hourlySyncStarted?: boolean };

export function startHourlySync() {
  if (g.hourlySyncStarted) return;
  g.hourlySyncStarted = true;

  const run = async () => {
    try {
      for (const interval of STORED_INTERVALS) console.log(`[candle-sync ${interval}]`, await syncAll(interval));
    } catch (err) {
      console.error("[candle-sync] failed", err);
    }
    schedule();
  };
  const schedule = () => {
    const now = Date.now();
    const next = Math.floor(now / MINUTE) * MINUTE + MINUTE + OFFSET;
    setTimeout(run, next - now);
  };
  schedule();
}
