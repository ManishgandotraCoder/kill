// Binance Spot WebSocket market streams client (combined-stream mode).
//
// Handles the rules from the Binance docs:
// - Combined endpoint `/stream?streams=a/b/c`, payloads wrapped as {stream, data}.
// - Stream names are lowercase.
// - Live SUBSCRIBE / UNSUBSCRIBE / LIST_SUBSCRIPTIONS with request ids.
// - Max 5 incoming messages/sec per connection -> outgoing control messages are throttled.
// - Max 1024 streams per connection.
// - Connections are dropped at 24h and on `serverShutdown` -> reconnect and resubscribe.
// - Ping/pong: the server pings every 20s; browsers answer ping frames with pong
//   automatically (the WebSocket API does not expose them), so nothing to do here.

export const BINANCE_WS_BASE = "wss://stream.binance.com:9443";
/** Market-data-only endpoint; use if stream.binance.com is unreachable. */
export const BINANCE_WS_MARKET_DATA_BASE = "wss://data-stream.binance.vision";

const MAX_STREAMS = 1024;
// Binance allows 5 msgs/sec; stay under it.
const SEND_INTERVAL_MS = 250;
// Reconnect a bit before Binance's 24h hard cutoff.
const MAX_CONNECTION_AGE_MS = 23 * 60 * 60 * 1000 + 50 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;

export type StreamStatus = "idle" | "connecting" | "open" | "reconnecting" | "closed";

type StreamHandler = (data: unknown) => void;
type StatusHandler = (status: StreamStatus) => void;

type ControlMethod = "SUBSCRIBE" | "UNSUBSCRIBE" | "LIST_SUBSCRIPTIONS" | "SET_PROPERTY" | "GET_PROPERTY";

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface BinanceStreamOptions {
  baseUrl?: string;
  /** Pass "MICROSECOND" to receive timestamps in microseconds. */
  timeUnit?: "MILLISECOND" | "MICROSECOND";
}

export class BinanceStream {
  private ws: WebSocket | null = null;
  private readonly baseUrl: string;
  private readonly timeUnit?: string;

  private handlers = new Map<string, Set<StreamHandler>>();
  private statusHandlers = new Set<StatusHandler>();
  /** Fires after every (re)connect so consumers like order books can resync. */
  private openHandlers = new Set<() => void>();
  private status: StreamStatus = "idle";

  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private sendQueue: string[] = [];
  private sendTimer: ReturnType<typeof setInterval> | null = null;

  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private ageTimer: ReturnType<typeof setTimeout> | null = null;
  private manuallyClosed = false;
  /** Streams baked into the URL of the current socket. */
  private urlStreams = new Set<string>();

  constructor(opts: BinanceStreamOptions = {}) {
    this.baseUrl = opts.baseUrl ?? BINANCE_WS_BASE;
    this.timeUnit = opts.timeUnit;
  }

  // ---- public API -------------------------------------------------------

  /** Listen to a stream, e.g. "btcusdt@trade". Subscribes on first listener. Returns an unsubscribe fn. */
  on(streamName: string, handler: StreamHandler): () => void {
    const name = streamName.toLowerCase();
    let set = this.handlers.get(name);
    if (!set) {
      if (this.handlers.size >= MAX_STREAMS) {
        throw new Error(`Binance allows at most ${MAX_STREAMS} streams per connection`);
      }
      set = new Set();
      this.handlers.set(name, set);
      this.ensureConnected();
      if (this.ws?.readyState === WebSocket.OPEN) {
        void this.request("SUBSCRIBE", [name]).catch(() => {});
      }
    }
    set.add(handler);

    return () => {
      const current = this.handlers.get(name);
      if (!current) return;
      current.delete(handler);
      if (current.size === 0) {
        this.handlers.delete(name);
        if (this.ws?.readyState === WebSocket.OPEN) {
          void this.request("UNSUBSCRIBE", [name]).catch(() => {});
        }
      }
    };
  }

