import { syncAll } from "./syncCandles";

// Keeps 1h candles for every active symbol fresh while the server runs:
// fires one minute past each hour, right after the previous hour's candle closes.
// For serverless deploys, disable this (ENABLE_HOURLY_SYNC=false) and hit
// /api/sync?interval=1h from an external cron instead.

const HOUR = 3_600_000;
const OFFSET = 60_000;

const g = globalThis as unknown as { hourlySyncStarted?: boolean };

export function startHourlySync() {
  if (g.hourlySyncStarted) return;
  g.hourlySyncStarted = true;

  const run = async () => {
    try {
      console.log("[hourly-sync]", await syncAll("1h"));
    } catch (err) {
      console.error("[hourly-sync] failed", err);
    }
    schedule();
  };
  const schedule = () => {
    const now = Date.now();
    const next = Math.floor(now / HOUR) * HOUR + HOUR + OFFSET;
    setTimeout(run, next - now);
  };
  schedule();
}
