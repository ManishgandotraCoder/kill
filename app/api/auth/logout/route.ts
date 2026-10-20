import { endSession } from "@/lib/auth";

// POST /api/auth/logout -> deletes the session and clears its cookie.
export async function POST(req: Request) {
  return Response.json({ ok: true }, { headers: { "set-cookie": await endSession(req) } });
}
