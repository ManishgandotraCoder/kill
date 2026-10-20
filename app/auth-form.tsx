"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useAuth } from "./auth";

// Shared login / register form.

export default function AuthForm({ mode }: { mode: "login" | "register" }) {
  const router = useRouter();
  const { refresh } = useAuth();
  const [form, setForm] = useState({ name: "", email: "", password: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isRegister = mode === "register";

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    fetch(`/api/auth/${mode}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(form) })
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.text()) || `HTTP ${r.status}`);
        await refresh();
        router.push("/");
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setBusy(false));
  };

  const field = (key: keyof typeof form, label: string, type: string, autoComplete: string) => (
    <label className="block">
      <span className="mb-1 block text-xs text-muted">{label}</span>
      <input
        type={type}
        required
        autoComplete={autoComplete}
        minLength={key === "password" && isRegister ? 8 : undefined}
        value={form[key]}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
        className="w-full rounded-lg border border-line bg-panel-2 px-3 py-2 text-sm outline-none transition-colors placeholder:text-muted focus:border-accent"
      />
    </label>
  );

  return (
    <div className="flex flex-1 items-center justify-center px-4 py-16">
      <form onSubmit={submit} className="card ghost-glow w-full max-w-sm space-y-4 p-6">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{isRegister ? "Create your account" : "Welcome back"}</h1>
          <p className="mt-1 text-xs text-muted">
            {isRegister ? "Save your predictions and see your own track record." : "Log in to start predicting and see your history."}
          </p>
        </div>
        {isRegister && field("name", "Name", "text", "name")}
        {field("email", "Email", "email", "email")}
        {field("password", isRegister ? "Password (8+ characters)" : "Password", "password", isRegister ? "new-password" : "current-password")}
        {error && <p className="text-xs text-down" role="alert">{error}</p>}
        <button type="submit" disabled={busy} className="w-full rounded-lg bg-accent/15 text-accent ring-1 ring-accent/40 hover:bg-accent/25 py-2 text-sm font-semibold transition-colors disabled:opacity-50">
          {busy ? "Please wait…" : isRegister ? "Create account" : "Log in"}
        </button>
        <p className="text-center text-xs text-muted">
          {isRegister ? "Already have an account? " : "New here? "}
          <Link href={isRegister ? "/login" : "/register"} className="text-accent hover:underline">
            {isRegister ? "Log in" : "Create an account"}
          </Link>
        </p>
      </form>
    </div>
  );
}
