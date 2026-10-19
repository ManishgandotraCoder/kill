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

-- A prediction run: predict every 1h candle from start_ts (first candle open)
-- to end_ts (last candle close), with the model frozen at start_ts.
CREATE TABLE IF NOT EXISTS prediction_runs (
  id         SERIAL      PRIMARY KEY,
  symbol     TEXT        NOT NULL REFERENCES symbols(symbol),
  start_ts   BIGINT      NOT NULL,
  end_ts     BIGINT      NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per predicted hour; actual_close is filled once that hour closes.
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
  source          TEXT        NOT NULL DEFAULT 'auto',  -- 'run:<id>'
  run_id          INT         REFERENCES prediction_runs(id) ON DELETE CASCADE,
  PRIMARY KEY (symbol, target_ts, source)
);

-- Upgrade tables created before the source column existed.
ALTER TABLE predictions ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'auto';
ALTER TABLE predictions ADD COLUMN IF NOT EXISTS run_id INT REFERENCES prediction_runs(id) ON DELETE CASCADE;
-- Minutes from target_ts the prediction covers: 60 = one 1h candle, less = a short run (price at the end).
ALTER TABLE predictions ADD COLUMN IF NOT EXISTS horizon_min INT NOT NULL DEFAULT 60;
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
