import { discover } from "@/lib/discover";
import { ForecastError } from "@/lib/predict";

// GET /api/discovered?symbol=BTCUSDT -> candle sequences mined from history, with out-of-sample check
export async function GET(req: Request) {
  const symbol = (new URL(req.url).searchParams.get("symbol") ?? "BTCUSDT").toUpperCase();
  if (!/^[A-Z0-9]{5,20}$/.test(symbol)) return new Response("Bad symbol", { status: 400 });
  try {
    return Response.json(await discover(symbol));
  } catch (err) {
    if (err instanceof ForecastError) return new Response(err.message, { status: 422 });
    throw err;
  }
}
