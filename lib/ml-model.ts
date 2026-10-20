// Logistic regression for P(price higher after the horizon), plus honest evaluation helpers.
// Pure; no dependencies. Chosen over black-box models because each prediction splits into
// per-feature contributions (weight x standardized value) that can be shown and explained.

export interface LinearModel {
  /** Standardization fitted on the training split only. */
  mean: number[];
  std: number[];
  weights: number[];
  bias: number;
}

const CLIP = 5;
const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

/** Mean/std per column over the given rows (std floored so constant columns stay finite). */
export function fitScaler(X: Float32Array, nf: number, rows: Int32Array) {
  const mean = new Array(nf).fill(0), sq = new Array(nf).fill(0);
  for (const r of rows) for (let j = 0; j < nf; j++) mean[j] += X[r * nf + j];
  for (let j = 0; j < nf; j++) mean[j] /= rows.length;
  for (const r of rows) for (let j = 0; j < nf; j++) sq[j] += (X[r * nf + j] - mean[j]) ** 2;
  const std = sq.map((s) => Math.max(Math.sqrt(s / rows.length), 1e-6));
  return { mean, std };
}

const scaled = (m: Pick<LinearModel, "mean" | "std">, x: ArrayLike<number>, off: number, j: number) =>
  Math.max(-CLIP, Math.min(CLIP, (x[off + j] - m.mean[j]) / m.std[j]));

export function predict(m: LinearModel, x: ArrayLike<number>, off = 0): number {
  let z = m.bias;
  for (let j = 0; j < m.weights.length; j++) z += m.weights[j] * scaled(m, x, off, j);
  return sigmoid(z);
}

/** Per-feature contribution to the log-odds of "up" for one row. */
export function contributions(m: LinearModel, x: ArrayLike<number>, off = 0): number[] {
  return m.weights.map((w, j) => w * scaled(m, x, off, j));
}

export interface TrainOptions {
  l2: number;
  epochs: number;
  batch: number;
  lr: number;
  seed?: number;
}

/** Mini-batch Adam on log loss + L2, rows visited in a seeded shuffled order. */
export function train(X: Float32Array, y: Uint8Array, nf: number, rows: Int32Array, o: TrainOptions): LinearModel {
  const { mean, std } = fitScaler(X, nf, rows);
  const m: LinearModel = { mean, std, weights: new Array(nf).fill(0), bias: 0 };
  let pos = 0;
  for (const r of rows) pos += y[r];
  const base = pos / rows.length;
  m.bias = Math.log(base / (1 - base));

  const mw = new Float64Array(nf + 1), vw = new Float64Array(nf + 1), g = new Float64Array(nf + 1);
  const b1 = 0.9, b2 = 0.999, eps = 1e-8;
  let step = 0;
  let s = o.seed ?? 1;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const order = Int32Array.from(rows);
  const xs = new Float64Array(nf);

  for (let e = 0; e < o.epochs; e++) {
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    for (let start = 0; start < order.length; start += o.batch) {
      const end = Math.min(order.length, start + o.batch);
      g.fill(0);
      for (let b = start; b < end; b++) {
        const r = order[b];
        let z = m.bias;
        for (let j = 0; j < nf; j++) {
          xs[j] = scaled(m, X, r * nf, j);
          z += m.weights[j] * xs[j];
        }
        const err = sigmoid(z) - y[r];
        for (let j = 0; j < nf; j++) g[j] += err * xs[j];
        g[nf] += err;
      }
      const n = end - start;
      step++;
      for (let j = 0; j <= nf; j++) {
        const grad = g[j] / n + (j < nf ? o.l2 * m.weights[j] : 0);
        mw[j] = b1 * mw[j] + (1 - b1) * grad;
        vw[j] = b2 * vw[j] + (1 - b2) * grad * grad;
        const upd = (o.lr * (mw[j] / (1 - b1 ** step))) / (Math.sqrt(vw[j] / (1 - b2 ** step)) + eps);
        if (j < nf) m.weights[j] -= upd;
        else m.bias -= upd;
      }
    }
  }
  return m;
}

// ---- evaluation ----

export function logLoss(p: ArrayLike<number>, y: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const q = Math.min(1 - 1e-12, Math.max(1e-12, p[i]));
    s -= y[i] ? Math.log(q) : Math.log(1 - q);
  }
  return s / p.length;
}

/** Area under the ROC curve (0.5 = no skill), with ties handled by average rank. */
export function auc(p: ArrayLike<number>, y: ArrayLike<number>): number {
  const idx = Array.from({ length: p.length }, (_, i) => i).sort((a, b) => p[a] - p[b]);
  let rankSum = 0, pos = 0;
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j + 1 < idx.length && p[idx[j + 1]] === p[idx[i]]) j++;
    const rank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) if (y[idx[k]]) {
      rankSum += rank;
      pos++;
    }
    i = j + 1;
  }
  const neg = p.length - pos;
  return pos && neg ? (rankSum - (pos * (pos + 1)) / 2) / (pos * neg) : 0.5;
}

/** Predicted vs actual up-rate in equal-size buckets of predicted probability. */
export function calibration(p: ArrayLike<number>, y: ArrayLike<number>, buckets = 10) {
  const idx = Array.from({ length: p.length }, (_, i) => i).sort((a, b) => p[a] - p[b]);
  return Array.from({ length: buckets }, (_, b) => {
    const part = idx.slice(Math.floor((b * idx.length) / buckets), Math.floor(((b + 1) * idx.length) / buckets));
    const mp = part.reduce((a, i) => a + p[i], 0) / part.length;
    const my = part.reduce((a, i) => a + y[i], 0) / part.length;
    return { predicted: mp, actual: my, n: part.length };
  });
}

export interface TradeStats {
  threshold: number;
  trades: number;
  /** Share of trades whose direction was right. */
  hitRate: number;
  /** Standard error of hitRate (hit rate is uncertain by about +-2 of these). */
  hitRateSe: number;
  /** Mean return per trade, basis points (1 bp = 0.01%). */
  grossBp: number;
  netBp: number;
}

/**
 * Long when p >= threshold, short when p <= 1 - threshold, held for the horizon.
 * netBp subtracts feeBpPerSide twice (open + close). With `ts` and `spacingMs`, a new trade only
 * opens once the previous one has closed (no overlapping trades); otherwise every row may trade.
 */
export function tradeStats(
  p: ArrayLike<number>, ret: ArrayLike<number>, threshold: number, feeBpPerSide: number,
  ts?: ArrayLike<number>, spacingMs = 0,
): TradeStats {
  let n = 0, hits = 0, sum = 0, freeAt = -Infinity;
  for (let i = 0; i < p.length; i++) {
    if (ts && ts[i] < freeAt) continue;
    const side = p[i] >= threshold ? 1 : p[i] <= 1 - threshold ? -1 : 0;
    if (!side) continue;
    const r = side * ret[i] * 1e4;
    n++;
    sum += r;
    if (r > 0) hits++;
    if (ts) freeAt = ts[i] + spacingMs;
  }
  const gross = n ? sum / n : 0, hit = n ? hits / n : 0;
  return { threshold, trades: n, hitRate: hit, hitRateSe: n ? Math.sqrt((hit * (1 - hit)) / n) : 0, grossBp: gross, netBp: n ? gross - 2 * feeBpPerSide : 0 };
}
