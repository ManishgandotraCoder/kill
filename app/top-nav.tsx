"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useStreamStatus } from "@/lib/binance/hooks";

const LINKS = [
  { href: "/", label: "Live" },
  { href: "/history", label: "History" },
  { href: "/patterns", label: "Patterns" },
  { href: "/predictions", label: "Runs" },
];

export default function TopNav() {
  const path = usePathname();
  const status = useStreamStatus();
  const ok = status === "open";

  return (
    <header className="sticky top-0 z-30 border-b border-line bg-background/85 backdrop-blur">
      <div className="mx-auto flex h-14 w-full max-w-[1680px] items-center gap-3 px-4 sm:gap-6">
        <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-foreground text-xs text-background">₿</span>
          bit
        </Link>
        <nav className="flex gap-1 text-sm">
          {LINKS.map((l) => {
            const active = l.href === "/" ? path === "/" : path.startsWith(l.href);
            return (
              <Link
                key={l.href}
                href={l.href}
                aria-current={active ? "page" : undefined}
                className={`rounded-md px-2 py-1.5 sm:px-3 ${active ? "bg-panel-2 text-foreground" : "text-muted hover:text-foreground"}`}
              >
                {l.label}
              </Link>
            );
          })}
        </nav>
        {path === "/" && (
          <span className="ml-auto flex shrink-0 items-center gap-2 rounded-full border border-line px-2 py-1 text-xs text-muted sm:px-3">
            <span className={`h-2 w-2 rounded-full ${ok ? "animate-pulse bg-up" : "bg-amber-500"}`} />
            <span className="hidden sm:inline">{ok ? "Live" : status}</span>
          </span>
        )}
      </div>
    </header>
  );
}
