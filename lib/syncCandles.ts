import { ensureSchema, pool } from "./db";

const URL = "https://data-api.binance.vision/api/v3/klines";

export const INTERVALS: Record<string, number> = {
  "1m": 60_000, "5m": 300_000, "15m": 900_000,
  "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000,
};

// [openTime, open, high, low, close, volume, closeTime, ...]
type KlineRow = [number, string, string, string, string, string, number, ...unknown[]];

export interface SyncProgress {
  symbol: string;
  interval: string;
  status: "running" | "done" | "error";
  /** 0-100, share of the time range [from, now] already fetched. */
  pct: number;
  saved: number;
  error?: string;
}

async function insertKlines(symbol: string, interval: string, rows: KlineRow[]) {
  await pool.query(
    `INSERT INTO candles (symbol, interval, ts, open, high, low, close, volume)
     SELECT $1::text, $2::text, * FROM unnest($3::bigint[], $4::numeric[], $5::numeric[],
                                  $6::numeric[], $7::numeric[], $8::numeric[])
     ON CONFLICT DO NOTHING`,
    [symbol, interval, ...[0, 1, 2, 3, 4, 5].map((i) => rows.map((k) => k[i]))]
  );
}

/**
 * Fills the start of the window if the oldest stored candle is newer than `yearsBack` ago
 * (e.g. rows were deleted). Forward sync alone never looks back. Returns candles added.
 */
async function fillStart(symbol: string, interval: string, yearsBack: number): Promise<number> {
  const step = INTERVALS[interval];
  const { rows } = await pool.query("SELECT MIN(ts) AS first FROM candles WHERE symbol=$1 AND interval=$2", [symbol, interval]);
  if (!rows[0].first) return 0; // empty: the forward sync downloads everything
  const first = Number(rows[0].first);
  let start = Math.ceil((Date.now() - yearsBack * 365 * 24 * 3600 * 1000) / step) * step;
  let saved = 0;
  while (start < first) {
    const res = await fetch(
      `${URL}?symbol=${symbol}&interval=${interval}&limit=1000&startTime=${start}&endTime=${first - 1}`,
      { cache: "no-store" }
    );
    if (!res.ok) throw new Error(`${symbol}: ${res.status} ${await res.text()}`);
    const data: KlineRow[] = await res.json();
    if (!data.length) break;
    await insertKlines(symbol, interval, data);
    saved += data.length;
    start = data[data.length - 1][0] + step;
    if (data.length < 1000) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  return saved;
}

async function syncOne(
  symbol: string,
  interval: string,
  yearsBack: number,
  onProgress: (pct: number, saved: number) => void = () => {},
) {
  const step = INTERVALS[interval];
  const { rows } = await pool.query(
    "SELECT MAX(ts) AS last FROM candles WHERE symbol=$1 AND interval=$2",
    [symbol, interval]
  );
  let start = rows[0].last
    ? Number(rows[0].last) + step
    : Date.now() - yearsBack * 365 * 24 * 3600 * 1000;
  const from = start;
  const end = Date.now();
  let saved = await fillStart(symbol, interval, yearsBack);
  onProgress(0, saved);

  while (true) {
    const res = await fetch(
      `${URL}?symbol=${symbol}&interval=${interval}&limit=1000&startTime=${start}`,
      { cache: "no-store" }
    );
    if (!res.ok) throw new Error(`${symbol}: ${res.status} ${await res.text()}`);
    const data: KlineRow[] = await res.json();
    if (!data.length) break;

    const closed = data.filter((k) => k[6] < Date.now());
    if (closed.length) {
      await insertKlines(symbol, interval, closed);
      saved += closed.length;
    }

    start = data[data.length - 1][0] + step;
    onProgress(end > from ? Math.min(100, ((start - from) / (end - from)) * 100) : 100, saved);
    if (data.length < 1000) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  onProgress(100, saved);
  return saved;
}

// ---- jobs: one sync per symbol+interval at a time, observable for progress ----

interface Job {
  state: SyncProgress;
  listeners: Set<(s: SyncProgress) => void>;
  done: Promise<SyncProgress>;
}

const g = globalThis as unknown as { syncJobs?: Map<string, Job> };
const jobs = (g.syncJobs ??= new Map());

/** Starts a sync, or returns the one already running for this symbol+interval. */
export function startSync(symbol: string, interval: string, yearsBack: number): Job {
  const key = `${symbol}:${interval}`;
  const running = jobs.get(key);
  if (running?.state.status === "running") return running;

  let state: SyncProgress = { symbol, interval, status: "running", pct: 0, saved: 0 };
  const listeners = new Set<(s: SyncProgress) => void>();
  const update = (patch: Partial<SyncProgress>) => {
    state = { ...state, ...patch };
    listeners.forEach((l) => l(state));
  };
  const done = syncOne(symbol, interval, yearsBack, (pct, saved) => update({ pct, saved }))
    .then(() => update({ status: "done", pct: 100 }))
    .catch((e: unknown) => update({ status: "error", error: e instanceof Error ? e.message : String(e) }))
    .then(() => state);

  const job: Job = {
    get state() {
      return state;
    },
    listeners,
    done,
  };
  jobs.set(key, job);
  return job;
}

export function runningSyncs(): SyncProgress[] {
  return [...jobs.values()].filter((j) => j.state.status === "running").map((j) => j.state);
}

/** Intervals the background job keeps in the DB: 1m for 5 years, plus 1h for pattern discovery. */
export const STORED_INTERVALS = ["1m", "1h"];

export async function syncAll(interval = "15m", only?: string) {
  await ensureSchema();
  const { rows } = await pool.query(
    "SELECT symbol, years_back FROM symbols WHERE active AND ($1::text IS NULL OR symbol=$1)",
    [only ?? null]
  );
  const result: Record<string, number | string> = {};
  for (const s of rows) {
    const state = await startSync(s.symbol, interval, s.years_back).done;
    // one bad coin won't stop others
    result[s.symbol] = state.status === "error" ? `error: ${state.error}` : state.saved;
  }
  return result;
}
