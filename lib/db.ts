import { Pool } from "pg";

// Adding a coin is one SQL insert: INSERT INTO symbols (symbol) VALUES ('ETHUSDT');
const SCHEMA = `
CREATE TABLE IF NOT EXISTS symbols (
  symbol     TEXT PRIMARY KEY,         -- e.g. BTCUSDT
  active     BOOLEAN NOT NULL DEFAULT true,
  years_back INT NOT NULL DEFAULT 5
);

CREATE TABLE IF NOT EXISTS candles (
  symbol   TEXT    NOT NULL REFERENCES symbols(symbol),
  interval TEXT    NOT NULL,           -- '15m', '1h', ...
  ts       BIGINT  NOT NULL,           -- open time, ms UTC
  open     NUMERIC NOT NULL,
  high     NUMERIC NOT NULL,
  low      NUMERIC NOT NULL,
  close    NUMERIC NOT NULL,
  volume   NUMERIC NOT NULL,
  PRIMARY KEY (symbol, interval, ts)
);

-- Human-readable candle open time, filled automatically from ts.
ALTER TABLE candles ADD COLUMN IF NOT EXISTS time TIMESTAMPTZ
  GENERATED ALWAYS AS (to_timestamp(ts / 1000.0)) STORED;

INSERT INTO symbols (symbol) VALUES ('BTCUSDT') ON CONFLICT DO NOTHING;
`;

// Cached on globalThis so dev hot reloads don't open a new pool each time.
const g = globalThis as unknown as { pgPool?: Pool; pgSchema?: Promise<void> };

export const pool = (g.pgPool ??= new Pool({ connectionString: process.env.DATABASE_URL, max: 5 }));

/** Creates tables on first use. */
export function ensureSchema(): Promise<void> {
  g.pgSchema ??= pool
    .query(SCHEMA)
    .then(() => undefined)
    .catch((err) => {
      g.pgSchema = undefined; // retry next time
      throw err;
    });
  return g.pgSchema;
}
