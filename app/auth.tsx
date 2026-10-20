"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { User } from "@/lib/auth";

// Who is logged in, for client components. The session itself is an httpOnly cookie the browser
// can't read; this asks the server (/api/auth/me) and refreshes after login / logout.

interface AuthState {
  user: User | null;
  /** True until the first /api/auth/me answer. */
  loading: boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ user: User | null; loading: boolean }>({ user: null, loading: true });

  const refresh = useCallback(async () => {
    const r = await fetch("/api/auth/me", { cache: "no-store" });
    const { user } = r.ok ? ((await r.json()) as { user: User | null }) : { user: null };
    setState({ user, loading: false });
  }, []);

  useEffect(() => {
    let alive = true;
    fetch("/api/auth/me", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { user: null }))
      .then((b: { user: User | null }) => alive && setState({ user: b.user, loading: false }))
      .catch(() => alive && setState({ user: null, loading: false }));
    return () => {
      alive = false;
    };
  }, []);

  const logout = useCallback(async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    setState({ user: null, loading: false });
  }, []);

  return <AuthContext value={{ ...state, refresh, logout }}>{children}</AuthContext>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
