// Plain-English explanation of a Signal by a local LLM via Ollama (server-side; nothing leaves the machine).
// Configure with OLLAMA_URL (default http://localhost:11434) and OLLAMA_MODEL (default llama3.2).

import type { Signal } from "./signal";

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const MODEL = process.env.OLLAMA_MODEL ?? "llama3.2";

export class LlmError extends Error {
  constructor(message: string, readonly status = 502) {
    super(message);
  }
}

const SYSTEM = `You explain a Bitcoin up/down signal produced by a logistic-regression model trained on 5 years of candles (timeframe given in the data).
Write for a non-expert in at most 150 words, as 3-5 short bullet points in Markdown:
- what the model leans toward for the next window and how strong that lean is,
- which inputs drove it (use the drivers: positive contribution pushes toward "up", negative toward "down"),
- what any just-completed candlestick patterns did historically,
- how reliable this is, using the out-of-sample test numbers (and their +- margins) and comparing the average move to the round-trip fees.
Never present it as certain or as financial advice. Do not invent numbers; use only the data given.`;

const g = globalThis as unknown as { llmCache?: Map<string, string> };
const cache = (g.llmCache ??= new Map());

export async function explainSignal(s: Signal): Promise<{ text: string; model: string; cached: boolean }> {
  const cacheKey = `${MODEL}:${s.symbol}:${s.at}:${s.model.id}`;
  const hit = cache.get(cacheKey);
  if (hit) return { text: hit, model: MODEL, cached: true };

  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const data = {
    symbol: s.symbol,
    candles: s.interval,
    window: `next ${s.horizonLabel} after the ${s.interval} candle that opened ${new Date(s.at).toISOString()} closed`,
    probabilityHigher: pct(s.pUp),
    lean: s.lean,
    drivers: s.drivers.map((d) => ({ input: d.label, value: +d.value.toFixed(3), contribution: +d.contribution.toFixed(4) })),
    patternsJustCompleted: s.patterns.map((p) => ({ name: p.name, textbook: p.direction, [`historicallyHigher${s.horizonLabel.replace(" ", "")}Later`]: pct(p.historicalUpRate), avgMoveBp: +p.historicalAvgBp.toFixed(2), times: p.n })),
    outOfSampleTest: {
      period: `${new Date(s.model.test.from).toISOString().slice(0, 10)} to ${new Date(s.model.test.to).toISOString().slice(0, 10)}`,
      candles: s.model.test.n,
      method: s.model.evaluation,
      accuracy: pct(s.model.test.accuracy) + (s.model.test.accuracySe ? ` +-${(200 * s.model.test.accuracySe).toFixed(1)} points` : ""),
      shareOfWindowsThatWentUp: pct(s.model.test.upRate),
      whenLeaning: s.model.atLean && {
        nonOverlappingTrades: s.model.atLean.trades,
        rightDirection: `${pct(s.model.atLean.hitRate)} +-${(200 * s.model.atLean.hitRateSe).toFixed(1)} points`,
        avgMoveBp: +s.model.atLean.grossBp.toFixed(2),
      },
      roundTripFeesBp: s.model.feeBpRoundTrip,
    },
    last10Candles: s.recent.slice(-10).map((k) => ({ t: new Date(k.ts).toISOString().slice(s.interval === "1m" ? 11 : 5, 16), o: k.o, h: k.h, l: k.l, c: k.c, v: +k.v.toFixed(2) })),
  };

  let res: Response;
  try {
    res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        stream: false,
        options: { temperature: 0.2, num_predict: 500 },
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: `Explain this signal:\n${JSON.stringify(data, null, 1)}` },
        ],
      }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (err) {
    throw new LlmError(`Can't reach Ollama at ${OLLAMA_URL} - is it running? (ollama serve) [${err instanceof Error ? err.message : err}]`, 503);
  }
  if (res.status === 404) throw new LlmError(`Ollama model "${MODEL}" not found - run: ollama pull ${MODEL}`, 503);
  if (!res.ok) throw new LlmError(`Ollama ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as { message?: { content?: string } };
  const text = (body.message?.content ?? "").trim();
  if (!text) throw new LlmError("Ollama returned an empty answer");
  cache.set(cacheKey, text);
  if (cache.size > 200) cache.delete(cache.keys().next().value!);
  return { text, model: MODEL, cached: false };
}
