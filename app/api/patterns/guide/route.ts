import { patternGuide } from "@/lib/pattern-guide";

// GET /api/patterns/guide?symbol=BTCUSDT -> every pattern's detection counts, latest example ids,
// and what price did afterwards vs. after any candle (for the Pattern guide page).
export async function GET(req: Request) {
  const symbol = (new URL(req.url).searchParams.get("symbol") ?? "BTCUSDT").toUpperCase();
  if (!/^[A-Z0-9]{5,20}$/.test(symbol)) return new Response("Bad symbol", { status: 400 });
  return Response.json(await patternGuide(symbol));
}
