// Trains an up/down model on stored candles and saves it, with walk-forward test results, in ml_models.
//
//   npm run train -- --interval 1m --horizon 15     15 minutes ahead on 1m candles
//   npm run train -- --interval 1h --horizon 1      1 hour ahead on 1h candles
//   npm run train -- --interval 1h --horizon 4      4 hours
//   npm run train -- --interval 1h --horizon 24     1 day
//   options: --symbol BTCUSDT  --fee-bp 10 (per side)  --folds 7
//
// Walk-forward evaluation: the last 35% of history is cut into `folds` periods. For each period a
// model is trained on everything before it (labels that would reach into the period are purged)
// and predicts that period only. All test numbers come from these out-of-sample predictions.
// L2 strength is chosen on the 15% before the first test period. The saved model is refit on all data.

import { ensureSchema, pool } from "../lib/db";
import { contiguousRuns, duration, featureSpec, featuresAt, futureReturn, N_FEATURES, patternMasks, type CandleV } from "../lib/ml-features";
import { auc, calibration, logLoss, predict, tradeStats, train, type LinearModel, type TrainOptions } from "../lib/ml-model";
import { PATTERN_KEYS } from "../lib/pattern-detect";
import { INTERVALS } from "../lib/syncCandles";

const args = process.argv.slice(2);
const opt = (name: string, def: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};

const symbol = opt("symbol", "BTCUSDT").toUpperCase();
const interval = opt("interval", "1m");
const spec = featureSpec(interval);
const step = INTERVALS[interval];
const horizon = Number(opt("horizon", interval === "1m" ? "15" : "1"));
const feeBp = Number(opt("fee-bp", "10")); // Binance spot taker fee 0.1% per side
const FOLDS = Number(opt("folds", "7"));
const THRESHOLDS = [0.51, 0.52, 0.53, 0.55, 0.6];
const L2S = [1e-3, 1e-2, 1e-1];
const label = `${symbol} ${interval} -> ${duration((horizon * step) / 60000)} ahead`;

const iso = (ts: number) => new Date(ts).toISOString().slice(0, 16) + "Z";
const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);

async function loadCandles(): Promise<CandleV[]> {
  const out: CandleV[] = [];
  let cursor = -1;
  const now = Date.now();
  for (;;) {
    const { rows } = await pool.query(
      `SELECT ts::float8 AS ts, open::float8 AS o, high::float8 AS h, low::float8 AS l, close::float8 AS c, volume::float8 AS v
       FROM candles WHERE symbol=$1 AND interval=$2 AND ts > $3 AND ts + $4 <= $5 ORDER BY ts LIMIT 200000`,
      [symbol, interval, cursor, step, now],
    );
    if (!rows.length) break;
    for (const r of rows) out.push(r);
    cursor = rows[rows.length - 1].ts;
  }
  return out;
}

