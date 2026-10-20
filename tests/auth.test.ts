// Auth: password hashing, validation, register/login and sessions. Runs against the test database.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

const real = process.env.DATABASE_URL;
const testUrl = process.env.TEST_DATABASE_URL ?? (real ? real.replace(/\/[^/?]+(\?|$)/, "/bit_test$1") : undefined);
if (!testUrl || testUrl === real) throw new Error("Set TEST_DATABASE_URL to a database other than DATABASE_URL");
process.env.DATABASE_URL = testUrl;

type Auth = typeof import("../lib/auth");
let A: Auth;
let db: typeof import("../lib/db");
const EMAIL = "ghost@auth.test";

before(async () => {
  db = await import("../lib/db");
  A = await import("../lib/auth");
  await db.ensureSchema();
  await db.pool.query("DELETE FROM users WHERE email LIKE '%@auth.test'");
});
after(async () => {
  await db.pool.query("DELETE FROM users WHERE email LIKE '%@auth.test'");
  await db.pool.end();
});

describe("passwords", () => {
  it("hash is salted scrypt and verifies only the right password", async () => {
    const a = await A.hashPassword("correct horse");
    const b = await A.hashPassword("correct horse");
    assert.match(a, /^scrypt\$16384\$8\$1\$/);
    assert.notEqual(a, b); // random salt
    assert.equal(await A.verifyPassword("correct horse", a), true);
    assert.equal(await A.verifyPassword("correct horsE", a), false);
    assert.equal(await A.verifyPassword("x", "garbage"), false);
  });
});

describe("validation", () => {
  it("normalises email and rejects bad input", () => {
    assert.deepEqual(A.validateRegistration({ email: "  Me@Ex.COM ", name: " Ann ", password: "12345678" }), { email: "me@ex.com", name: "Ann", password: "12345678" });
    for (const bad of [
      { email: "nope", name: "A", password: "12345678" },
      { email: "a@b.co", name: "", password: "12345678" },
      { email: "a@b.co", name: "A", password: "short" },
      { email: "a@b.co", name: "x".repeat(51), password: "12345678" },
    ]) assert.throws(() => A.validateRegistration(bad), A.AuthError);
  });
});

describe("register + login", () => {
  it("registers once, stores no plain password", async () => {
    const u = await A.register({ email: EMAIL, name: "Ghost", password: "boo-boo-boo" });
    assert.equal(u.email, EMAIL);
    await assert.rejects(A.register({ email: EMAIL.toUpperCase(), name: "Again", password: "boo-boo-boo" }), (e) => e instanceof A.AuthError && e.status === 409);
    const { rows } = await db.pool.query("SELECT password_hash FROM users WHERE email=$1", [EMAIL]);
    assert.ok(rows[0].password_hash.startsWith("scrypt$") && !rows[0].password_hash.includes("boo"));
  });
  it("logs in with the right password, same error for wrong password or unknown email", async () => {
    const u = await A.login({ email: " GHOST@auth.test", password: "boo-boo-boo" }, "1.1.1.1");
    assert.equal(u.name, "Ghost");
    const wrong = await A.login({ email: EMAIL, password: "nope-nope" }, "1.1.1.1").catch((e) => e);
    const unknown = await A.login({ email: "nobody@auth.test", password: "nope-nope" }, "1.1.1.1").catch((e) => e);
    assert.ok(wrong instanceof A.AuthError && unknown instanceof A.AuthError);
    assert.equal(wrong.message, unknown.message);
    assert.equal(wrong.status, 401);
  });
  it("rate-limits repeated failures per IP + email", async () => {
    for (let i = 0; i < 10; i++) await A.login({ email: "rl@auth.test", password: "x" }, "9.9.9.9").catch(() => {});
    await assert.rejects(A.login({ email: "rl@auth.test", password: "x" }, "9.9.9.9"), (e) => e instanceof A.AuthError && e.status === 429);
    // a different IP is unaffected
    await assert.rejects(A.login({ email: "rl@auth.test", password: "x" }, "8.8.8.8"), (e) => e instanceof A.AuthError && e.status === 401);
  });
});

describe("routes + sessions", () => {
  const post = (path: string, body: unknown, cookie?: string) =>
    new Request(`http://t${path}`, { method: "POST", body: JSON.stringify(body), headers: cookie ? { cookie } : {} });
  const cookieOf = (res: Response) => res.headers.get("set-cookie")!.split(";")[0];

  it("login sets an httpOnly session cookie; /me knows the user; logout clears it", async () => {
    const login = await import("../app/api/auth/login/route");
    const me = await import("../app/api/auth/me/route");
    const logout = await import("../app/api/auth/logout/route");
    const res = await login.POST(post("/api/auth/login", { email: EMAIL, password: "boo-boo-boo" }));
    assert.equal(res.status, 200);
    const header = res.headers.get("set-cookie")!;
    assert.match(header, /^dm_session=[\w-]{40,}; Path=\/; HttpOnly; SameSite=Lax; Expires=/);
    const cookie = cookieOf(res);
    // only the hash of the token is stored
    const token = cookie.split("=")[1];
    assert.equal((await db.pool.query("SELECT 1 FROM auth_sessions WHERE token_hash = $1", [token])).rowCount, 0);
    const who = await (await me.GET(new Request("http://t/api/auth/me", { headers: { cookie } }))).json();
    assert.equal(who.user.email, EMAIL);
    assert.equal((await (await me.GET(new Request("http://t/api/auth/me"))).json()).user, null);
    const out = await logout.POST(post("/api/auth/logout", {}, cookie));
    assert.match(out.headers.get("set-cookie")!, /^dm_session=; .*Expires=Thu, 01 Jan 1970/);
    assert.equal((await (await me.GET(new Request("http://t/api/auth/me", { headers: { cookie } }))).json()).user, null);
  });
  it("register logs in; bad input is rejected", async () => {
    const reg = await import("../app/api/auth/register/route");
    assert.equal((await reg.POST(post("/api/auth/register", { email: "bad", name: "A", password: "12345678" }))).status, 400);
    const res = await reg.POST(post("/api/auth/register", { email: "new@auth.test", name: "New", password: "12345678" }));
    assert.equal(res.status, 201);
    assert.ok(res.headers.get("set-cookie")!.startsWith("dm_session="));
    const login = await import("../app/api/auth/login/route");
    assert.equal((await login.POST(new Request("http://t/api/auth/login", { method: "POST", body: "not json" }))).status, 401);
  });
  it("an expired session is ignored", async () => {
    const login = await import("../app/api/auth/login/route");
    const me = await import("../app/api/auth/me/route");
    const cookie = cookieOf(await login.POST(post("/api/auth/login", { email: EMAIL, password: "boo-boo-boo" })));
    await db.pool.query("UPDATE auth_sessions SET expires_at = now() - interval '1 second'");
    assert.equal((await (await me.GET(new Request("http://t/api/auth/me", { headers: { cookie } }))).json()).user, null);
  });
});
