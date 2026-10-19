// Next-hour forecast trained on the 1h candles stored in the DB.
//
// Two parts:
//  1. Direction/size: ridge regression on hand-made features of the last closed
//     candles -> expected log return of the next hour (mu).
//  2. Uncertainty: EWMA volatility (RiskMetrics, lambda 0.94) scaled by an
//     hour-of-day factor -> sigma. Band = mu +/- z * sigma, with z calibrated so
//     80% of training hours land inside it.
//
// Any hour can be predicted "as of" its start: the model is trained only on
// candles that closed before that hour, so past points are honest tests.
// explainAt() also breaks a forecast down into per-feature contributions and
// finds the most similar 12-candle patterns in history (nearest neighbours).
//
// Hourly crypto returns are close to a random walk, so expect direction
// accuracy near 50%. The volatility band is the part that carries real signal.

import { ensureSchema, pool } from "./db";
import { type Discovered, discoveredAt } from "./discover";
import { type Direction, detectMask, type PatternGroup, PATTERNS } from "./patterns";
import { startSync } from "./syncCandles";

const HOUR_MS = 3_600_000;
const LOOKBACK = 168; // features need one week of history
const MIN_TRAIN = 2000; // hours of history needed before a point can be predicted
const LAMBDA_EWMA = 0.94;
const RIDGE = 5000; // strong shrinkage: 39 features, many rare pattern flags (chosen by backtest)
const BAND = 0.8;
const PATTERN = 12; // candles compared when matching patterns
const NEIGHBOURS = 50;

