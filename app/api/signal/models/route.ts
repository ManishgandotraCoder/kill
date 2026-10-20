import { listModels } from "@/lib/signal";

// GET /api/signal/models?symbol=BTCUSDT -> trained horizons available for the signal card.
export async function GET(req: Request) {
  const symbol = (new URL(req.url).searchParams.get("symbol") ?? "BTCUSDT").toUpperCase();
  if (!/^[A-Z0-9]{5,20}$/.test(symbol)) return new Response("Bad symbol", { status: 400 });
  return Response.json({ models: await listModels(symbol) });
}
