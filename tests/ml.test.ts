import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { contiguousRuns, duration, featureSpec, featuresAt, futureReturn, N_FEATURES, patternMasks, type CandleV } from "../lib/ml-features";
import { auc, calibration, contributions, logLoss, predict, tradeStats, train } from "../lib/ml-model";
import { randomWalk, STEP, withTs } from "./fixtures";

const series = (n: number, gaps: number[] = []): CandleV[] => withTs(randomWalk(n), gaps).map((k, i) => ({ ...k, v: 1 + (i % 7) }));

const SPEC = featureSpec("1m");
const FEATURE_HISTORY = SPEC.history;

function feats(c: CandleV[], i: number, spec = SPEC, step = STEP) {
  const out = new Array<number>(N_FEATURES);
  return featuresAt(spec, c, contiguousRuns(c, step), patternMasks(c, step), i, out) ? out : null;
}

describe("features", () => {
  it("need FEATURE_HISTORY gap-free candles", () => {
    const c = series(400);
    assert.equal(feats(c, FEATURE_HISTORY - 2), null);
    assert.ok(feats(c, FEATURE_HISTORY - 1));
    const gapped = series(600, [300]);
    assert.equal(feats(gapped, 350), null); // gap 50 candles back
    assert.ok(feats(gapped, 300 + FEATURE_HISTORY - 1));
  });
  it("never read candles after i (identical with the future cut off or changed)", () => {
    const c = series(1500);
    for (const i of [400, 900, 1499]) {
      const full = feats(c, i)!;
      assert.deepEqual(feats(c.slice(0, i + 1), i), full);
      const changed = c.map((k, j) => (j > i ? { ...k, c: k.c * 2, h: k.h * 2, v: 99 } : k));
      assert.deepEqual(feats(changed, i), full);
    }
  });
  it("are finite", () => {
    const c = series(2000);
    for (let i = FEATURE_HISTORY; i < 2000; i += 37) assert.ok(feats(c, i)!.every(Number.isFinite));
  });
  it("1h spec: week-long lookbacks, same feature count, no look-ahead", () => {
    const H = 3_600_000;
    const spec = featureSpec("1h");
    assert.equal(spec.history, 169);
    assert.equal(spec.features.length, N_FEATURES);
    assert.ok(spec.features.some((f) => f.label.includes("1 w")));
    const c = series(400).map((k, i) => ({ ...k, ts: k.ts + i * (H - STEP) }));
    assert.equal(feats(c, 167, spec, H), null);
    const full = feats(c, 300, spec, H)!;
    assert.deepEqual(feats(c.slice(0, 301), 300, spec, H), full);
    assert.throws(() => featureSpec("5m"));
  });
  it("durations read naturally", () => {
    assert.deepEqual([duration(15), duration(60), duration(240), duration(1440), duration(4320), duration(10080)], ["15 min", "1 h", "4 h", "1 d", "3 d", "1 w"]);
  });
  it("label is the close-to-close return over the horizon, null across a gap or past the end", () => {
    const c = series(100, [60]);
    assert.equal(futureReturn(c, 10, 15, STEP), c[25].c / c[10].c - 1);
    assert.equal(futureReturn(c, 50, 15, STEP), null);
    assert.equal(futureReturn(c, 95, 15, STEP), null);
  });
});

describe("logistic regression", () => {
  it("learns a known signal and ignores noise", () => {
    const n = 20000, nf = 3;
    const X = new Float32Array(n * nf), y = new Uint8Array(n);
    let s = 7;
    const rnd = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < nf; j++) X[i * nf + j] = rnd() * 2 - 1;
      y[i] = rnd() < 1 / (1 + Math.exp(-3 * X[i * nf])) ? 1 : 0; // only feature 0 matters
    }
    const rows = Int32Array.from({ length: n }, (_, i) => i);
    const m = train(X, y, nf, rows, { l2: 1e-4, epochs: 3, batch: 256, lr: 0.02 });
    assert.ok(m.weights[0] > 1, `w0=${m.weights[0]}`);
    assert.ok(Math.abs(m.weights[1]) < 0.15 && Math.abs(m.weights[2]) < 0.15);
    assert.ok(predict(m, [0.9, 0, 0]) > 0.8 && predict(m, [-0.9, 0, 0]) < 0.2);
    const z = contributions(m, [0.9, 0, 0]).reduce((a, b) => a + b, m.bias);
    assert.ok(Math.abs(1 / (1 + Math.exp(-z)) - predict(m, [0.9, 0, 0])) < 1e-9);
  });
});

describe("metrics", () => {
  it("auc: perfect, inverted, random, ties", () => {
    assert.equal(auc([0.1, 0.2, 0.8, 0.9], [0, 0, 1, 1]), 1);
    assert.equal(auc([0.9, 0.8, 0.2, 0.1], [0, 0, 1, 1]), 0);
    assert.equal(auc([0.5, 0.5, 0.5, 0.5], [0, 1, 0, 1]), 0.5);
  });
  it("log loss of a constant 50% guess is ln 2", () => {
    assert.ok(Math.abs(logLoss([0.5, 0.5], [0, 1]) - Math.LN2) < 1e-12);
  });
  it("calibration buckets cover every row", () => {
    const cal = calibration([0.1, 0.2, 0.3, 0.4, 0.6, 0.7, 0.8, 0.9], [0, 0, 0, 1, 0, 1, 1, 1], 4);
    assert.equal(cal.reduce((a, b) => a + b.n, 0), 8);
    assert.equal(cal[3].actual, 1);
  });
  it("spaced trade stats skip trades that overlap an open one", () => {
    const p = [0.7, 0.7, 0.7, 0.7], r = [0.001, 0.001, -0.001, 0.001], ts = [0, 60, 120, 180];
    assert.equal(tradeStats(p, r, 0.6, 0).trades, 4);
    const spaced = tradeStats(p, r, 0.6, 0, ts, 120); // each trade lasts 120: takes rows 0 and 2
    assert.equal(spaced.trades, 2);
    assert.equal(spaced.hitRate, 0.5);
    assert.ok(Math.abs(spaced.hitRateSe - 0.5 / Math.SQRT2) < 1e-12);
  });
  it("trade stats: long/short by threshold, fees on both sides", () => {
    const t = tradeStats([0.7, 0.3, 0.5], [0.001, -0.002, 0.05], 0.6, 10);
    assert.equal(t.trades, 2);
    assert.equal(t.hitRate, 1);
    assert.ok(Math.abs(t.grossBp - 15) < 1e-9); // (+10 bp long, +20 bp short) / 2
    assert.ok(Math.abs(t.netBp - -5) < 1e-9);
  });
});

describe("local LLM (Ollama)", () => {
  it("reports an unreachable Ollama as 503", async () => {
    process.env.OLLAMA_URL = "http://127.0.0.1:9"; // nothing listens on the discard port
    const { explainSignal, LlmError } = await import("../lib/llm");
    const signal = {
      symbol: "BTCUSDT", horizonMinutes: 15, at: 0, close: 1, pUp: 0.5, lean: "none", drivers: [], patterns: [], recent: [],
      model: { id: 1, trainedAt: "", test: { from: 0, to: 0, n: 1, accuracy: 0.5, upRate: 0.5, auc: 0.5 }, atLean: null, feeBpRoundTrip: 20 },
    } as const;
    await assert.rejects(explainSignal(signal as never), (e) => e instanceof LlmError && e.status === 503);
  });
});
