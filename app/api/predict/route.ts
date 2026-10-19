import { forecastNextHour, ForecastError } from "@/lib/predict";

// GET /api/predict?symbol=BTCUSDT -> forecast for the current 1h candle
export async function GET(req: Request) {
  const symbol = (new URL(req.url).searchParams.get("symbol") ?? "BTCUSDT").toUpperCase();
  if (!/^[A-Z0-9]{5,20}$/.test(symbol)) return new Response("Bad symbol", { status: 400 });
  try {
    return Response.json(await forecastNextHour(symbol));
  } catch (err) {
    if (err instanceof ForecastError) return new Response(err.message, { status: 404 });
    throw err;
  }
}
