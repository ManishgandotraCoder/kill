import { ForecastError } from "@/lib/predict";
import { createRun, deleteRun, listRuns } from "@/lib/runs";

// Prediction runs (left sidebar). Not authenticated - fine for a local app.
//   GET    /api/runs?symbol=BTCUSDT        -> runs with their hourly predictions
//   POST   /api/runs { symbol, start, end } -> create (times in ms)
//   DELETE /api/runs?id=3                   -> delete a run and its predictions

const SYMBOL = /^[A-Z0-9]{5,20}$/;

export async function GET(req: Request) {
  const symbol = (new URL(req.url).searchParams.get("symbol") ?? "BTCUSDT").toUpperCase();
  if (!SYMBOL.test(symbol)) return new Response("Bad symbol", { status: 400 });
  try {
    return Response.json(await listRuns(symbol));
  } catch (err) {
    if (err instanceof ForecastError) return new Response(err.message, { status: 422 });
    throw err;
  }
}

export async function POST(req: Request) {
  const b = (await req.json().catch(() => ({}))) as { symbol?: string; start?: number; end?: number };
  const symbol = (b.symbol ?? "").toUpperCase();
  if (!SYMBOL.test(symbol)) return new Response("Bad symbol", { status: 400 });
  if (!Number.isFinite(b.start) || !Number.isFinite(b.end)) return new Response("Pick a start and an end time.", { status: 400 });
  try {
    return Response.json(await createRun(symbol, b.start!, b.end!));
  } catch (err) {
    if (err instanceof ForecastError) return new Response(err.message, { status: 422 });
    throw err;
  }
}

export async function DELETE(req: Request) {
  const id = Number(new URL(req.url).searchParams.get("id"));
  if (!Number.isInteger(id)) return new Response("Bad id", { status: 400 });
  await deleteRun(id);
  return new Response(null, { status: 204 });
}
