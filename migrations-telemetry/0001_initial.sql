-- Telemetry schema (TELEMETRY_DB). Separate database so request volume cannot exhaust the control plane.

-- At most one row per proxied request (allowed, denied, error): allowed requests are sampled
-- (weight = 1 / sample rate) and pre-trust failures are capped per isolate.
-- id is the request id "req_<ULID>": time-ordered, so retention purges by id range and
-- INSERT OR IGNORE makes queue redelivery idempotent. WITHOUT ROWID avoids a second B-tree.
CREATE TABLE request_log (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('allowed', 'denied', 'error')),
  reason TEXT,                 -- machine code, see docs/errors.md
  status INTEGER NOT NULL,     -- status the gateway returned
  upstream_status INTEGER,     -- status the upstream returned (NULL if not forwarded)
  method TEXT NOT NULL,
  path TEXT NOT NULL,          -- canonical path relative to the service, without query
  service_slug TEXT,
  service_id TEXT,
  caller_provider_id TEXT,
  grant_id TEXT,
  claims_verified INTEGER NOT NULL, -- 0: caller fields are empty (I-LOG-2)
  caller_subject TEXT,
  caller_repository TEXT,
  caller_claims TEXT,          -- JSON, allowlisted per profile
  jti TEXT,
  untrusted_iss TEXT,          -- unverified issuer, only when claims_verified = 0
  eval_trace TEXT,             -- JSON, denied requests only, <= 2 KB
  duration_ms INTEGER NOT NULL,
  upstream_ms INTEGER,
  weight REAL NOT NULL DEFAULT 1, -- 1 / sample rate
  ip TEXT,
  user_agent TEXT,
  colo TEXT
) WITHOUT ROWID;
CREATE INDEX request_log_service ON request_log (service_id, id);
CREATE INDEX request_log_repository ON request_log (caller_repository, id);
-- Lets the dashboard find a verified call in one row read, however many pre-trust rows exist.
CREATE INDEX request_log_verified ON request_log (id) WHERE claims_verified = 1;

-- Hourly aggregates, recomputed by the cron from request_log. '' = unknown service/grant.
CREATE TABLE request_rollup_hourly (
  hour INTEGER NOT NULL,       -- ms timestamp of the hour start (UTC)
  service_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  outcome TEXT NOT NULL,
  status_class INTEGER NOT NULL,
  requests REAL NOT NULL,
  upstream_auth_fail REAL NOT NULL,
  duration_sum_ms REAL NOT NULL,
  le_50 REAL NOT NULL DEFAULT 0,
  le_100 REAL NOT NULL DEFAULT 0,
  le_250 REAL NOT NULL DEFAULT 0,
  le_500 REAL NOT NULL DEFAULT 0,
  le_1000 REAL NOT NULL DEFAULT 0,
  le_2500 REAL NOT NULL DEFAULT 0,
  le_5000 REAL NOT NULL DEFAULT 0,
  gt_5000 REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (hour, service_id, grant_id, outcome, status_class)
) WITHOUT ROWID;
