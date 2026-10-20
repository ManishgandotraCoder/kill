// Runs lib/pattern-detect.ts over stored candles and saves the results in pattern_detections.
//
// - Keyset iteration: pages of `pageSize` candles ordered by ts (no per-candle queries).
// - Each page's inserts and the checkpoint update commit in one transaction, so an
//   interrupted run resumes from the last committed page and reruns never duplicate
//   (UNIQUE (symbol, interval, ts, pattern) + ON CONFLICT DO NOTHING).
// - Only closed candles are scanned (candle close time <= now).
// - One run per symbol+interval at a time (Postgres advisory lock).

import type { PoolClient } from "pg";
import { ensureSchema, pool } from "./db";
import { DEFAULT_DETECT_CONFIG, DETECTOR_VERSION, detectRange, prepareCandles, type Candle, type DetectConfig, type Detection, type PatternKey } from "./pattern-detect";
import { INTERVALS } from "./syncCandles";

export interface RunOptions {
  symbol: string;
  interval: string;
  /** "backfill" starts from the beginning if there is no checkpoint; "incremental" does nothing without one. */
  mode: "backfill" | "incremental";
  /** Detect and report, write nothing. */
  dryRun?: boolean;
  /** Stop after this many candles (handy with dryRun). */
  limit?: number;
  /** Delete this symbol+interval's detections and checkpoint first (needed after changing the config/version). */
  reset?: boolean;
  pageSize?: number;
  config?: DetectConfig;
  onPage?: (r: RunReport) => void;
}

export interface RunReport {
  symbol: string;
  interval: string;
  status: "done" | "dry-run" | "no-checkpoint" | "busy" | "error";
  dryRun: boolean;
  scanned: number;
  /** Patterns detected in this run. */
  found: number;
  /** Newly stored (found minus ones already in the table). */
  inserted: number;
  /** Candles without enough gap-free history to test. */
  skipped: number;
  /** Rows dropped as invalid or duplicate before detection. */
  invalid: number;
  errors: string[];
  byPattern: Partial<Record<PatternKey, number>>;
  /** Last scanned candle (ms UTC). */
  lastTs: number | null;
  sample: Detection[];
  ms: number;
}

interface ScanState {
  version: number;
  config: DetectConfig;
  last_ts: string;
}

