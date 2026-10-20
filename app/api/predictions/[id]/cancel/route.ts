import { AuthError, requireUser } from "@/lib/auth";
import { cancelPrediction, PredictionError } from "@/lib/predictions";

// POST /api/predictions/123/cancel -> the cancelled session (it stays in history). Own predictions only.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!/^\d{1,18}$/.test(id)) return new Response("Bad id", { status: 400 });
  try {
    const user = await requireUser(req);
    return Response.json(await cancelPrediction(user.id, Number(id)));
  } catch (err) {
    if (err instanceof AuthError || err instanceof PredictionError) return new Response(err.message, { status: err.status });
    throw err;
  }
}
