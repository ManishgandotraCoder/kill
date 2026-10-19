// Pattern discovery: search every 1-3 candle sequence (see candle-code.ts) in the
// stored history for ones followed by an unusual next-hour move.
//
// Searching thousands of sequences always turns up some that look strong by luck,
// so discovery is split in time:
//   1. find:  first 70% of history, need 150+ cases and |z| >= 3
//   2. check: last 30% (never used to find them) - same direction and
//      |z| >= 2 -> "confirmed", |z| >= 1 -> "weak", otherwise "failed" (it was luck)

import { CODE_MIN_INDEX, describeKey, encodeCandle, sequenceKey } from "./candle-code";
import { prepare, type Series } from "./series";

const HOUR_MS = 3_600_000;
const MAX_LEN = 3;
const FIND_SHARE = 0.7;
const MIN_CASES = 150;
const FIND_Z = 3;

export type Tier = "confirmed" | "weak" | "failed";

export interface SampleStats {
  n: number;
  upPct: number;
  avgPct: number;
  z: number;
}

export interface Discovered {
  id: string;
  key: string;
  description: string;
  candles: number;
  direction: "up" | "down";
  tier: Tier;
  find: SampleStats;
  check: SampleStats;
  all: SampleStats;
  lastSeen: number | null;
}

export interface Discovery {
  symbol: string;
  from: number;
  splitAt: number;
  to: number;
  candidates: number;
  baseFindPct: number;
  baseCheckPct: number;
  patterns: Discovered[]; // every sequence that looked strong in the find period, with its tier
}

interface Acc {
  n: number;
  up: number;
  ret: number;
  last: number;
}

type Cached = { lastTs: number; d: Discovery; codes: string[] };
const g = globalThis as unknown as { discoveries?: Map<string, Cached> };
const cache: Map<string, Cached> = (g.discoveries ??= new Map());

function stats(a: Acc | undefined, base: number): SampleStats {
  if (!a || !a.n) return { n: 0, upPct: 0, avgPct: 0, z: 0 };
  const p = a.up / a.n;
  return { n: a.n, upPct: p * 100, avgPct: (a.ret / a.n) * 100, z: (p - base) / Math.sqrt((base * (1 - base)) / a.n) };
}

function run(s: Series): { d: Discovery; codes: string[] } {
  const b = s.bars;
  const n = b.length;
  const split = Math.floor(n * FIND_SHARE);
  const codes = b.map((_, t) => (t >= 20 ? encodeCandle(b, t) : ""));
  const find = new Map<string, Acc>(), check = new Map<string, Acc>();
  const bf = { n: 0, up: 0 }, bc = { n: 0, up: 0 };

  for (let t = CODE_MIN_INDEX; t < n - 1; t++) {
    if (s.gaps[t + 1] !== s.gaps[t]) continue;
    const r = b[t + 1].c / b[t].c - 1;
    const inFind = t + 1 < split;
    const base = inFind ? bf : bc;
    base.n++;
    if (r > 0) base.up++;
    for (let len = 1; len <= MAX_LEN; len++) {
      if (s.gaps[t] !== s.gaps[t - len + 1]) continue;
      const k = sequenceKey(b, t, len, codes);
      if (!k) continue;
      const m = inFind ? find : check;
      const a = m.get(k) ?? { n: 0, up: 0, ret: 0, last: 0 };
      a.n++;
      if (r > 0) a.up++;
      a.ret += r;
      a.last = b[t].ts;
      m.set(k, a);
    }
  }

  const pF = bf.up / bf.n, pC = bc.up / bc.n, pAll = (bf.up + bc.up) / (bf.n + bc.n);
  const tierOrder: Record<Tier, number> = { confirmed: 0, weak: 1, failed: 2 };
  const patterns = [...find]
    .map(([key, a]) => ({ key, f: stats(a, pF) }))
    .filter(({ f }) => f.n >= MIN_CASES && Math.abs(f.z) >= FIND_Z)
    .map(({ key, f }) => {
      const cAcc = check.get(key);
      const c = stats(cAcc, pC);
      const fa = find.get(key)!;
      const all = stats(cAcc ? { n: fa.n + cAcc.n, up: fa.up + cAcc.up, ret: fa.ret + cAcc.ret, last: 0 } : fa, pAll);
      const dir = f.z > 0 ? 1 : -1;
      const held = c.n >= 40 ? c.z * dir : -Infinity;
      const tier: Tier = held >= 2 ? "confirmed" : held >= 1 ? "weak" : "failed";
      return {
        id: "",
        key,
        description: describeKey(key),
        candles: key.split("|")[1].split(" ").length,
        direction: dir > 0 ? ("up" as const) : ("down" as const),
        tier,
        find: f,
        check: c,
        all,
        lastSeen: cAcc?.last || fa.last || null,
      };
    })
    .sort((x, y) => tierOrder[x.tier] - tierOrder[y.tier] || Math.abs(y.check.z) - Math.abs(x.check.z));
  patterns.forEach((p, i) => (p.id = `N${i + 1}`));

  return {
    codes,
    d: {
      symbol: s.symbol,
      from: b[0].ts,
      splitAt: b[split].ts,
      to: b[n - 1].ts + HOUR_MS,
      candidates: find.size,
      baseFindPct: pF * 100,
      baseCheckPct: pC * 100,
      patterns,
    },
  };
}

function cached(s: Series) {
  const lastTs = s.bars[s.bars.length - 1].ts;
  let hit = cache.get(s.symbol);
  if (!hit || hit.lastTs !== lastTs) {
    hit = { lastTs, ...run(s) };
    cache.set(s.symbol, hit);
  }
  return hit;
}

export async function discover(symbol: string): Promise<Discovery> {
  return cached(await prepare(symbol)).d;
}
