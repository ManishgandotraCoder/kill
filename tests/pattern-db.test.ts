// DB + API tests. Run against a separate database (TEST_DATABASE_URL, default: DATABASE_URL with
// the database renamed to bit_test, created if missing) - never the real candles.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Client } from "pg";
import { detectRange, prepareCandles } from "../lib/pattern-detect";
import { randomWalk, STEP, T0, withTs } from "./fixtures";

const real = process.env.DATABASE_URL;
const testUrl = process.env.TEST_DATABASE_URL ?? (real ? real.replace(/\/[^/?]+(\?|$)/, "/bit_test$1") : undefined);
if (!testUrl || testUrl === real) throw new Error("Set TEST_DATABASE_URL to a database other than DATABASE_URL");
process.env.DATABASE_URL = testUrl;

type Db = typeof import("../lib/db");
type Store = typeof import("../lib/pattern-store");
let db: Db, store: Store;
let listRoute: typeof import("../app/api/patterns/route");
let summaryRoute: typeof import("../app/api/patterns/summary/route");
let detailRoute: typeof import("../app/api/patterns/[id]/route");

const SYM = "TESTUSDT";
const N = 5000;
const candles = withTs(randomWalk(N), [3000]); // one 2-candle gap

async function insertCandles(cs: { ts: number; o: number; h: number; l: number; c: number }[]) {
  await db.pool.query(
    `INSERT INTO candles (symbol, interval, ts, open, high, low, close, volume)
     SELECT $1, '1m', * FROM unnest($2::bigint[], $3::numeric[], $4::numeric[], $5::numeric[], $6::numeric[], $7::numeric[])`,
    [SYM, cs.map((k) => k.ts), cs.map((k) => k.o), cs.map((k) => k.h), cs.map((k) => k.l), cs.map((k) => k.c), cs.map(() => 1)],
  );
}

const stored = async () =>
  (await db.pool.query("SELECT ts::float8 AS ts, pattern FROM pattern_detections WHERE symbol=$1 ORDER BY ts, pattern", [SYM])).rows;
const expected = (cs = candles) =>
  detectRange(prepareCandles(cs).candles, STEP).detections.map((d) => ({ ts: d.ts, pattern: d.pattern })).sort((a, b) => a.ts - b.ts || a.pattern.localeCompare(b.pattern));
const get = (path: string) => new Request(`http://test${path}`);

before(async () => {
  const admin = new Client({ connectionString: testUrl.replace(/\/[^/?]+(\?|$)/, "/postgres$1") });
  await admin.connect();
  const name = new URL(testUrl).pathname.slice(1);
  const { rowCount } = await admin.query("SELECT 1 FROM pg_database WHERE datname=$1", [name]);
  if (!rowCount) await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();

  db = await import("../lib/db");
  store = await import("../lib/pattern-store");
  listRoute = await import("../app/api/patterns/route");
  summaryRoute = await import("../app/api/patterns/summary/route");
  detailRoute = await import("../app/api/patterns/[id]/route");
  await db.ensureSchema();
  await db.pool.query("DELETE FROM pattern_detections WHERE symbol=$1", [SYM]);
  await db.pool.query("DELETE FROM pattern_scan_state WHERE symbol=$1", [SYM]);
  await db.pool.query("DELETE FROM candles WHERE symbol=$1", [SYM]);
  await db.pool.query("INSERT INTO symbols (symbol) VALUES ($1) ON CONFLICT DO NOTHING", [SYM]);
  await insertCandles(candles);
});

after(async () => {
  await db?.pool.end();
});

const run = (o: Partial<Parameters<Store["runDetection"]>[0]> = {}) =>
  store.runDetection({ symbol: SYM, interval: "1m", mode: "backfill", pageSize: 700, ...o });

