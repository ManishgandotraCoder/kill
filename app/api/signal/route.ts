import { parseSignalParams } from "@/lib/signal-params";
import { getSignal, SignalError } from "@/lib/signal";

// GET /api/signal?symbol=BTCUSDT&interval=1h&horizon=4 -> probability price is higher after `horizon`
// candles, its drivers, just-completed patterns, and the model's out-of-sample record.
// Defaults: interval=1m, horizon=15 (1m) / 1 (1h).
export async function GET(req: Request) {
  const q = parseSignalParams(req.url);
  if (typeof q === "string") return new Response(q, { status: 400 });
  try {
    const signal: Partial<Awaited<ReturnType<typeof getSignal>>> = await getSignal(q.symbol, q.interval, q.horizon);
    delete signal.recent; // only needed for the LLM prompt
    return Response.json(signal);
  } catch (err) {
    if (err instanceof SignalError) return new Response(err.message, { status: 404 });
    throw err;
  }
}
