import { ensureSchema, pool } from "@/lib/db";
import { INTERVALS, startSync, type SyncProgress } from "@/lib/syncCandles";

// Used by the /history page: starts (or attaches to) a sync and streams
// progress as newline-delimited JSON. The sync keeps running if the tab closes.
//
// Not protected by CRON_SECRET - fine for a local app; put auth in front of
// it before deploying anywhere public.

export const maxDuration = 300;

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { symbol?: string; interval?: string };
  const symbol = (body.symbol ?? "").trim().toUpperCase();
  const interval = body.interval ?? "1h";

  if (!/^[A-Z0-9]{5,20}$/.test(symbol)) return new Response("Bad symbol", { status: 400 });
  if (!INTERVALS[interval]) return new Response("Bad interval", { status: 400 });

  await ensureSchema();
  let { rows } = await pool.query("SELECT years_back FROM symbols WHERE symbol=$1", [symbol]);
  if (!rows.length) {
    // New coin: make sure Binance knows it before adding it to the symbols table.
    const check = await fetch(`https://data-api.binance.vision/api/v3/exchangeInfo?symbol=${symbol}`, {
      cache: "no-store",
    });
    if (!check.ok) return new Response(`Unknown symbol on Binance: ${symbol}`, { status: 400 });
    ({ rows } = await pool.query(
      "INSERT INTO symbols (symbol) VALUES ($1) ON CONFLICT (symbol) DO UPDATE SET symbol = EXCLUDED.symbol RETURNING years_back",
      [symbol],
    ));
  }

  const job = startSync(symbol, interval, rows[0].years_back);
  const encoder = new TextEncoder();
  let listener: ((s: SyncProgress) => void) | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (s: SyncProgress) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(s) + "\n"));
          if (s.status !== "running") {
            job.listeners.delete(send);
            controller.close();
          }
        } catch {
          job.listeners.delete(send); // client went away
        }
      };
      listener = send;
      job.listeners.add(send);
      send(job.state);
    },
    cancel() {
      if (listener) job.listeners.delete(listener);
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" },
  });
}
