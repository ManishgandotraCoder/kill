import { ensureSchema, pool } from "@/lib/db";
import { INTERVALS, runningSyncs } from "@/lib/syncCandles";

const MAX_ROWS = 50_000;

/**
 * GET /api/candles               -> what's stored: per symbol/interval counts + range, running syncs
 * GET /api/candles?symbol=&interval= -> candles as [timeSec, o, h, l, c, v][] (latest MAX_ROWS)
 */
export async function GET(req: Request) {
  await ensureSchema();
  const p = new URL(req.url).searchParams;
  const symbol = p.get("symbol")?.toUpperCase();
  const interval = p.get("interval") ?? "1h";

  if (!symbol) {
    const [symbols, stats] = await Promise.all([
      pool.query("SELECT symbol, active, years_back FROM symbols ORDER BY symbol"),
      pool.query(
        `SELECT symbol, interval, COUNT(*)::int AS count, MIN(ts)::float8 AS first, MAX(ts)::float8 AS last
         FROM candles GROUP BY symbol, interval ORDER BY symbol, interval`,
      ),
    ]);
    return Response.json({ symbols: symbols.rows, stats: stats.rows, running: runningSyncs() });
  }

  if (!INTERVALS[interval]) return new Response("Bad interval", { status: 400 });

  const { rows } = await pool.query(
    `SELECT * FROM (
       SELECT ts / 1000 AS t, open::float8 AS o, high::float8 AS h, low::float8 AS l,
              close::float8 AS c, volume::float8 AS v
       FROM candles WHERE symbol=$1 AND interval=$2 ORDER BY ts DESC LIMIT $3
     ) x ORDER BY t`,
    [symbol, interval, MAX_ROWS],
  );
  return Response.json({
    candles: rows.map((r) => [Number(r.t), r.o, r.h, r.l, r.c, r.v]),
    truncated: rows.length === MAX_ROWS,
  });
}
