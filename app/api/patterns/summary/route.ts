import { parseFilter, QueryError, summarize } from "@/lib/pattern-query";

// GET /api/patterns/summary?symbol=BTCUSDT&interval=1m[&pattern=..&from=..&to=..]
// -> counts per pattern (+ first/last time) and the detector's scan checkpoint.
export async function GET(req: Request) {
  try {
    return Response.json(await summarize(parseFilter(new URL(req.url).searchParams)));
  } catch (err) {
    if (err instanceof QueryError) return new Response(err.message, { status: 400 });
    throw err;
  }
}
