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

-- Price prediction was removed; drop its tables if an older version created them.
DROP TABLE IF EXISTS predictions;
DROP TABLE IF EXISTS prediction_runs;

INSERT INTO symbols (symbol) VALUES ('BTCUSDT') ON CONFLICT DO NOTHING;

-- Candlestick patterns found in stored candles (lib/pattern-detect.ts, written by lib/pattern-store.ts).
-- References the candle that completes the pattern; candles are never modified.
CREATE TABLE IF NOT EXISTS pattern_detections (
  id          BIGSERIAL PRIMARY KEY,
  symbol      TEXT     NOT NULL,
  interval    TEXT     NOT NULL,
  pattern     TEXT     NOT NULL,       -- 'bullish_engulfing', 'doji', ...
  direction   TEXT     NOT NULL CHECK (direction IN ('bullish', 'bearish', 'neutral')),
  ts          BIGINT   NOT NULL,       -- open time of the pattern's last candle, ms UTC
  start_ts    BIGINT   NOT NULL,       -- open time of its first candle
  candles     SMALLINT NOT NULL,
  open        NUMERIC  NOT NULL,       -- OHLC of the last candle, copied exactly from candles
  high        NUMERIC  NOT NULL,
  low         NUMERIC  NOT NULL,
  close       NUMERIC  NOT NULL,
  version     INT      NOT NULL,       -- DETECTOR_VERSION
  meta        JSONB    NOT NULL DEFAULT '{}',
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  time        TIMESTAMPTZ GENERATED ALWAYS AS (to_timestamp(ts / 1000.0)) STORED,
  UNIQUE (symbol, interval, ts, pattern),
  FOREIGN KEY (symbol, interval, ts) REFERENCES candles (symbol, interval, ts)
);
CREATE INDEX IF NOT EXISTS pattern_detections_by_pattern ON pattern_detections (symbol, interval, pattern, ts);

-- Detection checkpoint: every candle with ts <= last_ts has been scanned.
CREATE TABLE IF NOT EXISTS pattern_scan_state (
  symbol     TEXT   NOT NULL,
  interval   TEXT   NOT NULL,
  version    INT    NOT NULL,
  config     JSONB  NOT NULL,
  last_ts    BIGINT NOT NULL,
  scanned    BIGINT NOT NULL DEFAULT 0,
  found      BIGINT NOT NULL DEFAULT 0,
  skipped    BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, interval)
);

-- Evaluation labels for a later stage, kept apart from detection (future candles appear only here).
-- Entry = close of the completing candle; ret_Nm = close N minutes after that close / entry - 1
-- (NULL when that candle is missing or not closed yet).
CREATE OR REPLACE VIEW pattern_outcomes AS
SELECT d.id, d.symbol, d.interval, d.pattern, d.direction, d.ts, d.time, d.close AS entry,
       c5.close  / d.close - 1 AS ret_5m,
       c15.close / d.close - 1 AS ret_15m,
       c30.close / d.close - 1 AS ret_30m,
       c60.close / d.close - 1 AS ret_60m
FROM pattern_detections d
LEFT JOIN candles c5  ON c5.symbol  = d.symbol AND c5.interval  = d.interval AND c5.ts  = d.ts + 5  * 60000
LEFT JOIN candles c15 ON c15.symbol = d.symbol AND c15.interval = d.interval AND c15.ts = d.ts + 15 * 60000
LEFT JOIN candles c30 ON c30.symbol = d.symbol AND c30.interval = d.interval AND c30.ts = d.ts + 30 * 60000
LEFT JOIN candles c60 ON c60.symbol = d.symbol AND c60.interval = d.interval AND c60.ts = d.ts + 60 * 60000;

-- Trained up/down models (scripts/train-model.ts). The newest row per symbol/interval/horizon is used.
CREATE TABLE IF NOT EXISTS ml_models (
  id         BIGSERIAL PRIMARY KEY,
  symbol     TEXT  NOT NULL,
  interval   TEXT  NOT NULL,
  horizon    INT   NOT NULL,           -- candles ahead
  features   JSONB NOT NULL,           -- feature keys, in model order
  model      JSONB NOT NULL,           -- { mean, std, weights, bias }
  metrics    JSONB NOT NULL,           -- validation / out-of-sample test results, pattern stats
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ml_models_latest ON ml_models (symbol, interval, horizon, created_at DESC);

-- Every live signal, logged by the per-minute job (lib/signal-log.ts) when its candle closes and
-- scored later against the candle \`horizon\` steps on - the model's real, forward-only record.
CREATE TABLE IF NOT EXISTS signal_log (
  symbol     TEXT    NOT NULL,
  interval   TEXT    NOT NULL,
  horizon    INT     NOT NULL,
  model_id   BIGINT  NOT NULL REFERENCES ml_models(id),
  ts         BIGINT  NOT NULL,         -- open time of the candle the signal was made after (ms UTC)
  p_up       FLOAT8  NOT NULL,
  close      NUMERIC NOT NULL,         -- that candle's close = entry price
  logged_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, interval, horizon, model_id, ts)
);

-- User-started predictions (lib/predictions.ts): the AI's call for "price in N minutes", saved when
-- started and scored against the real 1m candle when the time is up. Never deleted (full history).
CREATE TABLE IF NOT EXISTS prediction_sessions (
  id             BIGSERIAL PRIMARY KEY,
  symbol         TEXT    NOT NULL,
  minutes        INT     NOT NULL CHECK (minutes > 0),
  status         TEXT    NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'cancelled', 'expired')),
  model_id       BIGINT  NOT NULL REFERENCES ml_models(id),
  basis_ts       BIGINT  NOT NULL,     -- open time of the last closed 1m candle the call is based on (ms UTC)
  start_price    NUMERIC NOT NULL,     -- that candle's close
  ends_at        TIMESTAMPTZ NOT NULL, -- that close + minutes
  p_up           FLOAT8  NOT NULL,
  side           TEXT    NOT NULL CHECK (side IN ('up', 'down')),   -- p_up >= 0.5 -> up
  lean           TEXT    NOT NULL CHECK (lean IN ('up', 'down', 'none')),
  expected_price NUMERIC NOT NULL,
  range_low      NUMERIC NOT NULL,     -- start price -/+ the typical move over the window
  range_high     NUMERIC NOT NULL,
  meta           JSONB   NOT NULL DEFAULT '{}',
  started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  end_price      NUMERIC,
  outcome        TEXT CHECK (outcome IN ('correct', 'wrong', 'flat')),
  resolved_at    TIMESTAMPTZ,
  cancelled_at   TIMESTAMPTZ,
  cancel_price   NUMERIC
);
CREATE INDEX IF NOT EXISTS prediction_sessions_by_symbol ON prediction_sessions (symbol, started_at DESC);
CREATE INDEX IF NOT EXISTS prediction_sessions_running ON prediction_sessions (status) WHERE status = 'running';

-- Accounts (lib/auth.ts). Passwords are scrypt hashes; emails are stored lower-case.
CREATE TABLE IF NOT EXISTS users (
  id            BIGSERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Login sessions: only a SHA-256 of the cookie token is stored.
CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_sessions_user ON auth_sessions (user_id);

-- Predictions belong to the user who started them.
ALTER TABLE prediction_sessions ADD COLUMN IF NOT EXISTS user_id BIGINT REFERENCES users(id);
CREATE INDEX IF NOT EXISTS prediction_sessions_by_user ON prediction_sessions (user_id, symbol, started_at DESC);
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