async function main() {
  await ensureSchema();
  log(`training ${label}`);
  const c = await loadCandles();
  if (c.length < spec.history + 1000) throw new Error(`Only ${c.length} ${interval} candles - not enough to train`);
  log(`${c.length.toLocaleString()} candles ${iso(c[0].ts)} -> ${iso(c.at(-1)!.ts)}`);

  const runs = contiguousRuns(c, step);
  const masks = patternMasks(c, step);
  const X = new Float32Array(c.length * N_FEATURES);
  const y = new Uint8Array(c.length), ret = new Float64Array(c.length), ts = new Float64Array(c.length);
  let n = 0, ties = 0;
  for (let i = 0; i < c.length; i++) {
    const r = futureReturn(c, i, horizon, step);
    if (r === null) continue;
    if (r === 0) {
      ties++; // unchanged price: neither up nor down, left out
      continue;
    }
    if (!featuresAt(spec, c, runs, masks, i, X, n * N_FEATURES)) continue;
    y[n] = r > 0 ? 1 : 0;
    ret[n] = r;
    ts[n] = c[i].ts;
    n++;
  }
  log(`${n.toLocaleString()} labelled rows (${ties} unchanged-price rows left out)`);

  const gap = horizon * step;
  const rowsWhere = (f: (t: number) => boolean) => {
    const out: number[] = [];
    for (let i = 0; i < n; i++) if (f(ts[i])) out.push(i);
    return Int32Array.from(out);
  };
  const rate = (rows: Int32Array) => rows.reduce((a, r) => a + y[r], 0) / rows.length;
  // More passes over small datasets (1h) so Adam converges; ~2 passes over millions of 1m rows.
  const trainOpts = (rows: number): Omit<TrainOptions, "l2"> =>
    ({ epochs: Math.min(40, Math.max(2, Math.ceil(4e6 / rows))), batch: rows > 2e5 ? 1024 : 128, lr: 0.01 });

  const testStart = ts[Math.floor(n * 0.65)], valStart = ts[Math.floor(n * 0.5)], end = ts[n - 1] + step;

  // ---- choose L2 on the validation period ----
  const tuneTrain = rowsWhere((t) => t < valStart - gap), tuneVal = rowsWhere((t) => t >= valStart && t < testStart - gap);
  const tuneBase = rate(tuneTrain);
  let best = { l2: L2S[0], loss: Infinity };
  const tuning = [];
  for (const l2 of L2S) {
    const m = train(X, y, N_FEATURES, tuneTrain, { ...trainOpts(tuneTrain.length), l2 });
    const p = Array.from(tuneVal, (r) => predict(m, X, r * N_FEATURES));
    const yy = Array.from(tuneVal, (r) => y[r]);
    const loss = logLoss(p, yy);
    const a = auc(p, yy);
    tuning.push({ l2, logLoss: loss, auc: a });
    log(`l2=${l2}: validation logloss ${loss.toFixed(5)} (constant guess ${logLoss(p.map(() => tuneBase), yy).toFixed(5)}) auc ${a.toFixed(4)}`);
    if (loss < best.loss) best = { l2, loss };
  }

  // ---- walk-forward out-of-sample predictions ----
  const oos = { p: [] as number[], base: [] as number[], y: [] as number[], ret: [] as number[], ts: [] as number[] };
  const folds = [];
  for (let k = 0; k < FOLDS; k++) {
    const from = testStart + ((end - testStart) * k) / FOLDS, to = testStart + ((end - testStart) * (k + 1)) / FOLDS;
    const trainRows = rowsWhere((t) => t < from - gap);
    const testRows = rowsWhere((t) => t >= from && t < to);
    if (!testRows.length) continue;
    const m: LinearModel = train(X, y, N_FEATURES, trainRows, { ...trainOpts(trainRows.length), l2: best.l2 });
    const base = rate(trainRows);
    let right = 0;
    for (const r of testRows) {
      const p = predict(m, X, r * N_FEATURES);
      oos.p.push(p);
      oos.base.push(base);
      oos.y.push(y[r]);
      oos.ret.push(ret[r]);
      oos.ts.push(ts[r]);
      if ((p >= 0.5 ? 1 : 0) === y[r]) right++;
    }
    folds.push({ from, to, n: testRows.length, accuracy: right / testRows.length, upRate: rate(testRows) });
    log(`fold ${k + 1}/${FOLDS} ${iso(from).slice(0, 10)}..${iso(to).slice(0, 10)}: accuracy ${((100 * right) / testRows.length).toFixed(1)}% (up ${(100 * rate(testRows)).toFixed(1)}%) n=${testRows.length}`);
  }

  const accuracy = oos.p.reduce((a, p, i) => a + ((p >= 0.5 ? 1 : 0) === oos.y[i] ? 1 : 0), 0) / oos.p.length;
  const test = {
    from: oos.ts[0], to: oos.ts.at(-1)!, n: oos.p.length,
    accuracy, accuracySe: Math.sqrt((accuracy * (1 - accuracy)) / oos.p.length),
    upRate: oos.y.reduce((a, b) => a + b, 0) / oos.y.length,
    auc: auc(oos.p, oos.y), logLoss: logLoss(oos.p, oos.y), baselineLogLoss: logLoss(oos.base, oos.y),
    calibration: calibration(oos.p, oos.y),
    trades: THRESHOLDS.map((t) => tradeStats(oos.p, oos.ret, t, feeBp)),
    /** No overlapping trades: each one waits for the previous to close. Use these for decisions. */
    tradesSpaced: THRESHOLDS.map((t) => tradeStats(oos.p, oos.ret, t, feeBp, oos.ts, gap)),
    folds,
  };
  log(`OUT-OF-SAMPLE ${iso(test.from).slice(0, 10)}..${iso(test.to).slice(0, 10)}: accuracy ${(100 * test.accuracy).toFixed(2)}% ±${(200 * test.accuracySe).toFixed(2)} (price rose ${(100 * test.upRate).toFixed(1)}%) auc ${test.auc.toFixed(4)} logloss ${test.logLoss.toFixed(5)} vs ${test.baselineLogLoss.toFixed(5)}`);
  for (const t of test.tradesSpaced) {
    log(`  p>=${t.threshold}: ${t.trades} non-overlapping trades, right ${(100 * t.hitRate).toFixed(1)}% ±${(200 * t.hitRateSe).toFixed(1)}, avg move ${t.grossBp.toFixed(1)}bp, after ${2 * feeBp}bp fees ${t.netBp.toFixed(1)}bp`);
  }

  // ---- final model on all data; pattern stats for explanations ----
  const all = Int32Array.from({ length: n }, (_, i) => i);
  const model = train(X, y, N_FEATURES, all, { ...trainOpts(n), l2: best.l2 });
  const patternStats = PATTERN_KEYS.map((k, p) => {
    let cnt = 0, up = 0, sum = 0;
    for (let i = 0; i < n; i++) if (X[i * N_FEATURES + p] === 1) {
      cnt++;
      up += y[i];
      sum += ret[i];
    }
    return { pattern: k, n: cnt, upRate: cnt ? up / cnt : 0, avgBp: cnt ? (sum / cnt) * 1e4 : 0 };
  });

  // Baseline over every labelled row, to compare pattern stats against "any candle".
  let allUp = 0, allSum = 0;
  for (let i = 0; i < n; i++) {
    allUp += y[i];
    allSum += ret[i];
  }
  const baseline = { n, upRate: allUp / n, avgBp: (allSum / n) * 1e4 };

  const metrics = {
    horizonMinutes: (horizon * step) / 60000,
    baseline,
    feeBpPerSide: feeBp,
    rows: n,
    evaluation: "walk-forward",
    l2: best.l2,
    tuning,
    test,
    patternStats,
  };
  const { rows } = await pool.query(
    "INSERT INTO ml_models (symbol, interval, horizon, features, model, metrics) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
    [symbol, interval, horizon, JSON.stringify(spec.features.map((f) => f.key)), JSON.stringify(model), JSON.stringify(metrics)],
  );
  log(`saved model #${rows[0].id} (${label})`);
  const top = model.weights.map((w, j) => [spec.features[j].key, w] as const).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 6);
  log("strongest features:", top.map(([k, w]) => `${k} ${w > 0 ? "+" : ""}${w.toFixed(3)}`).join(", "));
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
