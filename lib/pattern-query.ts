// Read side of pattern_detections for the API: query-string validation + indexed queries.

import { ensureSchema, pool } from "./db";
import { PATTERN_KEYS, type PatternKey } from "./pattern-detect";
import { INTERVALS } from "./syncCandles";

export const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 100;
/** Candles shown around a pattern in its detail view. */
const DETAIL_BEFORE = 30, DETAIL_AFTER = 30;

export class QueryError extends Error {}

export interface PatternFilter {
  symbol: string;
  interval: string;
  patterns: PatternKey[] | null;
  /** Inclusive ms UTC bounds on the completing candle's open time. */
  from: number | null;
  to: number | null;
}

/** Accepts ms since epoch or an ISO 8601 date/time. */
function parseTime(v: string | null, name: string): number | null {
  if (v === null || v === "") return null;
  const n = /^\d{1,15}$/.test(v) ? Number(v) : Date.parse(v);
  if (!Number.isFinite(n)) throw new QueryError(`Bad ${name}: use ms since epoch or ISO 8601`);
  return n;
}

export function parseFilter(p: URLSearchParams): PatternFilter {
  const symbol = (p.get("symbol") ?? "BTCUSDT").toUpperCase();
  if (!/^[A-Z0-9]{5,20}$/.test(symbol)) throw new QueryError("Bad symbol");
  const interval = p.get("interval") ?? "1m";
  if (!INTERVALS[interval]) throw new QueryError(`Bad interval: one of ${Object.keys(INTERVALS).join(", ")}`);
  const raw = p.get("pattern");
  const patterns = raw ? raw.split(",") : null;
  const bad = patterns?.find((x) => !PATTERN_KEYS.includes(x as PatternKey));
  if (bad) throw new QueryError(`Bad pattern "${bad}": one of ${PATTERN_KEYS.join(", ")}`);
  const from = parseTime(p.get("from"), "from"), to = parseTime(p.get("to"), "to");
  if (from !== null && to !== null && from > to) throw new QueryError("from is after to");
  return { symbol, interval, patterns: patterns as PatternKey[] | null, from, to };
}

export function parseLimit(p: URLSearchParams): number {
  const v = p.get("limit");
  if (v === null) return DEFAULT_LIMIT;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) throw new QueryError(`limit must be 1-${MAX_LIMIT}`);
  return n;
}

/** Keyset cursor "<ts>_<id>" of the last row of the previous page (rows go newest first). */
export function parseCursor(p: URLSearchParams): { ts: number; id: number } | null {
  const v = p.get("cursor");
  if (!v) return null;
  const m = /^(\d{1,15})_(\d{1,18})$/.exec(v);
  if (!m) throw new QueryError("Bad cursor");
  return { ts: Number(m[1]), id: Number(m[2]) };
}

function where(f: PatternFilter, params: unknown[]): string {
  params.push(f.symbol, f.interval);
  const w = ["symbol = $1", "interval = $2"];
  if (f.patterns) w.push(`pattern = ANY($${params.push(f.patterns)})`);
  if (f.from !== null) w.push(`ts >= $${params.push(f.from)}`);
  if (f.to !== null) w.push(`ts <= $${params.push(f.to)}`);
  return w.join(" AND ");
}

export interface PatternRow {
  id: number;
  pattern: PatternKey;
  direction: "bullish" | "bearish" | "neutral";
  ts: number;
  startTs: number;
  candles: number;
  open: number;
  high: number;
  low: number;
  close: number;
  meta: Record<string, number | string>;
}

const ROW = `id::float8 AS id, pattern, direction, ts::float8 AS ts, start_ts::float8 AS "startTs", candles,
  open::float8 AS open, high::float8 AS high, low::float8 AS low, close::float8 AS close, meta`;

export async function listPatterns(f: PatternFilter, limit: number, cursor: { ts: number; id: number } | null) {
  await ensureSchema();
  const params: unknown[] = [];
  let w = where(f, params);
  if (cursor) w += ` AND (ts, id) < ($${params.push(cursor.ts)}, $${params.push(cursor.id)})`;
  const { rows } = await pool.query<PatternRow>(
    `SELECT ${ROW} FROM pattern_detections WHERE ${w} ORDER BY ts DESC, id DESC LIMIT $${params.push(limit + 1)}`,
    params,
  );
  const more = rows.length > limit;
  const items = more ? rows.slice(0, limit) : rows;
  const last = items.at(-1);
  return { items, nextCursor: more && last ? `${last.ts}_${last.id}` : null };
}

export async function summarize(f: PatternFilter) {
  await ensureSchema();
  const params: unknown[] = [];
  const { rows } = await pool.query(
    `SELECT pattern, direction, count(*)::int AS count, min(ts)::float8 AS first, max(ts)::float8 AS last
     FROM pattern_detections WHERE ${where(f, params)} GROUP BY pattern, direction ORDER BY count DESC`,
    params,
  );
  const { rows: st } = await pool.query(
    `SELECT last_ts::float8 AS "lastTs", scanned::float8 AS scanned, skipped::float8 AS skipped, version, updated_at AS "updatedAt"
     FROM pattern_scan_state WHERE symbol=$1 AND interval=$2`,
    [f.symbol, f.interval],
  );
  return { patterns: rows, total: rows.reduce((a, r) => a + r.count, 0), scan: st[0] ?? null };
}

/** One detection plus the candles around it (for the detail chart). */
export async function getPattern(id: number) {
  await ensureSchema();
  const { rows } = await pool.query(`SELECT symbol, interval, ${ROW} FROM pattern_detections WHERE id=$1`, [id]);
  const d = rows[0];
  if (!d) return null;
  const step = INTERVALS[d.interval];
  const { rows: candles } = await pool.query(
    `SELECT ts::float8 AS ts, open::float8 AS o, high::float8 AS h, low::float8 AS l, close::float8 AS c, volume::float8 AS v
     FROM candles WHERE symbol=$1 AND interval=$2 AND ts BETWEEN $3 AND $4 ORDER BY ts`,
    [d.symbol, d.interval, d.startTs - DETAIL_BEFORE * step, d.ts + DETAIL_AFTER * step],
  );
  return { detection: d, candles };
}
