import { ensureSchema, pool } from "@/lib/db";
import { forecastNextHour, ForecastError, resolvePredictions } from "@/lib/predict";
import { startSync } from "@/lib/syncCandles";

const HOUR_MS = 3_600_000;

export interface PredictionRow {
  symbol: string;
  targetTs: number;
  source: string; // "auto", "manual" or "auto + manual"
  madeAt: string;
  base: number;
  predicted: number;
  lower: number;
  upper: number;
  actual: number | null;
}

export interface PredictionSummary {
  total: number;
  pending: number;
  right: number;
  wrong: number;
  inRange: number;
  outRange: number;
  avgErrorPct: number | null;
}

/** POST { symbol } -> saves the current next-hour forecast as a manual prediction. */
export async function POST(req: Request) {
  const { symbol = "" } = (await req.json().catch(() => ({}))) as { symbol?: string };
  const sym = symbol.trim().toUpperCase();
  if (!/^[A-Z0-9]{5,20}$/.test(sym)) return new Response("Bad symbol", { status: 400 });
  try {
    return Response.json(await forecastNextHour(sym, "manual"));
  } catch (err) {
    if (err instanceof ForecastError) return new Response(err.message, { status: 404 });
    throw err;
  }
}

/** GET ?symbol=&source=auto|manual -> scoreboard + latest 500 predictions. */
export async function GET(req: Request) {
  await ensureSchema();
  const p = new URL(req.url).searchParams;
  const symbol = p.get("symbol")?.toUpperCase() || null;
  const source = ["auto", "manual"].includes(p.get("source") ?? "") ? p.get("source") : null;

  // Pull in candles for hours that have finished but aren't resolved yet.
  const { rows: due } = await pool.query(
    `SELECT DISTINCT p.symbol, s.years_back FROM predictions p JOIN symbols s USING (symbol)
     WHERE p.actual_close IS NULL AND p.target_ts + $1 <= $2`,
    [HOUR_MS, Date.now()],
  );
  await Promise.all(due.map((d) => startSync(d.symbol, "1h", d.years_back).done));
  await resolvePredictions();

  // Auto and manual saves of the same hour carry the same forecast: show and count it once.
  const base = `
    WITH p AS (
      SELECT symbol, target_ts, string_agg(source, ' + ' ORDER BY source) AS source, MIN(made_at) AS made_at,
             MAX(base_close)::float8 AS base, MAX(predicted_close)::float8 AS predicted,
             MAX(lower)::float8 AS lower, MAX(upper)::float8 AS upper, MAX(actual_close)::float8 AS actual
      FROM predictions
      WHERE ($1::text IS NULL OR symbol = $1) AND ($2::text IS NULL OR source = $2)
      GROUP BY symbol, target_ts
    )`;

  const [summary, rows, symbols] = await Promise.all([
    pool.query(
      `${base}
       SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE actual IS NULL)::int AS pending,
              COUNT(*) FILTER (WHERE actual IS NOT NULL AND SIGN(predicted - base) = SIGN(actual - base))::int AS right,
              COUNT(*) FILTER (WHERE actual IS NOT NULL AND SIGN(predicted - base) <> SIGN(actual - base))::int AS wrong,
              COUNT(*) FILTER (WHERE actual BETWEEN lower AND upper)::int AS "inRange",
              COUNT(*) FILTER (WHERE actual IS NOT NULL AND actual NOT BETWEEN lower AND upper)::int AS "outRange",
              AVG(ABS(actual - predicted) / actual * 100) AS "avgErrorPct"
       FROM p`,
      [symbol, source],
    ),
    pool.query(
      `${base}
       SELECT symbol, target_ts::float8 AS "targetTs", source, made_at AS "madeAt",
              base, predicted, lower, upper, actual
       FROM p ORDER BY target_ts DESC, symbol LIMIT 500`,
      [symbol, source],
    ),
    pool.query("SELECT DISTINCT symbol FROM predictions ORDER BY symbol"),
  ]);

  return Response.json({
    summary: summary.rows[0] as PredictionSummary,
    rows: rows.rows as PredictionRow[],
    symbols: symbols.rows.map((r) => r.symbol as string),
  });
}