describe("detection workflow", () => {
  it("incremental does nothing before a backfill", async () => {
    assert.equal((await run({ mode: "incremental" })).status, "no-checkpoint");
  });

  it("dry run reports detections but writes nothing", async () => {
    const r = await run({ dryRun: true, limit: 2000 });
    assert.equal(r.status, "dry-run");
    assert.equal(r.scanned, 2000);
    assert.ok(r.found > 0);
    assert.equal((await stored()).length, 0);
    assert.equal((await db.pool.query("SELECT 1 FROM pattern_scan_state WHERE symbol=$1", [SYM])).rowCount, 0);
  });

  it("an interrupted backfill resumes from its checkpoint with the same result as one pass", async () => {
    const first = await run({ limit: 1800 }); // stops mid-way, like an interruption
    assert.equal(first.scanned, 1800);
    const rest = await run();
    assert.equal(rest.scanned, N - 1800);
    assert.equal(first.skipped + rest.skipped, 2 * 13); // ATR warm-up at the start of data + after the gap
    assert.deepEqual(await stored(), expected());
  });

  it("rerunning is idempotent", async () => {
    const before = await stored();
    const r = await run();
    assert.equal(r.status, "done");
    assert.equal(r.scanned, 0);
    assert.equal(r.inserted, 0);
    assert.deepEqual(await stored(), before);
  });

  it("stores exact OHLC of the completing candle and ms UTC timestamps", async () => {
    const { rows } = await db.pool.query(
      `SELECT d.open = c.open AND d.high = c.high AND d.low = c.low AND d.close = c.close AS same,
              d.time = to_timestamp(d.ts / 1000.0) AS time_ok, d.start_ts <= d.ts AS order_ok
       FROM pattern_detections d JOIN candles c USING (symbol, interval, ts) WHERE d.symbol=$1`,
      [SYM],
    );
    assert.ok(rows.length > 0 && rows.every((r) => r.same && r.time_ok && r.order_ok));
  });

  it("incremental picks up new closed candles only, never the forming one", async () => {
    const last = candles.at(-1)!;
    const more = withTs(randomWalk(300, 7)).map((k, i) => ({ ...k, ts: last.ts + (i + 1) * STEP }));
    await insertCandles(more);
    const forming = { ts: Math.floor(Date.now() / STEP) * STEP, o: 1, h: 1, l: 1, c: 1 }; // still open
    await insertCandles([forming]);
    const r = await run({ mode: "incremental" });
    assert.equal(r.scanned, 300);
    assert.equal(r.lastTs, more.at(-1)!.ts);
    assert.deepEqual(await stored(), expected([...candles, ...more]));
  });

  it("only one run at a time per symbol+interval", async () => {
    const holder = await db.pool.connect();
    await holder.query("SELECT pg_advisory_lock(hashtext($1))", [`pattern-detect:${SYM}:1m`]);
    try {
      assert.equal((await run()).status, "busy");
    } finally {
      await holder.query("SELECT pg_advisory_unlock(hashtext($1))", [`pattern-detect:${SYM}:1m`]);
      holder.release();
    }
  });

  it("refuses to mix configs; --reset rescans", async () => {
    const r = await run({ config: { ...(await import("../lib/pattern-detect")).DEFAULT_DETECT_CONFIG, equalAtr: 2 } });
    assert.equal(r.status, "error");
    const count = (await stored()).length;
    const again = await run({ reset: true });
    assert.equal(again.status, "done");
    assert.equal((await stored()).length, count);
  });

  it("never modifies candles", async () => {
    const { rows } = await db.pool.query("SELECT count(*)::int AS n FROM candles WHERE symbol=$1", [SYM]);
    assert.equal(rows[0].n, N + 300 + 1);
  });
});

