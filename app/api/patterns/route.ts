import { ForecastError, patternScoreboard } from "@/lib/predict";

// GET /api/patterns?symbol=BTCUSDT -> what every candlestick pattern was followed by, over all stored 1h candles
export async function GET(req: Request) {
  const symbol = (new URL(req.url).searchParams.get("symbol") ?? "BTCUSDT").toUpperCase();
  if (!/^[A-Z0-9]{5,20}$/.test(symbol)) return new Response("Bad symbol", { status: 400 });
  try {
    return Response.json(await patternScoreboard(symbol));
  } catch (err) {
    if (err instanceof ForecastError) return new Response(err.message, { status: 422 });
    throw err;
  }
}
