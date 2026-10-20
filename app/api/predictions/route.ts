import { AuthError, requireUser } from "@/lib/auth";
import { listPredictions, PredictionError, startPrediction } from "@/lib/predictions";

// Predictions belong to the logged-in user (401 when logged out).

const symbolOf = (v: string | null) => {
  const s = (v ?? "BTCUSDT").toUpperCase();
  return /^[A-Z0-9]{5,20}$/.test(s) ? s : null;
};

function fail(err: unknown) {
  if (err instanceof AuthError || err instanceof PredictionError) return new Response(err.message, { status: err.status });
  throw err;
}

// GET /api/predictions?symbol=BTCUSDT -> { running, history (newest first, max 100), stats } of the user.
// Scores any finished sessions first.
export async function GET(req: Request) {
  const symbol = symbolOf(new URL(req.url).searchParams.get("symbol"));
  if (!symbol) return new Response("Bad symbol", { status: 400 });
  try {
    const user = await requireUser(req);
    return Response.json(await listPredictions(user.id, symbol));
  } catch (err) {
    return fail(err);
  }
}

// POST /api/predictions  { symbol: "BTCUSDT", minutes: 10 | 15 | 30 | 60 } -> the started session.
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { symbol?: string; minutes?: number } | null;
  const symbol = symbolOf(body?.symbol ?? null);
  if (!symbol) return new Response("Bad symbol", { status: 400 });
  try {
    const user = await requireUser(req);
    return Response.json(await startPrediction(user.id, symbol, Number(body?.minutes)), { status: 201 });
  } catch (err) {
    return fail(err);
  }
}
