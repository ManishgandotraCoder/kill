// Local order book kept in sync with Binance per
// "How to manage a local order book correctly":
//  1. Subscribe to <symbol>@depth and buffer events, noting U of the first one.
//  2. Fetch a REST snapshot (limit 5000).
//  3. If snapshot.lastUpdateId < first U, fetch again.
//  4. Drop buffered events with u <= lastUpdateId.
//  5. Load the snapshot, then apply buffered + live events:
//     - u < book id      -> ignore
//     - U > book id + 1  -> gap, discard book and restart
//     - qty 0 removes a level, otherwise set it
//     - book id = u

import { BinanceStream, getBinanceStream } from "./stream";

const REST_BASE = "https://api.binance.com";
const SNAPSHOT_LIMIT = 5000;
const MAX_SNAPSHOT_RETRIES = 5;

export interface DepthUpdate {
  e: "depthUpdate";
  E: number;
  s: string;
  U: number;
  u: number;
  b: [string, string][];
  a: [string, string][];
}

interface DepthSnapshot {
  lastUpdateId: number;
  bids: [string, string][];
  asks: [string, string][];
}

export type Level = [price: number, qty: number];

export interface BookView {
  symbol: string;
  lastUpdateId: number;
  bids: Level[];
  asks: Level[];
}

export type BookState = "syncing" | "live" | "error";

export interface OrderBookOptions {
  /** "100ms" for faster updates; default is the 1000ms stream. */
  speed?: "1000ms" | "100ms";
  stream?: BinanceStream;
}

export class LocalOrderBook {
  readonly symbol: string;
  private readonly streamName: string;
  private readonly stream: BinanceStream;

  private bids = new Map<string, number>();
  private asks = new Map<string, number>();
  private lastUpdateId = -1;

  private buffer: DepthUpdate[] = [];
  private synced = false;
  private syncing = false;
  /** Bumped on every resync so stale snapshot fetches are ignored. */
  private generation = 0;

  private unsubStream: (() => void) | null = null;
  private unsubOpen: (() => void) | null = null;
  private listeners = new Set<() => void>();
  private stateListeners = new Set<(s: BookState) => void>();
  private state: BookState = "syncing";

  constructor(symbol: string, opts: OrderBookOptions = {}) {
    this.symbol = symbol.toUpperCase();
    this.stream = opts.stream ?? getBinanceStream();
    const suffix = opts.speed === "100ms" ? "@100ms" : "";
    this.streamName = `${symbol.toLowerCase()}@depth${suffix}`;
  }

  start(): void {
    if (this.unsubStream) return;
    this.unsubStream = this.stream.on(this.streamName, (d) => this.onEvent(d as DepthUpdate));
    // A reconnect means we may have missed events: rebuild from scratch.
    this.unsubOpen = this.stream.onOpen(() => this.resync());
    this.resync();
  }

  stop(): void {
    this.generation++;
    this.unsubStream?.();
    this.unsubOpen?.();
    this.unsubStream = this.unsubOpen = null;
    this.reset();
  }

  /** Called whenever the book changes. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onState(listener: (s: BookState) => void): () => void {
    this.stateListeners.add(listener);
    listener(this.state);
    return () => this.stateListeners.delete(listener);
  }

  /** Top `depth` levels each side, best first. */
  view(depth = 20): BookView {
    return {
      symbol: this.symbol,
      lastUpdateId: this.lastUpdateId,
      bids: topLevels(this.bids, depth, (a, b) => b - a),
      asks: topLevels(this.asks, depth, (a, b) => a - b),
    };
  }

  // ---- sync procedure --------------------------------------------------

  private reset(): void {
    this.bids.clear();
    this.asks.clear();
    this.lastUpdateId = -1;
    this.buffer = [];
    this.synced = false;
  }

  private resync(): void {
    this.generation++;
    this.reset();
    this.syncing = false;
    this.setState("syncing");
    // Snapshot is fetched once the first event arrives (we need its U).
  }

  private onEvent(ev: DepthUpdate): void {
    if (ev.e !== "depthUpdate") return;

    if (!this.synced) {
      this.buffer.push(ev);
      if (!this.syncing) void this.loadSnapshot(this.generation);
      return;
    }

    this.apply(ev);
  }

  private async loadSnapshot(gen: number): Promise<void> {
    this.syncing = true;
    const firstU = this.buffer[0].U;

    for (let attempt = 0; attempt < MAX_SNAPSHOT_RETRIES; attempt++) {
      let snap: DepthSnapshot;
      try {
        const res = await fetch(
          `${REST_BASE}/api/v3/depth?symbol=${this.symbol}&limit=${SNAPSHOT_LIMIT}`,
          { cache: "no-store" },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        snap = await res.json();
      } catch (err) {
        console.warn(`[orderbook ${this.symbol}] snapshot failed`, err);
        await sleep(1000 * (attempt + 1));
        if (gen !== this.generation) return;
        continue;
      }
      if (gen !== this.generation) return;

      // Step 4: snapshot older than our first buffered event -> fetch again.
      if (snap.lastUpdateId < firstU) {
        await sleep(250);
        if (gen !== this.generation) return;
        continue;
      }

      // Step 5: discard events already contained in the snapshot.
      const pending = this.buffer.filter((e) => e.u > snap.lastUpdateId);
      this.buffer = [];

      // Step 6: load snapshot.
      for (const [p, q] of snap.bids) this.bids.set(p, Number(q));
      for (const [p, q] of snap.asks) this.asks.set(p, Number(q));
      this.lastUpdateId = snap.lastUpdateId;
      this.synced = true;
      this.syncing = false;
      this.setState("live");

      // Step 7: apply buffered events, then live ones flow via onEvent.
      for (const e of pending) {
        if (!this.apply(e)) return;
      }
      this.emit();
      return;
    }

    if (gen !== this.generation) return;
    this.syncing = false;
    this.setState("error");
  }

  /** Returns false if a gap forced a resync. */
  private apply(ev: DepthUpdate): boolean {
    if (ev.u < this.lastUpdateId) return true;

    if (ev.U > this.lastUpdateId + 1) {
      console.warn(`[orderbook ${this.symbol}] gap detected (U=${ev.U}, book=${this.lastUpdateId}), resyncing`);
      this.resync();
      // This event becomes the first buffered event of the new sync.
      this.onEvent(ev);
      return false;
    }

    setLevels(this.bids, ev.b);
    setLevels(this.asks, ev.a);
    this.lastUpdateId = ev.u;
    this.emit();
    return true;
  }

  // ---- helpers ---------------------------------------------------------

  private emit(): void {
    this.listeners.forEach((l) => l());
  }

  private setState(s: BookState): void {
    if (this.state === s) return;
    this.state = s;
    this.stateListeners.forEach((l) => l(s));
  }
}

function setLevels(side: Map<string, number>, levels: [string, string][]): void {
  for (const [price, qtyStr] of levels) {
    const qty = Number(qtyStr);
    if (qty === 0) side.delete(price);
    else side.set(price, qty);
  }
}

function topLevels(side: Map<string, number>, depth: number, cmp: (a: number, b: number) => number): Level[] {
  const levels: Level[] = [];
  for (const [p, q] of side) levels.push([Number(p), q]);
  levels.sort((a, b) => cmp(a[0], b[0]));
  return levels.slice(0, depth);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