describe("API", () => {
  it("lists newest first and pages with a cursor without gaps or repeats", async () => {
    const all: number[] = [];
    let cursor: string | null = null;
    do {
      const res: Response = await listRoute.GET(get(`/api/patterns?symbol=${SYM}&limit=250${cursor ? `&cursor=${cursor}` : ""}`));
      assert.equal(res.status, 200);
      const body = await res.json();
      all.push(...body.items.map((i: { id: number }) => i.id));
      for (let i = 1; i < body.items.length; i++) assert.ok(body.items[i - 1].ts >= body.items[i].ts);
      cursor = body.nextCursor;
    } while (cursor);
    assert.equal(all.length, (await stored()).length);
    assert.equal(new Set(all).size, all.length);
  });

  it("filters by pattern and date range", async () => {
    const from = T0 + 1000 * STEP, to = T0 + 2000 * STEP;
    const res = await listRoute.GET(get(`/api/patterns?symbol=${SYM}&pattern=double_top,symmetrical_triangle&from=${from}&to=${new Date(to).toISOString()}&limit=1000`));
    const { items } = await res.json();
    const want = (await stored()).filter((r) => ["double_top", "symmetrical_triangle"].includes(r.pattern) && r.ts >= from && r.ts <= to);
    assert.ok(want.length > 0, "fixture should contain some of these patterns");
    assert.equal(items.length, want.length);
    assert.ok(items.every((i: { pattern: string; ts: number }) => ["double_top", "symmetrical_triangle"].includes(i.pattern) && i.ts >= from && i.ts <= to));
  });

  it("validates parameters", async () => {
    const bad = ["limit=0", "limit=5000", "pattern=nope", "interval=7m", "from=yesterday", "cursor=abc", `from=${T0 + 10}&to=${T0}`];
    for (const q of [...bad.map((b) => `symbol=${SYM}&${b}`), "symbol=x%3Bdrop"]) {
      assert.equal((await listRoute.GET(get(`/api/patterns?${q}`))).status, 400, q);
    }
    assert.equal((await summaryRoute.GET(get(`/api/patterns/summary?symbol=${SYM}&pattern=nope`))).status, 400);
  });

  it("summary counts match the table", async () => {
    const body = await (await summaryRoute.GET(get(`/api/patterns/summary?symbol=${SYM}`))).json();
    assert.equal(body.total, (await stored()).length);
    assert.equal(body.scan.lastTs, Number((await db.pool.query("SELECT max(ts) AS m FROM candles WHERE symbol=$1 AND ts < $2", [SYM, Date.now() - STEP])).rows[0].m));
  });

  it("detail returns the detection with candles around it", async () => {
    const { items } = await (await listRoute.GET(get(`/api/patterns?symbol=${SYM}&limit=1`))).json();
    const res = await detailRoute.GET(get(`/api/patterns/${items[0].id}`), { params: Promise.resolve({ id: String(items[0].id) }) });
    const body = await res.json();
    assert.equal(body.detection.id, items[0].id);
    assert.ok(body.candles.some((k: { ts: number }) => k.ts === body.detection.startTs));
    // the whole pattern (first swing point .. breakout) plus up to 30 candles either side
    assert.ok(body.candles.length >= body.detection.candles && body.candles.length <= body.detection.candles + 60);
    assert.equal((await detailRoute.GET(get("/api/patterns/999999999"), { params: Promise.resolve({ id: "999999999" }) })).status, 404);
    assert.equal((await detailRoute.GET(get("/api/patterns/x"), { params: Promise.resolve({ id: "x" }) })).status, 400);
  });
});

describe("live signal record", () => {
  it("scores logged signals against the candle `horizon` later, leaves open ones pending", async () => {
    const { liveRecord } = await import("../lib/signal");
    const { rows } = await db.pool.query(
      `INSERT INTO ml_models (symbol, interval, horizon, features, model, metrics) VALUES ($1, '1m', 2, '[]', '{}', '{}') RETURNING id`, [SYM]);
    const id = rows[0].id;
    const at = (i: number) => candles[i].ts;
    const close = (i: number) => candles[i].c;
    const log = async (i: number, p: number) =>
      db.pool.query("INSERT INTO signal_log (symbol, interval, horizon, model_id, ts, p_up, close) VALUES ($1,'1m',2,$2,$3,$4,$5)", [SYM, id, at(i), p, close(i)]);
    const up = (i: number) => close(i + 2) > close(i);
    // i=100: says up strongly; i=200: says down mildly (not leaning); last candle: window not closed yet
    await log(100, 0.6);
    await log(200, 0.49);
    const last = (await db.pool.query("SELECT max(ts)::float8 AS t, (array_agg(close ORDER BY ts DESC))[1] AS c FROM candles WHERE symbol=$1", [SYM])).rows[0];
    await db.pool.query("INSERT INTO signal_log (symbol, interval, horizon, model_id, ts, p_up, close) VALUES ($1,'1m',2,$2,$3,0.5,$4)", [SYM, id, last.t, last.c]);
    const r = await liveRecord(SYM, "1m", 2, id);
    assert.equal(r.checked, 2);
    assert.equal(r.pending, 1);
    assert.equal(r.accuracy, ((up(100) ? 1 : 0) + (up(200) ? 0 : 1)) / 2);
    assert.equal(r.leaned, 1);
    assert.equal(r.leanHitRate, up(100) ? 1 : 0);
    assert.ok(Math.abs(r.leanAvgBp! - (close(102) / close(100) - 1) * 1e4) < 1e-6);
    assert.equal(r.since, at(100));
    await db.pool.query("DELETE FROM signal_log WHERE model_id=$1", [id]);
    await db.pool.query("DELETE FROM ml_models WHERE id=$1", [id]);
  });
});


