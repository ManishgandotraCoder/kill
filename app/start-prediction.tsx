"use client";

import { useEffect, useRef, useState } from "react";

// "Start Predicting" button with a small picker for the window length.

const OPTIONS = [
  { minutes: 10, label: "10 min" },
  { minutes: 15, label: "15 min" },
  { minutes: 30, label: "30 min" },
  { minutes: 60, label: "1 hour" },
];

export default function StartPrediction({ symbol, onStart }: { symbol: string; onStart: (minutes: number) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [minutes, setMinutes] = useState(15);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  const start = () => {
    setBusy(true);
    setError(null);
    onStart(minutes)
      .then(() => setOpen(false))
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => {
          setOpen(!open);
          setError(null);
        }}
        aria-expanded={open}
        className="rounded-lg bg-accent/15 text-accent ring-1 ring-accent/40 hover:bg-accent/25 px-3 py-1.5 text-xs font-semibold"
      >
        ▶ Start Predicting
      </button>
      {open && (
        <div className="absolute right-0 z-40 mt-2 w-72 rounded-xl border border-line bg-panel p-4 shadow-lg" role="dialog" aria-label="Start a prediction">
          <div className="text-sm font-semibold">Predict {symbol.replace("USDT", "/USDT")}</div>
          <p className="mt-1 text-xs text-muted">The AI makes its call now; it is checked against the real price when the time is up.</p>
          <div className="eyebrow mt-3 mb-1.5">Until</div>
          <div className="grid grid-cols-4 gap-1" role="radiogroup" aria-label="Prediction window">
            {OPTIONS.map((o) => (
              <button
                key={o.minutes}
                role="radio"
                aria-checked={minutes === o.minutes}
                onClick={() => setMinutes(o.minutes)}
                className={`rounded-md px-1 py-1.5 text-xs font-medium transition-colors ${minutes === o.minutes ? "bg-accent/15 text-accent ring-1 ring-accent/30" : "bg-panel-2 text-muted hover:text-foreground"}`}
              >
                {o.label}
              </button>
            ))}
          </div>
          {error && <p className="mt-3 text-xs text-down">{error}</p>}
          <button
            onClick={start}
            disabled={busy}
            className="mt-4 w-full rounded-lg bg-accent/15 text-accent ring-1 ring-accent/40 hover:bg-accent/25 py-2 text-xs font-semibold disabled:opacity-50"
          >
            {busy ? "Starting…" : `Start ${OPTIONS.find((o) => o.minutes === minutes)?.label} prediction`}
          </button>
        </div>
      )}
    </div>
  );
}
