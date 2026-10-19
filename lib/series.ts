// Stored 1-hour candles for a symbol, cached in memory (used by pattern discovery).

import { ensureSchema, pool } from "./db";
import { startSync } from "./syncCandles";

const HOUR_MS = 3_600_000;
const MIN_CANDLES = 500;

export interface Bar {
  ts: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

/** [openTime ms, open, high, low, close] */
export type MiniCandle = [number, number, number, number, number];

/** A problem the user can fix (unknown symbol, not enough data, ...). */
export class DataError extends Error {}

export interface Series {
  symbol: string;
  bars: Bar[];
  /** gaps[i] = number of missing hours between bars[0] and bars[i]. */
  gaps: Int32Array;
}

const g = globalThis as unknown as { candleSeries?: Map<string, Series> };
const cache: Map<string, Series> = (g.candleSeries ??= new Map());

async function loadSeries(symbol: string): Promise<Series> {
  const { rows: head } = await pool.query(
    "SELECT COUNT(*)::int AS n, MAX(ts)::float8 AS last FROM candles WHERE symbol=$1 AND interval='1h'",
    [symbol],
  );
  const cached = cache.get(symbol);
  if (cached && cached.bars.length === head[0].n && cached.bars.at(-1)?.ts === head[0].last) return cached;

  const { rows } = await pool.query(
    `SELECT ts::float8 AS ts, open::float8 AS o, high::float8 AS h, low::float8 AS l,
            close::float8 AS c, volume::float8 AS v
     FROM candles WHERE symbol=$1 AND interval='1h' ORDER BY ts`,
    [symbol],
  );
  const bars = rows as Bar[];
  const n = bars.length;
  const gaps = new Int32Array(n);
  for (let i = 1; i < n; i++) gaps[i] = gaps[i - 1] + (bars[i].ts - bars[i - 1].ts !== HOUR_MS ? 1 : 0);
  const series: Series = { symbol, bars, gaps };
  cache.set(symbol, series);
  return series;
}

/** Syncs the DB and returns the cached 1h series for a symbol. */
export async function prepare(symbol: string): Promise<Series> {
  await ensureSchema();
  const { rows: sym } = await pool.query("SELECT years_back FROM symbols WHERE symbol=$1", [symbol]);
  if (!sym.length) throw new DataError(`${symbol} is not in the symbols table - add it with: INSERT INTO symbols (symbol) VALUES ('${symbol}')`);

  const synced = await startSync(symbol, "1h", sym[0].years_back).done;
  if (synced.status === "error") throw new DataError(`Sync failed: ${synced.error}`);

  const s = await loadSeries(symbol);
  if (s.bars.length < MIN_CANDLES) {
    throw new DataError(`Need at least ${MIN_CANDLES} hourly candles of ${symbol} in the DB (have ${s.bars.length})`);
  }
  return s;
}

/** Index of the last bar that opened before `ts` (i.e. closed at or before it). */
export function barBefore(s: Series, ts: number): number {
  let lo = 0, hi = s.bars.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (s.bars[mid].ts < ts) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
