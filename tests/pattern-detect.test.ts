import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_DETECT_CONFIG, detectRange, PATTERN_INFO, PATTERN_KEYS, prepareCandles, swingPoints, validateConfig,
  type Candle, type PatternKey,
} from "../lib/pattern-detect";
import { EXAMPLE_PREROLL, exampleCandles, PATTERN_EXAMPLES } from "../lib/pattern-examples";
import { randomWalk, withTs } from "./fixtures";

const H = 3_600_000;
const found = (c: Candle[], cfg = DEFAULT_DETECT_CONFIG) => detectRange(c, H, 0, cfg).detections;
const keys = (c: Candle[], cfg = DEFAULT_DETECT_CONFIG) => found(c, cfg).map((d) => d.pattern);
/** Example path without its final breakout leg (ends at the last swing point). */
const noBreakout = (k: PatternKey) => PATTERN_EXAMPLES[k].slice(0, -1);

describe("textbook examples", () => {
  for (const k of PATTERN_KEYS) {
    it(`${PATTERN_INFO[k].name}: detected on breakout, not before`, () => {
      const c = exampleCandles(PATTERN_EXAMPLES[k]);
      const d = found(c).filter((x) => x.pattern === k).at(-1); // the example's own (final) breakout
      assert.ok(d, `${k} not detected: got ${keys(c).join(", ") || "nothing"}`);
      if (PATTERN_INFO[k].direction !== "neutral") assert.equal(d.direction, PATTERN_INFO[k].direction);
      // the breakout candle's close is past the line, the previous close was not past it (line value one candle earlier)
      const t = c.findIndex((x) => x.ts === d.ts);
      const line = d.meta.lines.find((l) => l.b.ts === d.ts && Math.abs(l.b.p - d.meta.level) < 1e-6)!;
      const prevLevel = line.b.p - ((line.b.p - line.a.p) / (line.b.ts - line.a.ts)) * H;
      const beyond = (close: number, level: number) => (d.direction === "bullish" ? close > level : close < level);
      assert.ok(beyond(c[t].c, d.meta.level) && !beyond(c[t - 1].c, prevLevel));
      assert.ok(d.startTs < d.ts && d.candles === (d.ts - d.startTs) / H + 1);
      assert.ok(d.meta.points.every((p) => p.ts >= d.startTs && p.ts < d.ts));
      // without the breakout leg there is no detection after the last swing point
      const lastSwing = d.meta.points[d.meta.points.length - 1].ts;
      assert.ok(!found(exampleCandles(noBreakout(k))).some((x) => x.pattern === k && x.ts > lastSwing));
    });
  }
});

describe("near misses are rejected", () => {
  it("double top: tops too far apart in height", () => {
    assert.ok(!keys(exampleCandles([[0, 100], [20, 130], [32, 118], [44, 125], [64, 105]])).includes("double_top"));
  });
  it("double top: dip too shallow", () => {
    assert.ok(!keys(exampleCandles([[0, 100], [20, 130], [24, 128], [28, 130], [48, 105]])).includes("double_top"));
  });
  it("head and shoulders: head not higher than the shoulders", () => {
    const k = keys(exampleCandles([[0, 100], [20, 125], [32, 113], [44, 125.5], [56, 113], [68, 125], [88, 100]]));
    assert.ok(!k.includes("head_and_shoulders"));
    assert.ok(k.includes("triple_top")); // equal highs: that shape is a triple top
  });
  it("head and shoulders: lopsided shoulders", () => {
    assert.ok(!keys(exampleCandles([[0, 100], [20, 118], [32, 113], [50, 140], [68, 113], [80, 130], [100, 100]])).includes("head_and_shoulders"));
  });
  it("bull flag: pole too slow", () => {
    assert.ok(!keys(exampleCandles([[0, 100], [60, 140], [70, 130], [80, 136], [90, 126], [105, 146]])).includes("bull_flag"));
  });
  it("bull flag: consolidation gives back more than half the pole", () => {
    assert.ok(!keys(exampleCandles([[0, 100], [20, 140], [30, 115], [40, 121], [50, 111], [65, 146]])).includes("bull_flag"));
  });
  it("ascending triangle: top not flat", () => {
    assert.ok(!keys(exampleCandles([[0, 100], [15, 120], [30, 108], [50, 130], [65, 118], [80, 140], [88, 135], [100, 150]])).includes("ascending_triangle"));
  });
});

