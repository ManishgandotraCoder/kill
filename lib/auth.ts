// Email + password accounts with cookie sessions. Server-only (Route Handlers): the session is read
// from the request's Cookie header and set / cleared with a Set-Cookie response header.
//
// - Passwords: scrypt (Node crypto) with a random 16-byte salt, compared in constant time.
// - Sessions: a random 32-byte token in an httpOnly, SameSite=Lax cookie; the DB keeps only its
//   SHA-256, so a leaked table can't be replayed. Sessions last 30 days.
// - Failed logins are rate-limited per IP + email (in memory).

import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { ensureSchema, pool } from "./db";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: { N: number; r: number; p: number }) => Promise<Buffer>;

export const SESSION_COOKIE = "dm_session";
const SESSION_DAYS = 30;
const SCRYPT = { N: 16384, r: 8, p: 1 };
const KEY_LEN = 64;

export class AuthError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export interface User {
  id: number;
  email: string;
  name: string;
}

// ---- passwords ----

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEY_LEN, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, n, r, p, salt, key] = stored.split("$");
  if (algo !== "scrypt" || !key) return false;
  const expected = Buffer.from(key, "base64");
  const got = await scrypt(password, Buffer.from(salt, "base64"), expected.length, { N: Number(n), r: Number(r), p: Number(p) });
  return got.length === expected.length && timingSafeEqual(got, expected);
}

// ---- validation ----

export function validateRegistration(input: { email?: unknown; name?: unknown; password?: unknown }) {
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const password = typeof input.password === "string" ? input.password : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new AuthError("Enter a valid email address");
  if (name.length < 1 || name.length > 50) throw new AuthError("Name must be 1-50 characters");
  if (password.length < 8) throw new AuthError("Password must be at least 8 characters");
  if (password.length > 200) throw new AuthError("Password is too long");
  return { email, name, password };
}

// ---- rate limit (failed logins) ----

const g = globalThis as unknown as { loginFails?: Map<string, number[]> };
const fails: Map<string, number[]> = (g.loginFails ??= new Map());
const WINDOW_MS = 15 * 60_000, MAX_FAILS = 10;

function checkRate(key: string) {
  const recent = (fails.get(key) ?? []).filter((t) => Date.now() - t < WINDOW_MS);
  fails.set(key, recent);
  if (recent.length >= MAX_FAILS) throw new AuthError("Too many failed attempts - try again in 15 minutes", 429);
}
const noteFail = (key: string) => fails.set(key, [...(fails.get(key) ?? []), Date.now()]);

// ---- accounts + sessions ----

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export async function register(input: { email?: unknown; name?: unknown; password?: unknown }): Promise<User> {
  const { email, name, password } = validateRegistration(input);
  await ensureSchema();
  const hash = await hashPassword(password);
  const { rows } = await pool.query<User>(
    "INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) ON CONFLICT (email) DO NOTHING RETURNING id::float8 AS id, email, name",
    [email, name, hash],
  );
  if (!rows[0]) throw new AuthError("An account with this email already exists", 409);
  return rows[0];
}

export async function login(input: { email?: unknown; password?: unknown }, ip: string): Promise<User> {
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  const password = typeof input.password === "string" ? input.password : "";
  const key = `${ip}|${email}`;
  checkRate(key);
  await ensureSchema();
  const { rows } = await pool.query("SELECT id::float8 AS id, email, name, password_hash FROM users WHERE email = $1", [email]);
  // Same message (and still a hash check) whether or not the email exists.
  const ok = rows[0] ? await verifyPassword(password, rows[0].password_hash) : (await hashPassword(password), false);
  if (!ok) {
    noteFail(key);
    throw new AuthError("Wrong email or password", 401);
  }
  fails.delete(key);
  return { id: rows[0].id, email: rows[0].email, name: rows[0].name };
}

/** Set-Cookie header value for the session cookie (empty token + past date clears it). */
function sessionCookie(token: string, expires: Date): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Expires=${expires.toUTCString()}${secure}`;
}

/** Session token from the request's Cookie header. */
function tokenOf(req: Request): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === SESSION_COOKIE) return v.join("=") || null;
  }
  return null;
}

/** Creates a session row; returns the Set-Cookie header value for the response. */
export async function startSession(userId: number): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  await pool.query("INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)", [sha256(token), userId, expires]);
  return sessionCookie(token, expires);
}

/** The logged-in user from the request's session cookie, or null. */
export async function currentUser(req: Request): Promise<User | null> {
  const token = tokenOf(req);
  if (!token) return null;
  await ensureSchema();
  const { rows } = await pool.query<User>(
    `SELECT u.id::float8 AS id, u.email, u.name FROM auth_sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [sha256(token)],
  );
  return rows[0] ?? null;
}

export async function requireUser(req: Request): Promise<User> {
  const user = await currentUser(req);
  if (!user) throw new AuthError("Log in first", 401);
  return user;
}

/** Deletes the request's session; returns the Set-Cookie header value that clears the cookie. */
export async function endSession(req: Request): Promise<string> {
  const token = tokenOf(req);
  if (token) await pool.query("DELETE FROM auth_sessions WHERE token_hash = $1", [sha256(token)]);
  return sessionCookie("", new Date(0));
}

/** Client IP for rate limiting (behind a proxy, the first X-Forwarded-For hop). */
export const clientIp = (req: Request) => req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "local";