describe("prediction sessions", () => {
  const PSYM = "TESTPRED";
  // Like live data: 1m candles ending with one that closed a minute ago.
  const lastTs = Math.floor(Date.now() / 60_000) * 60_000 - 2 * 60_000;
  const base = withTs(randomWalk(6000, 3)).map((k, i, all) => ({ ...k, ts: lastTs - (all.length - 1 - i) * 60_000 }));
  type P = typeof import("../lib/predictions");
  let P: P;
  let modelId = 0;
  let userId = 0, otherId = 0;

  before(async () => {
    P = await import("../lib/predictions");
    const { featureSpec } = await import("../lib/ml-features");
    const { PATTERN_KEYS } = await import("../lib/pattern-detect");
    await db.pool.query("DELETE FROM prediction_sessions WHERE symbol=$1", [PSYM]);
    await db.pool.query("DELETE FROM ml_models WHERE symbol=$1", [PSYM]);
    await db.pool.query("DELETE FROM candles WHERE symbol=$1", [PSYM]);
    await db.pool.query("INSERT INTO symbols (symbol) VALUES ($1) ON CONFLICT DO NOTHING", [PSYM]);
    await db.pool.query(
      `INSERT INTO candles (symbol, interval, ts, open, high, low, close, volume)
       SELECT $1, '1m', * FROM unnest($2::bigint[], $3::numeric[], $4::numeric[], $5::numeric[], $6::numeric[], $7::numeric[])`,
      [PSYM, base.map((k) => k.ts), base.map((k) => k.o), base.map((k) => k.h), base.map((k) => k.l), base.map((k) => k.c), base.map(() => 1)],
    );
    // A fixed "model": no feature weights, bias 0.2 -> P(up) = 55% for every candle.
    const keys = featureSpec("1m").features.map((f) => f.key);
    const model = { mean: keys.map(() => 0), std: keys.map(() => 1), weights: keys.map(() => 0), bias: 0.2 };
    const metrics = {
      feeBpPerSide: 10, horizonMinutes: 10,
      test: { from: 0, to: 0, n: 1, accuracy: 0.5, upRate: 0.5, auc: 0.5, trades: [] },
      patternStats: PATTERN_KEYS.map((k) => ({ pattern: k, n: 0, upRate: 0.5, avgBp: 0 })),
    };
    const { rows } = await db.pool.query(
      "INSERT INTO ml_models (symbol, interval, horizon, features, model, metrics) VALUES ($1, '1m', 10, $2, $3, $4) RETURNING id::int AS id",
      [PSYM, JSON.stringify(keys), JSON.stringify(model), JSON.stringify(metrics)],
    );
    modelId = rows[0].id;
    await db.pool.query("DELETE FROM users WHERE email LIKE '%@pred.test'");
    const mk = async (email: string) =>
      (await db.pool.query("INSERT INTO users (email, name, password_hash) VALUES ($1, 'T', 'x') RETURNING id::int AS id", [email])).rows[0].id;
    userId = await mk("me@pred.test");
    otherId = await mk("other@pred.test");
  });

  after(async () => {
    await db.pool.query("DELETE FROM prediction_sessions WHERE symbol=$1", [PSYM]);
    await db.pool.query("DELETE FROM signal_log WHERE symbol=$1", [PSYM]);
    await db.pool.query("DELETE FROM ml_models WHERE symbol=$1", [PSYM]);
    await db.pool.query("DELETE FROM candles WHERE symbol=$1", [PSYM]);
    await db.pool.query("DELETE FROM users WHERE email LIKE '%@pred.test'");
  });

  const start = (minutes = 10) => P.startPrediction(userId, PSYM, minutes);

  it("validates input and refuses stale data", async () => {
    await assert.rejects(start(7), (e) => e instanceof P.PredictionError && e.status === 400);
    await assert.rejects(start(30), (e) => e instanceof P.PredictionError && e.status === 404); // no 30-min model
    await assert.rejects(P.startPrediction(userId, PSYM, 10, { maxStaleMs: 0 }), (e) => e instanceof P.PredictionError && e.status === 409); // data "behind"
    await assert.rejects(P.cancelPrediction(userId, 999999999), (e) => e instanceof P.PredictionError && e.status === 404);
  });

  it("starts from the newest closed candle and stays running until its end candle exists", async () => {
    const p = await start();
    const last = base[base.length - 1];
    assert.equal(p.status, "running");
    assert.equal(p.modelId, modelId);
    assert.equal(p.basisTs, last.ts);
    assert.equal(p.startPrice, last.c);
    assert.equal(p.endsAt, last.ts + 60_000 + 10 * 60_000);
    assert.ok(Math.abs(p.pUp - 1 / (1 + Math.exp(-0.2))) < 1e-9);
    assert.equal(p.side, "up");
    assert.ok(p.rangeLow < p.startPrice && p.startPrice < p.rangeHigh);
    await P.resolveDue();
    const { running } = await P.listPredictions(userId, PSYM);
    assert.ok(running.some((r) => r.id === p.id));
  });

  it("cancel keeps it in history; cancelling twice is refused", async () => {
    const p = await start();
    // another user can neither see nor cancel it
    assert.ok(!(await P.listPredictions(otherId, PSYM)).running.some((r) => r.id === p.id));
    await assert.rejects(P.cancelPrediction(otherId, p.id), (e) => e instanceof P.PredictionError && e.status === 404);
    const c = await P.cancelPrediction(userId, p.id);
    assert.equal(c.status, "cancelled");
    assert.ok(c.cancelledAt !== null && c.cancelPrice === base[base.length - 1].c);
    await assert.rejects(P.cancelPrediction(userId, p.id), (e) => e instanceof P.PredictionError && e.status === 409);
    const { history } = await P.listPredictions(userId, PSYM);
    assert.ok(history.some((r) => r.id === p.id && r.status === "cancelled"));
  });

  it("is scored against the close of the candle at the end of the window", async () => {
    const { running } = await P.listPredictions(userId, PSYM);
    const last = base[base.length - 1];
    // the candle that closes 10 minutes after the start candle closes: price went up -> "up" calls are correct
    const end = { ts: last.ts + 10 * 60_000, c: last.c + 25 };
    await db.pool.query(
      "INSERT INTO candles (symbol, interval, ts, open, high, low, close, volume) VALUES ($1, '1m', $2, $3, $4, $5, $3, 1)",
      [PSYM, end.ts, end.c, end.c + 1, end.c - 1],
    );
    const r = await P.resolveDue();
    assert.ok(r.resolved >= running.length);
    const { running: still, history, stats } = await P.listPredictions(userId, PSYM);
    assert.equal(still.length, 0);
    const done = history.filter((h) => h.status === "completed");
    assert.equal(done.length, running.length);
    assert.ok(done.every((h) => h.endPrice === end.c && h.outcome === "correct" && h.resolvedAt !== null));
    assert.equal(stats.completed, done.length);
    assert.equal(stats.accuracy, 1);
    assert.ok(Math.abs(stats.avgBp! - (end.c / last.c - 1) * 1e4) < 1e-6);
    assert.equal(stats.cancelled, 1);
    await db.pool.query("DELETE FROM candles WHERE symbol=$1 AND ts=$2", [PSYM, end.ts]); // later tests start fresh windows
  });

  it("API: everything requires a login", async () => {
    const route = await import("../app/api/predictions/route");
    const cancelRoute = await import("../app/api/predictions/[id]/cancel/route");
    const post = (body: unknown) => route.POST(new Request("http://test/api/predictions", { method: "POST", body: JSON.stringify(body) }));
    assert.equal((await post({ symbol: "x;y", minutes: 10 })).status, 400);
    assert.equal((await post({ symbol: PSYM, minutes: 10 })).status, 401);
    assert.equal((await route.GET(get(`/api/predictions?symbol=${PSYM}`))).status, 401);
    assert.equal((await cancelRoute.POST(get("/x"), { params: Promise.resolve({ id: "1" }) })).status, 401);
    assert.equal((await cancelRoute.POST(get("/x"), { params: Promise.resolve({ id: "abc" }) })).status, 400);
  });
});
