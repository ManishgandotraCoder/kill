import { currentUser } from "@/lib/auth";

// GET /api/auth/me -> { user } (null when logged out).
export async function GET(req: Request) {
  return Response.json({ user: await currentUser(req) });
}
