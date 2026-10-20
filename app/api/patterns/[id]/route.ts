import { getPattern } from "@/lib/pattern-query";

// GET /api/patterns/123 -> the detection plus the candles around it (for the detail chart).
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!/^\d{1,18}$/.test(id)) return new Response("Bad id", { status: 400 });
  const found = await getPattern(Number(id));
  return found ? Response.json(found) : new Response("Not found", { status: 404 });
}
