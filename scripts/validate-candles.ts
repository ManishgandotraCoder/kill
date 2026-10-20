// Data checks on stored candles before pattern detection: counts, range, invalid OHLC, gaps,
// alignment and whether the newest candle has closed. Runs in SQL - nothing is loaded into memory.
//
//   npm run validate -- [--symbol BTCUSDT] [--interval 1m]

import { pool } from "../lib/db";
import { INTERVALS } from "../lib/syncCandles";

const args = process.argv.slice(2);
const opt = (name: string, def: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};

async function main() {
  const symbol = opt("symbol", "BTCUSDT").toUpperCase();
  const interval = opt("interval", "1m");
  const step = INTERVALS[interval];
  if (!step) throw new Error(`Unknown interval ${interval}`);
  const p = [symbol, interval];

  const { rows: [s] } = await pool.query(
    `SELECT count(*)::int AS candles, min(ts)::float8 AS first, max(ts)::float8 AS last,
            count(*) FILTER (WHERE high < low OR high < greatest(open, close) OR low > least(open, close) OR low <= 0 OR volume < 0)::int AS invalid_ohlc,
            count(*) FILTER (WHERE ts % $3 <> 0)::int AS misaligned,
            count(*) FILTER (WHERE high = low)::int AS zero_range,
            count(*) FILTER (WHERE open = close)::int AS equal_open_close
     FROM candles WHERE symbol=$1 AND interval=$2`, [...p, step]);
  if (!s.candles) throw new Error(`No ${symbol} ${interval} candles`);

  const { rows: gaps } = await pool.query(
    `SELECT ts::float8 AS resumes, (diff / $3 - 1)::int AS missing FROM (
       SELECT ts, ts - lag(ts) OVER (ORDER BY ts) AS diff FROM candles WHERE symbol=$1 AND interval=$2) d
     WHERE diff <> $3 ORDER BY diff DESC`, [...p, step]);
  const expected = (s.last - s.first) / step + 1;
  const iso = (t: number) => new Date(t).toISOString();

  console.log({
    symbol, interval,
    timestamps: "ts = open time, BIGINT ms since epoch (UTC); 'time' column is derived TIMESTAMPTZ",
    unique: "PRIMARY KEY (symbol, interval, ts) - duplicates impossible",
    candles: s.candles, expected, first: iso(s.first), last: iso(s.last),
    newest_closed: s.last + step <= Date.now(),
    invalid_ohlc: s.invalid_ohlc, misaligned: s.misaligned, zero_range: s.zero_range, equal_open_close: s.equal_open_close,
    gaps: gaps.length, missing_candles: gaps.reduce((a, g) => a + g.missing, 0),
    largest_gaps: gaps.slice(0, 5).map((g) => `${g.missing} missing before ${iso(g.resumes)}`),
  });
}

main().finally(() => pool.end());
