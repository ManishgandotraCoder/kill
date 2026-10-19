import { syncAll, INTERVALS } from "@/lib/syncCandles";

// Cron entry point: GET /api/sync?interval=1h[&symbol=BTCUSDT]
// with header Authorization: Bearer $CRON_SECRET

export const maxDuration = 300;

export async function GET(req: Request) {
  if (req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  const p = new URL(req.url).searchParams;
  const interval = p.get("interval") ?? "15m";
  if (!INTERVALS[interval]) return new Response("Bad interval", { status: 400 });

  return Response.json(await syncAll(interval, p.get("symbol") ?? undefined));
}
