"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useStreamStatus } from "@/lib/binance/hooks";
import { useAuth } from "./auth";

/** The darkMode ghost mark. */
export function GhostLogo({ className = "h-7 w-7" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden>
      <rect width="32" height="32" rx="9" className="fill-accent/15" />
      <path
        d="M16 6.5c-4.7 0-8 3.4-8 8v10.2c0 .7.8 1.1 1.4.7l1.9-1.4 2 1.5c.4.3.9.3 1.3 0l1.4-1.1 1.4 1.1c.4.3.9.3 1.3 0l2-1.5 1.9 1.4c.6.4 1.4 0 1.4-.7V14.5c0-4.6-3.3-8-8-8Z"
        className="fill-foreground"
      />
      <circle cx="13" cy="14.5" r="1.6" className="fill-background" />
      <circle cx="19" cy="14.5" r="1.6" className="fill-background" />
    </svg>
  );
}

export default function TopNav() {
  const status = useStreamStatus();
  const ok = status === "open";
  const path = usePathname();
  const router = useRouter();
  const { user, loading, logout } = useAuth();
  const links = [
    { href: "/", label: "Live" },
    { href: "/patterns", label: "Pattern guide" },
  ];

  return (
    <header className="sticky top-0 z-30 border-b border-line bg-background/70 backdrop-blur-md">
      <div className="mx-auto flex h-14 w-full max-w-[1680px] items-center gap-3 px-4 sm:gap-6">
        <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
          <GhostLogo />
          <span>
            dark<span className="text-accent">Mode</span>
          </span>
        </Link>
        <nav className="flex items-center gap-1 text-sm">
          {links.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              aria-current={path === l.href ? "page" : undefined}
              className={`rounded-md px-2.5 py-1 transition-colors ${path === l.href ? "bg-panel-2 font-medium text-foreground" : "text-muted hover:text-foreground"}`}
            >
              {l.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          {/* Stream status only matters on the live page (the guide doesn't stream). */}
          <span className={`shrink-0 items-center gap-2 rounded-full border border-line px-2 py-1 text-xs text-muted sm:px-3 ${path === "/" ? "flex" : "hidden"}`}>
            <span className={`h-2 w-2 rounded-full ${ok ? "animate-pulse bg-up" : "bg-amber-500"}`} />
            <span className="hidden sm:inline">{ok ? "Live" : status}</span>
          </span>
          {loading ? null : user ? (
            <>
              <span className="hidden items-center gap-2 text-xs text-muted sm:flex" title={user.email}>
                <span className="grid h-6 w-6 place-items-center rounded-full bg-accent/20 text-[11px] font-semibold text-accent">
                  {user.name.slice(0, 1).toUpperCase()}
                </span>
                {user.name}
              </span>
              <button
                onClick={() => logout().then(() => router.refresh())}
                className="rounded-md px-2.5 py-1 text-xs text-muted transition-colors hover:bg-panel-2 hover:text-foreground"
              >
                Log out
              </button>
            </>
          ) : (
            <>
              <Link href="/login" className="rounded-md px-2.5 py-1 text-xs text-muted transition-colors hover:text-foreground">
                Log in
              </Link>
              <Link href="/register" className="rounded-md bg-accent/15 text-accent ring-1 ring-accent/40 hover:bg-accent/25 px-2.5 py-1 text-xs font-semibold transition-colors">
                Register
              </Link>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
