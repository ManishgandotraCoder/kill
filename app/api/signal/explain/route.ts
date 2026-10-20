import { explainSignal, LlmError } from "@/lib/llm";
import { parseSignalParams } from "@/lib/signal-params";
import { getSignal, SignalError } from "@/lib/signal";

// POST /api/signal/explain?symbol=BTCUSDT&interval=1h&horizon=4 -> a local LLM's (Ollama) plain-English
// reading of the current signal. The signal is recomputed server-side (nothing from the client goes
// into the prompt); cached per candle.
export async function POST(req: Request) {
  const q = parseSignalParams(req.url);
  if (typeof q === "string") return new Response(q, { status: 400 });
  try {
    return Response.json(await explainSignal(await getSignal(q.symbol, q.interval, q.horizon)));
  } catch (err) {
    if (err instanceof SignalError) return new Response(err.message, { status: 404 });
    if (err instanceof LlmError) return new Response(err.message, { status: err.status });
    throw err;
  }
}
