import { explainAt, ForecastError } from "@/lib/predict";

// GET /api/explain?symbol=BTCUSDT[&at=<ms>]
// Why the model predicts what it does for the 1h candle containing `at`
// (default: the current hour), using only data from before that hour.
export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  const symbol = (p.get("symbol") ?? "BTCUSDT").toUpperCase();
  const at = p.get("at") ? Number(p.get("at")) : undefined;
  if (!/^[A-Z0-9]{5,20}$/.test(symbol)) return new Response("Bad symbol", { status: 400 });
  if (at !== undefined && !Number.isFinite(at)) return new Response("Bad time", { status: 400 });
  try {
    return Response.json(await explainAt(symbol, at));
  } catch (err) {
    if (err instanceof ForecastError) return new Response(err.message, { status: 422 });
    throw err;
  }
}
