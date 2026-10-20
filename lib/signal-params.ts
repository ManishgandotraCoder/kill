// Query-string parsing shared by the /api/signal routes.
import { MODEL_INTERVALS } from "./ml-features";

export function parseSignalParams(url: string): { symbol: string; interval: string; horizon: number } | string {
  const p = new URL(url).searchParams;
  const symbol = (p.get("symbol") ?? "BTCUSDT").toUpperCase();
  if (!/^[A-Z0-9]{5,20}$/.test(symbol)) return "Bad symbol";
  const interval = p.get("interval") ?? "1m";
  if (!MODEL_INTERVALS.includes(interval)) return `Bad interval: one of ${MODEL_INTERVALS.join(", ")}`;
  const horizon = Number(p.get("horizon") ?? (interval === "1m" ? 15 : 1));
  if (!Number.isInteger(horizon) || horizon < 1 || horizon > 1000) return "Bad horizon";
  return { symbol, interval, horizon };
}