/** JSON with sorted keys (JSONB does not keep key order). */
const canonical = (v: unknown): string =>
  v && typeof v === "object"
    ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`
    : JSON.stringify(v);

const lockKey = (symbol: string, interval: string) => `pattern-detect:${symbol}:${interval}`;

async function loadCandles(db: PoolClient, sql: string, params: unknown[]): Promise<Candle[]> {
  const { rows } = await db.query(sql, params);
  return rows as Candle[];
}

const COLS = "ts::float8 AS ts, open::float8 AS o, high::float8 AS h, low::float8 AS l, close::float8 AS c";

export async function runDetection(opts: RunOptions): Promise<RunReport> {
  const { symbol, interval, mode, dryRun = false, limit = Infinity, reset = false, pageSize = 50_000, config = DEFAULT_DETECT_CONFIG } = opts;
  const step = INTERVALS[interval];
  if (!step) throw new Error(`Unknown interval ${interval}`);
  const started = Date.now();
  const report: RunReport = {
    symbol, interval, status: dryRun ? "dry-run" : "done", dryRun,
    scanned: 0, found: 0, inserted: 0, skipped: 0, invalid: 0, errors: [], byPattern: {}, lastTs: null, sample: [], ms: 0,
  };
  const finish = () => ({ ...report, ms: Date.now() - started });

  await ensureSchema();
  const db = await pool.connect();
  let locked = false;
  try {
    const { rows: lock } = await db.query("SELECT pg_try_advisory_lock(hashtext($1)) AS ok", [lockKey(symbol, interval)]);
    locked = lock[0].ok;
    if (!locked) return { ...finish(), status: "busy" };

    if (reset && !dryRun) {
      await db.query("BEGIN");
      await db.query("DELETE FROM pattern_detections WHERE symbol=$1 AND interval=$2", [symbol, interval]);
      await db.query("DELETE FROM pattern_scan_state WHERE symbol=$1 AND interval=$2", [symbol, interval]);
      await db.query("COMMIT");
    }
    const { rows: st } = await db.query<ScanState>(
      "SELECT version, config, last_ts FROM pattern_scan_state WHERE symbol=$1 AND interval=$2",
      [symbol, interval],
    );
    const changed = !!st[0] && (st[0].version !== DETECTOR_VERSION || canonical(st[0].config) !== canonical(config));
    if (changed && !dryRun) {
      report.status = "error";
      report.errors.push("Stored detections were made with a different detector version/config - rerun with --reset");
      return finish();
    }
    // A dry run of a reset or of a changed detector previews a scan from the beginning.
    const state = dryRun && (reset || changed) ? undefined : st[0];
    if (!state && mode === "incremental") return { ...finish(), status: "no-checkpoint" };

    let cursor = state ? Number(state.last_ts) : -1;
    if (state) report.lastTs = cursor;
    // Warm-up: candles already scanned that later patterns need as context.
    const warmBars = config.warmupBars; // swing points are rebuilt from this much history
    let warm = cursor < 0 ? [] : (await loadCandles(db,
      `SELECT ${COLS} FROM candles WHERE symbol=$1 AND interval=$2 AND ts <= $3 ORDER BY ts DESC LIMIT $4`,
      [symbol, interval, cursor, warmBars])).reverse();

    while (report.scanned < limit) {
      const take = Math.min(pageSize, limit - report.scanned);
      const page = await loadCandles(db,
        `SELECT ${COLS} FROM candles WHERE symbol=$1 AND interval=$2 AND ts > $3 AND ts + $4 <= $5 ORDER BY ts LIMIT $6`,
        [symbol, interval, cursor, step, Date.now(), take]);
      if (!page.length) break;

      const prepared = prepareCandles([...warm, ...page]);
      const buf = prepared.candles;
      report.invalid += prepared.invalid + prepared.duplicates;
      const from = buf.findIndex((k) => k.ts > cursor);
      const scan = detectRange(buf, step, from < 0 ? buf.length : from, config);
      const lastTs = page[page.length - 1].ts;

      let inserted = 0;
      if (!dryRun) {
        await db.query("BEGIN");
        try {
          inserted = await insertDetections(db, symbol, interval, scan.detections);
          await db.query(
            `INSERT INTO pattern_scan_state (symbol, interval, version, config, last_ts, scanned, found, skipped)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (symbol, interval) DO UPDATE SET last_ts = EXCLUDED.last_ts,
               scanned = pattern_scan_state.scanned + EXCLUDED.scanned, found = pattern_scan_state.found + EXCLUDED.found,
               skipped = pattern_scan_state.skipped + EXCLUDED.skipped, updated_at = now()`,
            [symbol, interval, DETECTOR_VERSION, JSON.stringify(config), lastTs, page.length, inserted, scan.skipped],
          );
          await db.query("COMMIT");
        } catch (err) {
          await db.query("ROLLBACK");
          throw err;
        }
      }

      report.scanned += page.length;
      report.found += scan.detections.length;
      report.inserted += inserted;
      report.skipped += scan.skipped;
      report.lastTs = lastTs;
      for (const d of scan.detections) {
        report.byPattern[d.pattern] = (report.byPattern[d.pattern] ?? 0) + 1;
        if (report.sample.length < 10) report.sample.push(d);
      }
      opts.onPage?.(finish());

      cursor = lastTs;
      warm = buf.slice(-warmBars);
      if (page.length < take) break;
    }
    if (report.inserted > 10_000) await db.query("ANALYZE pattern_detections"); // keep planner stats fresh after a bulk load
    return finish();
  } catch (err) {
    report.status = "error";
    report.errors.push(err instanceof Error ? err.message : String(err));
    return finish();
  } finally {
    if (locked) await db.query("SELECT pg_advisory_unlock(hashtext($1))", [lockKey(symbol, interval)]).catch(() => {});
    db.release();
  }
}

/** Batch insert; OHLC is copied from the candle row itself so values stay exact. Returns rows added. */
async function insertDetections(db: PoolClient, symbol: string, interval: string, ds: Detection[]): Promise<number> {
  let added = 0;
  for (let i = 0; i < ds.length; i += 5000) {
    const chunk = ds.slice(i, i + 5000);
    const res = await db.query(
      `INSERT INTO pattern_detections (symbol, interval, pattern, direction, ts, start_ts, candles, open, high, low, close, version, meta)
       SELECT $1, $2, d.pattern, d.direction, d.ts, d.start_ts, d.candles, c.open, c.high, c.low, c.close, $3, d.meta
       FROM unnest($4::text[], $5::text[], $6::bigint[], $7::bigint[], $8::smallint[], $9::jsonb[])
            AS d(pattern, direction, ts, start_ts, candles, meta)
       JOIN candles c ON c.symbol = $1 AND c.interval = $2 AND c.ts = d.ts
       ON CONFLICT (symbol, interval, ts, pattern) DO NOTHING`,
      [
        symbol, interval, DETECTOR_VERSION,
        chunk.map((d) => d.pattern), chunk.map((d) => d.direction), chunk.map((d) => d.ts), chunk.map((d) => d.startTs),
        chunk.map((d) => d.candles), chunk.map((d) => JSON.stringify(d.meta)),
      ],
    );
    added += res.rowCount ?? 0;
  }
  return added;
}

/** Incremental pass for every active symbol that already has a checkpoint (called by the sync job). */
export async function detectNewCandles(interval = "1m"): Promise<Record<string, string | number>> {
  await ensureSchema();
  const { rows } = await pool.query("SELECT symbol FROM pattern_scan_state WHERE interval=$1", [interval]);
  const out: Record<string, string | number> = {};
  for (const { symbol } of rows) {
    const r = await runDetection({ symbol, interval, mode: "incremental" });
    out[symbol] = r.status === "done" ? r.inserted : `${r.status}${r.errors.length ? `: ${r.errors[0]}` : ""}`;
  }
  return out;
}