interface Bar {
  ts: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface Forecast {
  symbol: string;
  /** Open time (ms) of the hour being predicted; it closes at targetTs + 1h. */
  targetTs: number;
  /** Close of the last finished hour - the starting point. */
  baseClose: number;
  predictedClose: number;
  lower: number;
  upper: number;
  /** Expected change in %, and the model's probability that the hour closes higher. */
  expectedPct: number;
  probUp: number;
  sigmaPct: number;
  backtest: {
    trainHours: number;
    testHours: number;
    testFrom: number;
    directionAccuracy: number; // % of test hours where the sign was right
    modelMaePct: number; // mean abs error of the predicted close, %
    naiveMaePct: number; // same for "price won't change"
    bandCoverage: number; // % of test hours that closed inside the 80% band
  };
  /** Record of all prediction-run hours that have closed. */
  live: { count: number; directionAccuracy: number | null; bandCoverage: number | null };
}

/** [openTime ms, open, high, low, close] */
export type MiniCandle = [number, number, number, number, number];

export interface Explanation {
  symbol: string;
  targetTs: number;
  /** Close time of the last candle the forecast used (= targetTs unless Binance has a gap). */
  basedOnUntil: number;
  baseClose: number;
  predictedClose: number;
  lower: number;
  upper: number;
  expectedPct: number;
  probUp: number;
  actual: { close: number; pct: number; directionRight: boolean; inRange: boolean } | null;
  trainedOn: { hours: number; from: number; to: number };
  /** Average hourly return in training - where the forecast starts before any feature. */
  baselinePct: number;
  /** Sorted by size of effect. */
  drivers: { label: string; detail: string; learned: string; contributionPct: number }[];
  volatility: { recentPct: number; hourFactor: number; z: number; rangePct: number };
  /** Candlestick patterns completed on the last closed candle, with their track record before this hour. */
  candlePatterns: { baselineUpPct: number; detected: PatternInfo[] };
  /** Discovered (data-mined, validated) patterns ending on the last closed candle. Found with all stored data. */
  discovered: Discovered[];
  pattern: MiniCandle[];
  similar: {
    matches: {
      endTs: number;
      similarity: number; // shape correlation, %
      candles: MiniCandle[]; // PATTERN candles + the one that came next
      nextPct: number;
      why: string[];
    }[];
    stats: { count: number; up: number; down: number; meanPct: number; medianPct: number };
  };
}

export interface PatternStats {
  count: number;
  upPct: number; // % of times the next hour closed higher
  avgPct: number; // average next-hour move
  z: number; // how far upPct is from an ordinary hour, in standard errors
  verdict: "up" | "down" | "none" | "rare"; // what history says (|z| >= 2 counts)
}

export interface PatternInfo {
  id: string;
  name: string;
  group: PatternGroup;
  textbook: Direction;
  candles: number;
  description: string;
  stats: PatternStats;
  /** Push on this forecast from the pattern's model feature, in %. */
  contributionPct: number;
}

export class ForecastError extends Error {}

// ---- features -------------------------------------------------------------

const lr = (a: number, b: number) => Math.log(a / b);

/** Features known at the close of bar t, for predicting bar t+1. */
function features(bars: Bar[], t: number, sigma: number, mask: number): number[] {
  const c = (k: number) => bars[t - k].c;
  const b = bars[t];
  let sma24 = 0;
  for (let k = 0; k < 24; k++) sma24 += c(k);
  sma24 /= 24;
  let sma168 = 0;
  for (let k = 0; k < 168; k++) sma168 += c(k);
  sma168 /= 168;
  let vol24 = 0;
  for (let k = 1; k <= 24; k++) vol24 += bars[t - k].v;
  vol24 /= 24;

  const target = new Date(b.ts + HOUR_MS);
  const hour = (target.getUTCHours() / 24) * 2 * Math.PI;
  const dow = (target.getUTCDay() / 7) * 2 * Math.PI;

  return [
    lr(c(0), c(1)), // last hour's return
    lr(c(1), c(2)),
    lr(c(2), c(3)),
    lr(c(3), c(4)),
    lr(c(0), c(6)), // momentum over 6h, 12h, 1d, 1w
    lr(c(0), c(12)),
    lr(c(0), c(24)),
    lr(c(0), c(168)),
    lr(c(0), sma24), // distance from moving averages
    lr(c(0), sma168),
    lr(b.c, b.o), // last candle body
    lr(b.h, Math.max(b.o, b.c)), // upper wick
    lr(Math.min(b.o, b.c), b.l), // lower wick
    Math.log((b.v + 1e-9) / (vol24 + 1e-9)), // volume vs last 24h
    sigma,
    Math.sin(hour),
    Math.cos(hour),
    Math.sin(dow),
    Math.cos(dow),
    // 19+: one flag per candlestick pattern completed on this candle
    ...PATTERNS.map((_, i) => (mask & (1 << i) ? 1 : 0)),
  ];
}

/** Index of the first pattern flag in the feature vector. */
const PATTERN_FEATURE = 19;

const pctTxt = (logRet: number, digits = 2) => {
  const p = (Math.exp(logRet) - 1) * 100;
  return `${p >= 0 ? "+" : ""}${p.toFixed(digits)}%`;
};
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Plain-language description of each feature (indices 15-18 are grouped below). */
const FEATURE_TEXT: { label: string; detail: (v: number) => string; up: string; down: string }[] = [
  { label: "Last hour", detail: (v) => `moved ${pctTxt(v)}`, up: "single-hour moves have tended to continue", down: "single-hour moves have tended to partly reverse" },
  { label: "2 hours ago", detail: (v) => `moved ${pctTxt(v)}`, up: "moves 2h back have tended to continue", down: "moves 2h back have tended to partly reverse" },
  { label: "3 hours ago", detail: (v) => `moved ${pctTxt(v)}`, up: "moves 3h back have tended to continue", down: "moves 3h back have tended to partly reverse" },
  { label: "4 hours ago", detail: (v) => `moved ${pctTxt(v)}`, up: "moves 4h back have tended to continue", down: "moves 4h back have tended to partly reverse" },
  { label: "Last 6 hours", detail: (v) => `${pctTxt(v)} change`, up: "6-hour trends have tended to continue", down: "6-hour moves have tended to partly reverse" },
  { label: "Last 12 hours", detail: (v) => `${pctTxt(v)} change`, up: "12-hour trends have tended to continue", down: "12-hour moves have tended to partly reverse" },
  { label: "Last 24 hours", detail: (v) => `${pctTxt(v)} change`, up: "daily trends have tended to continue", down: "after big daily moves, price has tended to pull back" },
  { label: "Last week", detail: (v) => `${pctTxt(v)} change`, up: "weekly trends have tended to continue", down: "after big weekly moves, price has tended to pull back" },
  {
    label: "vs 24h average",
    detail: (v) => `price ${pctTxt(Math.abs(v)).slice(1)} ${v >= 0 ? "above" : "below"} its 24h average`,
    up: "above the daily average has leaned up, below it has leaned down (trend-following)",
    down: "being stretched away from the daily average has leaned back toward it",
  },
  {
    label: "vs 1-week average",
    detail: (v) => `price ${pctTxt(Math.abs(v)).slice(1)} ${v >= 0 ? "above" : "below"} its 1-week average`,
    up: "above the weekly average has leaned up, below it has leaned down",
    down: "being stretched away from the weekly average has leaned back toward it",
  },
  {
    label: "Last candle body",
    detail: (v) => `${v >= 0 ? "green" : "red"} candle, body ${pctTxt(Math.abs(v)).slice(1)}`,
    up: "strong closing candles have tended to follow through",
    down: "strong closing candles have tended to partly reverse",
  },
  { label: "Upper wick", detail: (v) => `${pctTxt(v).slice(1)} long`, up: "long upper wicks have leaned up", down: "long upper wicks (selling at the highs) have leaned down" },
  { label: "Lower wick", detail: (v) => `${pctTxt(v).slice(1)} long`, up: "long lower wicks (buying at the lows) have leaned up", down: "long lower wicks have been followed by weaker hours" },
  { label: "Volume", detail: (v) => `${Math.exp(v).toFixed(2)}× the 24h average`, up: "heavy volume has leaned up", down: "heavy volume has leaned down" },
  { label: "Volatility", detail: (v) => `${(v * 100).toFixed(3)}% per hour lately`, up: "choppier markets have leaned up", down: "choppier markets have leaned down" },
];

// ---- per-symbol series cache (bars + precomputed features) ----------------

export interface Series {
  symbol: string;
  bars: Bar[];
  /** EWMA volatility known at the close of bar t (NaN for the first hours). */
  sigma: Float64Array;
  /** Features at t (null until LOOKBACK hours of history exist). */
  X: (number[] | null)[];
  /** gaps[i] = number of missing hours between bars[0] and bars[i]. */
  gaps: Int32Array;
  /** Candlestick patterns completed at bar t (bitmask over PATTERNS). */
  masks: Int32Array;
  /** Per pattern: bar indices where it occurred (with a gap-free next hour) and running up-count / return sums. */
  occ: { t: Int32Array; cumUp: Int32Array; cumRet: Float64Array }[];
  /** Same running sums over every hour, for the baseline. */
  allCumUp: Int32Array;
}

const g = globalThis as unknown as {
  forecastSeries?: Map<string, Series>;
  forecastModels?: Map<string, Model>;
  forecastBacktests?: Map<string, { lastTs: number; backtest: Forecast["backtest"] }>;
};
const seriesCache = (g.forecastSeries ??= new Map());
const modelCache = (g.forecastModels ??= new Map());
const backtestCache = (g.forecastBacktests ??= new Map());

async function loadSeries(symbol: string): Promise<Series> {
  const { rows: head } = await pool.query(
    "SELECT COUNT(*)::int AS n, MAX(ts)::float8 AS last FROM candles WHERE symbol=$1 AND interval='1h'",
    [symbol],
  );
  const cached = seriesCache.get(symbol);
  if (cached && cached.bars.length === head[0].n && cached.bars.at(-1)?.ts === head[0].last) return cached;

  const { rows } = await pool.query(
    `SELECT ts::float8 AS ts, open::float8 AS o, high::float8 AS h, low::float8 AS l,
            close::float8 AS c, volume::float8 AS v
     FROM candles WHERE symbol=$1 AND interval='1h' ORDER BY ts`,
    [symbol],
  );
  const bars = rows as Bar[];
  const n = bars.length;
  const sigma = new Float64Array(n).fill(NaN);
  const gaps = new Int32Array(n);
  for (let i = 1; i < n; i++) gaps[i] = gaps[i - 1] + (bars[i].ts - bars[i - 1].ts !== HOUR_MS ? 1 : 0);

  if (n > 25) {
    let v = 0;
    for (let t = 1; t <= 24; t++) v += lr(bars[t].c, bars[t - 1].c) ** 2;
    v /= 24;
    for (let t = 25; t < n; t++) {
      const r = lr(bars[t].c, bars[t - 1].c);
      v = LAMBDA_EWMA * v + (1 - LAMBDA_EWMA) * r * r;
      sigma[t] = Math.sqrt(v);
    }
  }
  const masks = new Int32Array(n);
  for (let t = 0; t < n; t++) masks[t] = detectMask(bars, t);
  const X = bars.map((_, t) => (t >= LOOKBACK ? features(bars, t, sigma[t], masks[t]) : null));

  const nextOk = (t: number) => t + 1 < n && gaps[t + 1] === gaps[t];
  const occ = PATTERNS.map((_, i) => {
    const ts: number[] = [];
    for (let t = 0; t < n; t++) if (masks[t] & (1 << i) && nextOk(t)) ts.push(t);
    const cumUp = new Int32Array(ts.length);
    const cumRet = new Float64Array(ts.length);
    ts.forEach((t, j) => {
      const r = bars[t + 1].c / bars[t].c - 1;
      cumUp[j] = (j ? cumUp[j - 1] : 0) + (r > 0 ? 1 : 0);
      cumRet[j] = (j ? cumRet[j - 1] : 0) + r;
    });
    return { t: Int32Array.from(ts), cumUp, cumRet };
  });
  const allCumUp = new Int32Array(n);
  for (let t = 0; t < n; t++) allCumUp[t] = (t ? allCumUp[t - 1] : 0) + (nextOk(t) && bars[t + 1].c > bars[t].c ? 1 : 0);

  const series: Series = { symbol, bars, sigma, X, gaps, masks, occ, allCumUp };
  seriesCache.set(symbol, series);
  return series;
}

// ---- dataset & model ------------------------------------------------------

interface Dataset {
  X: number[][];
  y: number[]; // next-hour log return
  sigma: number[]; // EWMA vol known at t
  targetHour: number[];
  idx: number[]; // bar index t
}

/** Training rows whose outcome (bar t+1) closed at or before bar k. */
function datasetUpTo(s: Series, k: number): Dataset {
  const d: Dataset = { X: [], y: [], sigma: [], targetHour: [], idx: [] };
  for (let t = LOOKBACK; t < k; t++) {
    if (s.gaps[t + 1] !== s.gaps[t]) continue; // pair straddles a gap in Binance's data
    d.X.push(s.X[t]!);
    d.y.push(lr(s.bars[t + 1].c, s.bars[t].c));
    d.sigma.push(s.sigma[t]);
    d.targetHour.push(new Date(s.bars[t + 1].ts).getUTCHours());
    d.idx.push(t);
  }
  return d;
}

interface Model {
  mean: number[];
  std: number[];
  w: number[];
  intercept: number;
  hourFactor: number[];
  z: number;
  trainHours: number;
}

function slice(d: Dataset, from: number, to: number): Dataset {
  return {
    X: d.X.slice(from, to),
    y: d.y.slice(from, to),
    sigma: d.sigma.slice(from, to),
    targetHour: d.targetHour.slice(from, to),
    idx: d.idx.slice(from, to),
  };
}

function fit(d: Dataset): Model {
  const n = d.X.length;
  const p = d.X[0].length;
  const mean = new Array(p).fill(0);
  const std = new Array(p).fill(0);
  for (const x of d.X) for (let j = 0; j < p; j++) mean[j] += x[j] / n;
  for (const x of d.X) for (let j = 0; j < p; j++) std[j] += (x[j] - mean[j]) ** 2 / n;
  for (let j = 0; j < p; j++) std[j] = Math.sqrt(std[j]) || 1;
  const ym = d.y.reduce((a, b) => a + b, 0) / n;

  // Ridge on standardized features: (Z'Z + lambda I) w = Z'(y - ym)
  const A = Array.from({ length: p }, () => new Array(p).fill(0));
  const bvec = new Array(p).fill(0);
  for (let i = 0; i < n; i++) {
    const z = d.X[i].map((x, j) => (x - mean[j]) / std[j]);
    const yi = d.y[i] - ym;
    for (let j = 0; j < p; j++) {
      bvec[j] += z[j] * yi;
      for (let k = j; k < p; k++) A[j][k] += z[j] * z[k];
    }
  }
  for (let j = 0; j < p; j++) {
    A[j][j] += RIDGE;
    for (let k = 0; k < j; k++) A[j][k] = A[k][j];
  }
  const w = solve(A, bvec);

  // Hour-of-day volatility profile: some hours (US open) move more than others.
  const sq = new Array(24).fill(0);
  const cnt = new Array(24).fill(0);
  for (let i = 0; i < n; i++) {
    sq[d.targetHour[i]] += (d.y[i] / d.sigma[i]) ** 2;
    cnt[d.targetHour[i]]++;
  }
  const overall = sq.reduce((a, b) => a + b, 0) / n;
  const hourFactor = sq.map((s, h) => Math.sqrt(s / (cnt[h] || 1) / overall));

  const model: Model = { mean, std, w, intercept: ym, hourFactor, z: 1, trainHours: n };

  // Calibrate z: 80% of training residuals inside +/- z * sigma (fat tails make
  // the normal 1.28 too narrow).
  const scaled = d.X.map((x, i) => Math.abs(d.y[i] - predictMu(model, x)) / (d.sigma[i] * hourFactor[d.targetHour[i]]));
  scaled.sort((a, b) => a - b);
  model.z = scaled[Math.floor(BAND * (scaled.length - 1))];
  return model;
}

function predictMu(m: Model, x: number[]): number {
  let mu = m.intercept;
  for (let j = 0; j < x.length; j++) mu += m.w[j] * ((x[j] - m.mean[j]) / m.std[j]);
  return mu;
}

function evaluate(m: Model, d: Dataset) {
  let right = 0, counted = 0, maeModel = 0, maeNaive = 0, inside = 0;
  for (let i = 0; i < d.X.length; i++) {
    const mu = predictMu(m, d.X[i]);
    const y = d.y[i];
    if (y !== 0 && mu !== 0) {
      counted++;
      if (Math.sign(y) === Math.sign(mu)) right++;
    }
    maeModel += Math.abs(Math.exp(y) - Math.exp(mu));
    maeNaive += Math.abs(Math.exp(y) - 1);
    const half = m.z * d.sigma[i] * m.hourFactor[d.targetHour[i]];
    if (Math.abs(y - mu) <= half) inside++;
  }
  const n = d.X.length;
  return {
    directionAccuracy: (right / counted) * 100,
    modelMaePct: (maeModel / n) * 100,
    naiveMaePct: (maeNaive / n) * 100,
    bandCoverage: (inside / n) * 100,
  };
}

/** Model trained only on outcomes known by the close of bar k. Cached; history never changes. */
export function modelAsOf(s: Series, k: number): Model {
  const key = `${s.symbol}:${s.bars[k].ts}`;
  let m = modelCache.get(key);
  if (!m) {
    m = fit(datasetUpTo(s, k));
    modelCache.set(key, m);
    if (modelCache.size > 40) modelCache.delete(modelCache.keys().next().value!);
  }
  return m;
}

/** Gaussian elimination with partial pivoting. */
function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = col + 1; r < n; r++) {
      const f = M[r][col] / M[col][col];
      for (let k = col; k <= n; k++) M[r][k] -= f * M[col][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

// Normal CDF (Abramowitz-Stegun 7.1.26).
function phi(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

// ---- candlestick pattern track record ---------------------------------------

/** Track record of every pattern using only outcomes known by the close of bar k. */
export function patternStatsAsOf(s: Series, k: number): { baselineUpPct: number; stats: PatternStats[] } {
  // Occurrences at t <= k-1 have their next hour (t+1) closed by k.
  let hours = 0;
  for (let t = 0; t < k; t++) if (s.gaps[t + 1] === s.gaps[t]) hours++;
  const base = hours ? (s.allCumUp[k - 1] / hours) * 100 : 50;
  const stats = s.occ.map((o) => {
    let lo = 0, hi = o.t.length; // count of occurrences with t <= k-1
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (o.t[mid] <= k - 1) lo = mid + 1;
      else hi = mid;
    }
    const count = lo;
    if (!count) return { count, upPct: 0, avgPct: 0, z: 0, verdict: "rare" as const };
    const upPct = (o.cumUp[count - 1] / count) * 100;
    const z = (upPct - base) / (50 / Math.sqrt(count));
    const verdict = count < 30 ? "rare" : z >= 2 ? "up" : z <= -2 ? "down" : "none";
    return { count, upPct, avgPct: (o.cumRet[count - 1] / count) * 100, z, verdict } as PatternStats;
  });
  return { baselineUpPct: base, stats };
}

/** Full-history pattern scoreboard (next 1h and 4h) for the Patterns page. */
export async function patternScoreboard(symbol: string) {
  const s = await prepare(symbol);
  const k = s.bars.length - 1;
  const { baselineUpPct, stats } = patternStatsAsOf(s, k);
  const up4 = s.occ.map((o) => {
    const idx = Array.from(o.t).filter((t) => t + 4 <= k && s.gaps[t + 4] === s.gaps[t]);
    return idx.length ? (idx.filter((t) => s.bars[t + 4].c > s.bars[t].c).length / idx.length) * 100 : null;
  });
  const lastSeen = s.occ.map((o) => (o.t.length ? s.bars[o.t[o.t.length - 1]].ts : null));
  return {
    symbol,
    from: s.bars[0].ts,
    to: s.bars[k].ts + HOUR_MS,
    hours: k,
    baselineUpPct,
    patterns: PATTERNS.map((p, i) => ({
      id: p.id,
      name: p.name,
      code: p.code,
      group: p.group,
      textbook: p.textbook,
      candles: p.candles,
      description: p.description,
      stats: stats[i],
      up4hPct: up4[i],
      lastSeen: lastSeen[i],
    })),
  };
}

// ---- forecasting core -----------------------------------------------------

/** Forecast for the hour after bar k, using the model as of bar k. */
export function predictAfter(s: Series, k: number, m: Model) {
  const base = s.bars[k].c;
  const targetTs = s.bars[k].ts + HOUR_MS;
  const mu = predictMu(m, s.X[k]!);
  const hourFactor = m.hourFactor[new Date(targetTs).getUTCHours()];
  const sigma = s.sigma[k] * hourFactor;
  const half = m.z * sigma;
  return {
    targetTs,
    mu,
    sigma,
    hourFactor,
    half,
    baseClose: base,
    predictedClose: base * Math.exp(mu),
    lower: base * Math.exp(mu - half),
    upper: base * Math.exp(mu + half),
    expectedPct: (Math.exp(mu) - 1) * 100,
    probUp: phi(mu / sigma) * 100,
  };
}

/** Syncs the DB and returns the cached 1h series for a symbol. */
export async function prepare(symbol: string): Promise<Series> {
  await ensureSchema();
  const { rows: sym } = await pool.query("SELECT years_back FROM symbols WHERE symbol=$1", [symbol]);
  if (!sym.length) throw new ForecastError(`${symbol} is not in the symbols table - add it on /history first`);

  const synced = await startSync(symbol, "1h", sym[0].years_back).done;
  if (synced.status === "error") throw new ForecastError(`Sync failed: ${synced.error}`);

  const s = await loadSeries(symbol);
  if (s.bars.length < LOOKBACK + MIN_TRAIN) {
    throw new ForecastError(`Need at least ${LOOKBACK + MIN_TRAIN} hourly candles of ${symbol} in the DB (have ${s.bars.length})`);
  }
  return s;
}

/** Brings the DB up to date, (re)trains if new candles arrived, predicts the current hour. */
export async function forecastNextHour(symbol: string): Promise<Forecast> {
  const s = await prepare(symbol);
  const k = s.bars.length - 1;
  const lastTs = s.bars[k].ts;

  // Honest scorecard: a separate model trained on the first 80% of history, tested on the rest.
  let bt = backtestCache.get(symbol);
  if (!bt || bt.lastTs !== lastTs) {
    const data = datasetUpTo(s, k);
    const split = Math.floor(data.X.length * 0.8);
    const train = slice(data, 0, split);
    const test = slice(data, split, data.X.length);
    bt = {
      lastTs,
      backtest: {
        trainHours: train.X.length,
        testHours: test.X.length,
        testFrom: s.bars[test.idx[0]].ts,
        ...evaluate(fit(train), test),
      },
    };
    backtestCache.set(symbol, bt);
  }

  const p = predictAfter(s, k, modelAsOf(s, k));
  const forecast: Omit<Forecast, "live"> = {
    symbol,
    targetTs: p.targetTs,
    baseClose: p.baseClose,
    predictedClose: p.predictedClose,
    lower: p.lower,
    upper: p.upper,
    expectedPct: p.expectedPct,
    probUp: p.probUp,
    sigmaPct: p.sigma * 100,
    backtest: bt.backtest,
  };

  await resolvePredictions();
  return { ...forecast, live: await liveStats(symbol) };
}

/** Index of the last bar that opened before `ts` (i.e. closed at or before it). */
export function barBefore(s: Series, ts: number): number {
  let lo = 0, hi = s.bars.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (s.bars[mid].ts < ts) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// ---- explanation ----------------------------------------------------------

const mini = (b: Bar): MiniCandle => [b.ts, b.o, b.h, b.l, b.c];

/**
 * Explains the forecast for the 1-hour candle containing `atMs` (default: now),
 * made with only the candles that closed before that hour started. With
 * `modelFromTs` (a prediction run's start), the model is the one frozen then.
 */
export async function explainAt(symbol: string, atMs = Date.now(), modelFromTs?: number): Promise<Explanation> {
  const s = await prepare(symbol);
  const { bars } = s;
  const targetTs = Math.floor(atMs / HOUR_MS) * HOUR_MS;
  const last = bars[bars.length - 1];
  if (targetTs > last.ts + HOUR_MS) throw new ForecastError("That hour hasn't started yet - pick a candle up to the current hour.");

  // k = last candle that closed before the target hour started.
  const k = barBefore(s, targetTs);
  if (bars[k].ts + HOUR_MS !== targetTs) throw new ForecastError("Binance has no data just before that hour - pick another point.");
  if (k < LOOKBACK + MIN_TRAIN) {
    throw new ForecastError(`Not enough history before that point - need ${MIN_TRAIN} hours, pick something after ${new Date(bars[LOOKBACK + MIN_TRAIN].ts).toDateString()}.`);
  }

  const kModel = modelFromTs !== undefined ? Math.min(k, barBefore(s, modelFromTs)) : k;
  const m = modelAsOf(s, kModel);
  const p = predictAfter(s, k, m);
  const next = bars[k + 1]?.ts === targetTs ? bars[k + 1] : null;
  const actual = next && {
    close: next.c,
    pct: (next.c / p.baseClose - 1) * 100,
    directionRight: Math.sign(next.c - p.baseClose) === Math.sign(p.predictedClose - p.baseClose),
    inRange: next.c >= p.lower && next.c <= p.upper,
  };

  // Per-feature contribution: weight * standardized value (in log-return units).
  const x = s.X[k]!;
  const contrib = x.map((v, j) => m.w[j] * ((v - m.mean[j]) / m.std[j]));
  const drivers: Explanation["drivers"] = FEATURE_TEXT.map((f, j) => ({
    label: f.label,
    detail: f.detail(x[j]),
    learned: m.w[j] >= 0 ? f.up : f.down,
    contributionPct: contrib[j] * 100,
  }));
  const hourC = (contrib[15] + contrib[16]) * 100;
  drivers.push({
    label: "Time of day",
    detail: `hour starting ${new Date(targetTs).toISOString().slice(11, 16)} UTC`,
    learned: `this hour of the day has historically leaned ${hourC >= 0 ? "up" : "down"}`,
    contributionPct: hourC,
  });
  const dowC = (contrib[17] + contrib[18]) * 100;
  drivers.push({
    label: "Day of week",
    detail: `${WEEKDAYS[new Date(targetTs).getUTCDay()]} (UTC)`,
    learned: `this weekday has historically leaned ${dowC >= 0 ? "up" : "down"}`,
    contributionPct: dowC,
  });
  // Candlestick patterns: detected ones individually, absent ones lumped together.
  const { baselineUpPct, stats: pStats } = patternStatsAsOf(s, k);
  const detected: PatternInfo[] = [];
  let absent = 0;
  PATTERNS.forEach((p, i) => {
    const c = contrib[PATTERN_FEATURE + i] * 100;
    if (s.masks[k] & (1 << i)) {
      detected.push({ id: p.id, name: p.name, group: p.group, textbook: p.textbook, candles: p.candles, description: p.description, stats: pStats[i], contributionPct: c });
      const st = pStats[i];
      drivers.push({
        label: `Pattern: ${p.name}`,
        detail: `formed on the last ${p.candles > 1 ? `${p.candles} candles` : "candle"} (textbook: ${p.textbook === "neutral" ? "indecision" : p.textbook})`,
        learned:
          Math.sign(c) === Math.sign(st.upPct - baselineUpPct) || st.verdict === "none" || st.verdict === "rare"
            ? `after it, BTC closed higher ${st.upPct.toFixed(1)}% of ${st.count} times (any hour: ${baselineUpPct.toFixed(1)}%)`
            : `after it, BTC closed higher ${st.upPct.toFixed(1)}% of ${st.count} times - the momentum/shape inputs already count that for these candles, so this term only corrects the overlap`,
        contributionPct: c,
      });
    } else {
      absent += c;
    }
  });
  drivers.push({
    label: "Patterns not present",
    detail: `${PATTERNS.length - detected.length} of ${PATTERNS.length} patterns absent`,
    learned: "the absence of a pattern shifts the forecast very slightly",
    contributionPct: absent,
  });
  drivers.sort((a, b) => Math.abs(b.contributionPct) - Math.abs(a.contributionPct));

  return {
    symbol,
    targetTs,
    basedOnUntil: bars[k].ts + HOUR_MS,
    baseClose: p.baseClose,
    predictedClose: p.predictedClose,
    lower: p.lower,
    upper: p.upper,
    expectedPct: p.expectedPct,
    probUp: p.probUp,
    actual,
    trainedOn: { hours: m.trainHours, from: bars[LOOKBACK].ts, to: bars[kModel].ts + HOUR_MS },
    baselinePct: m.intercept * 100,
    drivers,
    volatility: { recentPct: s.sigma[k] * 100, hourFactor: p.hourFactor, z: m.z, rangePct: p.half * 100 },
    candlePatterns: { baselineUpPct, detected },
    discovered: discoveredAt(s, k),
    pattern: bars.slice(k - PATTERN + 1, k + 1).map(mini),
    similar: findSimilar(s, k),
  };
}

/** Shape of the PATTERN candles ending at t, relative to the last close, in units of volatility. */
function shape(s: Series, t: number): Float64Array {
  const ref = s.bars[t].c;
  const scale = s.sigma[t];
  const v = new Float64Array(PATTERN * 4);
  for (let i = 0; i < PATTERN; i++) {
    const b = s.bars[t - PATTERN + 1 + i];
    v[i * 4] = lr(b.o, ref) / scale;
    v[i * 4 + 1] = lr(b.h, ref) / scale;
    v[i * 4 + 2] = lr(b.l, ref) / scale;
    v[i * 4 + 3] = lr(b.c, ref) / scale;
  }
  return v;
}

function correlation(a: Float64Array, b: Float64Array): number {
  let ma = 0, mb = 0;
  for (let i = 0; i < a.length; i++) {
    ma += a[i] / a.length;
    mb += b[i] / b.length;
  }
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < a.length; i++) {
    sab += (a[i] - ma) * (b[i] - mb);
    saa += (a[i] - ma) ** 2;
    sbb += (b[i] - mb) ** 2;
  }
  return sab / Math.sqrt(saa * sbb || 1);
}

/**
 * Nearest neighbours: past 12-candle windows whose shape (scaled by volatility,
 * so a calm and a wild version of the same shape still match) is closest to the
 * window ending at k. Only windows whose next hour closed before k count.
 */
function findSimilar(s: Series, k: number): Explanation["similar"] {
  const cur = shape(s, k);
  const candidates: { t: number; d: number }[] = [];
  for (let t = LOOKBACK; t <= k - 24; t++) {
    if (s.gaps[t + 1] !== s.gaps[t - PATTERN + 1]) continue; // window + next hour must be gap-free
    const v = shape(s, t);
    let d = 0;
    for (let i = 0; i < v.length; i++) d += (v[i] - cur[i]) ** 2;
    candidates.push({ t, d });
  }
  candidates.sort((a, b) => a.d - b.d);

  // Greedy pick, at least PATTERN hours apart, so one episode isn't counted many times.
  const picked: number[] = [];
  for (const c of candidates) {
    if (picked.every((t) => Math.abs(t - c.t) >= PATTERN)) picked.push(c.t);
    if (picked.length >= NEIGHBOURS) break;
  }

  const nextPct = (t: number) => (s.bars[t + 1].c / s.bars[t].c - 1) * 100;
  const moves = picked.map(nextPct);
  const sorted = [...moves].sort((a, b) => a - b);

  const window12 = (t: number) => lr(s.bars[t].c, s.bars[t - PATTERN + 1].o);
  const arrows = (t: number) =>
    [2, 1, 0].map((i) => (s.bars[t - i].c >= s.bars[t - i].o ? "▲" : "▼")).join("");
  const pct = (x: number, d = 2) => `${x >= 0 ? "+" : ""}${x.toFixed(d)}%`;

  return {
    matches: picked.slice(0, 5).map((t) => ({
      endTs: s.bars[t].ts,
      similarity: correlation(cur, shape(s, t)) * 100,
      candles: s.bars.slice(t - PATTERN + 1, t + 2).map(mini),
      nextPct: nextPct(t),
      why: [
        `12h change: now ${pctTxt(window12(k))} · then ${pctTxt(window12(t))}`,
        `last 3 candles: now ${arrows(k)} · then ${arrows(t)}`,
        `vs 24h average: now ${pct(s.X[k]![8] * 100)} · then ${pct(s.X[t]![8] * 100)}`,
        `volatility: now ${(s.sigma[k] * 100).toFixed(2)}%/h · then ${(s.sigma[t] * 100).toFixed(2)}%/h`,
      ],
    })),
    stats: {
      count: moves.length,
      up: moves.filter((x) => x > 0).length,
      down: moves.filter((x) => x < 0).length,
      meanPct: moves.reduce((a, b) => a + b, 0) / (moves.length || 1),
      medianPct: sorted[Math.floor(sorted.length / 2)] ?? 0,
    },
  };
}

// ---- prediction log -------------------------------------------------------

/** Fills actual_close for predictions whose hour has closed and is in the DB. */
export async function resolvePredictions(): Promise<void> {
  await pool.query(
    `UPDATE predictions p SET actual_close = c.close
     FROM candles c
     WHERE p.actual_close IS NULL AND p.horizon_min = 60
       AND c.symbol = p.symbol AND c.interval = '1h' AND c.ts = p.target_ts`,
  );
}

async function liveStats(symbol: string): Promise<Forecast["live"]> {
  // Overlapping runs can predict the same hour; count each hour once.
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS count,
            AVG(CASE WHEN SIGN(predicted_close - base_close) = SIGN(actual_close - base_close) THEN 100.0 ELSE 0 END)::float8 AS dir,
            AVG(CASE WHEN actual_close BETWEEN lower AND upper THEN 100.0 ELSE 0 END)::float8 AS band
     FROM (SELECT DISTINCT ON (target_ts) * FROM predictions
           WHERE symbol = $1 AND actual_close IS NOT NULL AND horizon_min = 60 ORDER BY target_ts) x`,
    [symbol],
  );
  return { count: rows[0].count, directionAccuracy: rows[0].dir, bandCoverage: rows[0].band };
}
