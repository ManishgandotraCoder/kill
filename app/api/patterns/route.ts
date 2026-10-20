import { listPatterns, parseCursor, parseFilter, parseLimit, QueryError } from "@/lib/pattern-query";

// GET /api/patterns?symbol=BTCUSDT&interval=1m&pattern=hammer,doji&from=2024-01-01&to=<ms>&limit=100&cursor=<ts>_<id>
// -> { items: [...newest first], nextCursor } ; pass nextCursor back for the next page.
export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  try {
    return Response.json(await listPatterns(parseFilter(p), parseLimit(p), parseCursor(p)));
  } catch (err) {
    if (err instanceof QueryError) return new Response(err.message, { status: 400 });
    throw err;
  }
}
