import { AuthError, register, startSession } from "@/lib/auth";

// POST /api/auth/register { email, name, password } -> creates the account and logs in.
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  try {
    const user = await register(body);
    return Response.json({ user }, { status: 201, headers: { "set-cookie": await startSession(user.id) } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(err.message, { status: err.status });
    throw err;
  }
}
