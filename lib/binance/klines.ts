// Candlestick data: REST history (/api/v3/klines) + live <symbol>@kline_<interval> stream.

const REST_BASE = "https://api.binance.com";

export const KLINE_INTERVALS = ["1m", "5m", "15m", "1h", "4h", "1d"] as const;
export type KlineInterval = (typeof KLINE_INTERVALS)[number];

export interface Candle {
  /** Open time, seconds since epoch (lightweight-charts' time unit). */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closed: boolean;
}

/** Event payload of <symbol>@kline_<interval>. */
export interface KlineEvent {
  e: "kline";
  E: number;
  s: string;
  k: {
    t: number; // open time
    T: number; // close time
    i: string;
    o: string;
    c: string;
    h: string;
    l: string;
    v: string;
    x: boolean; // is this kline closed?
  };
}

export function klineStreamName(symbol: string, interval: KlineInterval): string {
  return `${symbol.toLowerCase()}@kline_${interval}`;
}

export function candleFromEvent(ev: KlineEvent): Candle {
  const k = ev.k;
  return {
    time: k.t / 1000,
    open: Number(k.o),
    high: Number(k.h),
    low: Number(k.l),
    close: Number(k.c),
    volume: Number(k.v),
    closed: k.x,
  };
}

export async function fetchKlines(symbol: string, interval: KlineInterval, limit = 500): Promise<Candle[]> {
  const res = await fetch(
    `${REST_BASE}/api/v3/klines?symbol=${symbol.toUpperCase()}&interval=${interval}&limit=${limit}`,
    { cache: "no-store" },
  );
  if (!res.ok) throw new Error(`klines HTTP ${res.status}`);
  // [openTime, open, high, low, close, volume, closeTime, ...]
  const rows: [number, string, string, string, string, string, number][] = await res.json();
  const now = Date.now();
  return rows.map((r) => ({
    time: r[0] / 1000,
    open: Number(r[1]),
    high: Number(r[2]),
    low: Number(r[3]),
    close: Number(r[4]),
    volume: Number(r[5]),
    closed: r[6] < now,
  }));
}
