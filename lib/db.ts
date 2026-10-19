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

-- One row per next-hour forecast; actual_close is filled once that hour closes.
CREATE TABLE IF NOT EXISTS predictions (
  symbol          TEXT        NOT NULL REFERENCES symbols(symbol),
  target_ts       BIGINT      NOT NULL,  -- open time of the predicted 1h candle, ms UTC
  time            TIMESTAMPTZ GENERATED ALWAYS AS (to_timestamp(target_ts / 1000.0)) STORED,
  base_close      NUMERIC     NOT NULL,  -- close of the previous hour
  predicted_close NUMERIC     NOT NULL,
  lower           NUMERIC     NOT NULL,  -- 80% range
  upper           NUMERIC     NOT NULL,
  actual_close    NUMERIC,
  made_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  source          TEXT        NOT NULL DEFAULT 'auto',  -- 'auto' (hourly job) or 'manual' (Save button)
  PRIMARY KEY (symbol, target_ts, source)
);

-- Upgrade tables created before the source column existed.
ALTER TABLE predictions ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'auto';
DO $$ BEGIN
  IF (SELECT array_length(conkey, 1) FROM pg_constraint WHERE conname = 'predictions_pkey') = 2 THEN
    ALTER TABLE predictions DROP CONSTRAINT predictions_pkey;
    ALTER TABLE predictions ADD PRIMARY KEY (symbol, target_ts, source);
  END IF;
END $$;

INSERT INTO symbols (symbol) VALUES ('BTCUSDT') ON CONFLICT DO NOTHING;
`;

// Cached on globalThis so dev hot reloads don't open a new pool each time.
const g = globalThis as unknown as { pgPool?: Pool; pgSchema?: Promise<void>; pgSchemaSql?: string };

export const pool = (g.pgPool ??= new Pool({ connectionString: process.env.DATABASE_URL, max: 5 }));

/** Creates tables on first use (and again if SCHEMA changed during a dev hot reload). */
export function ensureSchema(): Promise<void> {
  if (g.pgSchemaSql !== SCHEMA) {
    g.pgSchemaSql = SCHEMA;
    g.pgSchema = undefined;
  }
  g.pgSchema ??= pool
    .query(SCHEMA)
    .then(() => undefined)
    .catch((err) => {
      g.pgSchema = undefined; // retry next time
      throw err;
    });
  return g.pgSchema;
}