  onStatus(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler);
    handler(this.status);
    return () => this.statusHandlers.delete(handler);
  }

  onOpen(handler: () => void): () => void {
    this.openHandlers.add(handler);
    return () => this.openHandlers.delete(handler);
  }

  listSubscriptions(): Promise<string[]> {
    return this.request("LIST_SUBSCRIPTIONS") as Promise<string[]>;
  }

  getStatus(): StreamStatus {
    return this.status;
  }

  close(): void {
    this.manuallyClosed = true;
    this.clearTimers();
    this.ws?.close();
    this.ws = null;
    this.rejectAllPending(new Error("Connection closed"));
    this.setStatus("closed");
  }

  // ---- connection lifecycle --------------------------------------------

  private ensureConnected(): void {
    if (this.ws || this.reconnectTimer) return;
    this.manuallyClosed = false;
    this.connect();
  }

  private buildUrl(): string {
    // Initial streams go in the URL so a reconnect resubscribes in one shot
    // without spending control messages against the 5 msg/s limit.
    const params = new URLSearchParams();
    const streams = [...this.handlers.keys()];
    this.urlStreams = new Set(streams);
    let url = `${this.baseUrl}/stream`;
    if (this.timeUnit) params.set("timeUnit", this.timeUnit);
    const query = params.toString();
    if (streams.length) url += `?streams=${streams.join("/")}${query ? `&${query}` : ""}`;
    else if (query) url += `?${query}`;
    return url;
  }

  private connect(): void {
    this.setStatus(this.reconnectAttempts > 0 ? "reconnecting" : "connecting");
    const ws = new WebSocket(this.buildUrl());
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.reconnectAttempts = 0;
      this.setStatus("open");
      this.startSendLoop();
      this.reconcileSubscriptions();
      this.ageTimer = setTimeout(() => this.reconnect(), MAX_CONNECTION_AGE_MS);
      this.openHandlers.forEach((h) => h());
    };

    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      this.handleMessage(ev.data as string);
    };

    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clearTimers();
      this.rejectAllPending(new Error("Connection closed"));
      if (!this.manuallyClosed) this.scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose follows and handles reconnection.
    };
  }

  /** Drop the current socket and open a fresh one immediately. */
  private reconnect(): void {
    const old = this.ws;
    this.ws = null;
    this.clearTimers();
    this.rejectAllPending(new Error("Reconnecting"));
    old?.close();
    this.connect();
  }

  /** Streams added/removed while the socket was connecting weren't reflected in the URL. */
  private reconcileSubscriptions(): void {
    const wanted = [...this.handlers.keys()];
    const add = wanted.filter((s) => !this.urlStreams.has(s));
    const remove = [...this.urlStreams].filter((s) => !this.handlers.has(s));
    if (add.length) void this.request("SUBSCRIBE", add).catch(() => {});
    if (remove.length) void this.request("UNSUBSCRIBE", remove).catch(() => {});
  }

  private scheduleReconnect(): void {
    if (this.handlers.size === 0) {
      this.setStatus("idle");
      return;
    }
    // Exponential backoff with jitter, capped at 30s. Keeps us well under
    // Binance's 300 connection attempts / 5 min / IP limit.
    const delay = Math.min(30_000, 1000 * 2 ** this.reconnectAttempts) * (0.5 + Math.random() / 2);
    this.reconnectAttempts++;
    this.setStatus("reconnecting");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  // ---- messages --------------------------------------------------------

  private handleMessage(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    // Response to a control request: {result, id} or {code, msg, id}
    if ("id" in msg && ("result" in msg || "code" in msg)) {
      const req = this.pending.get(msg.id as number);
      if (!req) return;
      this.pending.delete(msg.id as number);
      clearTimeout(req.timer);
      if ("code" in msg) req.reject(new Error(`Binance error ${msg.code}: ${msg.msg}`));
      else req.resolve(msg.result);
      return;
    }

    // Combined-stream event: {stream, data}
    const stream = msg.stream as string | undefined;
    const data = (msg.data ?? msg) as Record<string, unknown>;

    if (data.e === "serverShutdown") {
      this.reconnect();
      return;
    }

    if (stream) this.handlers.get(stream)?.forEach((h) => h(data));
  }

  private request(method: ControlMethod, params?: unknown[]): Promise<unknown> {
    const id = this.nextId++;
    const payload = JSON.stringify(params ? { method, params, id } : { method, id });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.sendQueue.push(payload);
    });
  }

  private startSendLoop(): void {
    if (this.sendTimer) return;
    this.sendTimer = setInterval(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) return;
      const next = this.sendQueue.shift();
      if (next) this.ws.send(next);
    }, SEND_INTERVAL_MS);
  }

  // ---- helpers ---------------------------------------------------------

  private setStatus(status: StreamStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.statusHandlers.forEach((h) => h(status));
  }

  private clearTimers(): void {
    if (this.sendTimer) clearInterval(this.sendTimer);
    if (this.ageTimer) clearTimeout(this.ageTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.sendTimer = this.ageTimer = this.reconnectTimer = null;
    // Queued SUBSCRIBE/UNSUBSCRIBE are obsolete: the new URL carries current streams.
    this.sendQueue = [];
  }

  private rejectAllPending(err: Error): void {
    this.pending.forEach((req) => {
      clearTimeout(req.timer);
      req.reject(err);
    });
    this.pending.clear();
  }
}

let shared: BinanceStream | null = null;

/** One shared connection for the whole app (browser only). */
export function getBinanceStream(): BinanceStream {
  shared ??= new BinanceStream();
  return shared;
}
