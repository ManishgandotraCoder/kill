import { AuthError, clientIp, login, startSession } from "@/lib/auth";

// POST /api/auth/login { email, password } -> sets the session cookie.
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  try {
    const user = await login(body, clientIp(req));
    return Response.json({ user }, { headers: { "set-cookie": await startSession(user.id) } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(err.message, { status: err.status });
    throw err;
  }
}
