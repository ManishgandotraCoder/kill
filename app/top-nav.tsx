"use client";

import Link from "next/link";
import { useStreamStatus } from "@/lib/binance/hooks";

export default function TopNav() {
  const status = useStreamStatus();
  const ok = status === "open";

  return (
    <header className="sticky top-0 z-30 border-b border-line bg-background/85 backdrop-blur">
      <div className="mx-auto flex h-14 w-full max-w-[1680px] items-center gap-3 px-4 sm:gap-6">
        <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-foreground text-xs text-background">₿</span>
          bit
        </Link>
        <span className="ml-auto flex shrink-0 items-center gap-2 rounded-full border border-line px-2 py-1 text-xs text-muted sm:px-3">
          <span className={`h-2 w-2 rounded-full ${ok ? "animate-pulse bg-up" : "bg-amber-500"}`} />
          <span className="hidden sm:inline">{ok ? "Live" : status}</span>
        </span>
      </div>
    </header>
  );
}