describe("no look-ahead", () => {
  const c = withTs(randomWalk(6000, 11)); // 1m-spaced timestamps; pass the matching step
  const STEP = 60_000;
  const all = detectRange(c, STEP).detections;
  it("random walk produces chart patterns", () => assert.ok(all.length > 20, String(all.length)));
  it("detections up to t are identical with the future cut off", () => {
    for (const cut of [1500, 3333, 5999]) {
      assert.deepEqual(detectRange(c.slice(0, cut + 1), STEP).detections, all.filter((d) => d.ts <= c[cut].ts));
    }
  });
  it("changing future candles never changes past detections", () => {
    const changed = c.map((k, i) => (i > 3000 ? { ...k, o: k.c, h: k.c + 80, l: k.c - 80 } : k));
    const upTo = (ds: typeof all) => ds.filter((d) => d.ts <= c[3000].ts);
    assert.deepEqual(upTo(detectRange(changed, STEP).detections), upTo(all));
  });
  it("detecting from an index with warm-up history matches a full scan", () => {
    const from = 4000;
    assert.deepEqual(detectRange(c, STEP, from).detections, all.filter((d) => d.ts >= c[from].ts));
  });
});

describe("swing points, gaps, input", () => {
  it("swing points alternate high / low", () => {
    const pts = swingPoints(exampleCandles(PATTERN_EXAMPLES.head_and_shoulders), H);
    assert.ok(pts.length >= 6);
    for (let i = 1; i < pts.length; i++) assert.notEqual(pts[i].type, pts[i - 1].type);
    assert.deepEqual(pts.slice(1, 6).map((p) => Math.round(p.p)), [125, 113, 140, 113, 125]);
  });
  it("a gap inside a pattern resets the swing points: no detection across it", () => {
    const c = exampleCandles(PATTERN_EXAMPLES.double_top);
    const gapped = c.map((k, i) => (i >= EXAMPLE_PREROLL + 32 ? { ...k, ts: k.ts + 5 * H } : k)); // 5 h missing at the neckline
    assert.ok(keys(c).includes("double_top"));
    assert.ok(!keys(gapped).includes("double_top"));
  });
  it("counts candles without ATR history as skipped", () => {
    assert.equal(detectRange(exampleCandles(PATTERN_EXAMPLES.double_top), H).skipped, DEFAULT_DETECT_CONFIG.atrPeriod - 1);
  });
  it("unsorted input and duplicate timestamps are normalised", () => {
    const sorted = exampleCandles(PATTERN_EXAMPLES.triple_top);
    const shuffled = [...sorted].reverse();
    shuffled.push({ ...sorted[50], c: sorted[50].l }); // same ts, different values, seen last -> dropped
    const p = prepareCandles(shuffled);
    assert.equal(p.unsorted, true);
    assert.equal(p.duplicates, 1);
    assert.deepEqual(detectRange(p.candles, H).detections, detectRange(sorted, H).detections);
  });
  it("drops invalid candles", () => {
    const c = exampleCandles(PATTERN_EXAMPLES.double_top);
    const bad: Candle[] = [{ ...c[5], h: c[5].l - 1 }, { ...c[6], o: NaN }, { ...c[7], l: 0 }];
    const p = prepareCandles([...c.slice(0, 5), ...bad, ...c.slice(8)]);
    assert.equal(p.invalid, 3);
    assert.equal(p.candles.length, c.length - 3);
  });
});

describe("config", () => {
  it("rejects nonsense", () => {
    assert.throws(() => validateConfig({ ...DEFAULT_DETECT_CONFIG, minSpan: 500 }));
    assert.throws(() => validateConfig({ ...DEFAULT_DETECT_CONFIG, warmupBars: 10 }));
  });
  it("thresholds are configurable", () => {
    const c = exampleCandles([[0, 100], [20, 130], [32, 118], [44, 127], [64, 105]]); // tops 3 apart
    assert.ok(!keys(c).includes("double_top"));
    assert.ok(keys(c, { ...DEFAULT_DETECT_CONFIG, equalAtr: 5 }).includes("double_top"));
  });
});
