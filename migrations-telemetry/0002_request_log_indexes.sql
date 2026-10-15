-- 0002: two request_log indexes for the Monitoring pages (additive). CREATE INDEX reads the whole
-- request_log once: apply it while the table is small, or lower request_log_max_rows first
-- (docs/operations/upgrades.md).

-- Problem rows only (denied, error, upstream 5xx), so sampled allowed rows pay no extra index
-- write. Queries must repeat the WHERE term literally for SQLite to use it (src/db/requests.ts,
-- src/db/rollups.ts denialGroupsStatement).
CREATE INDEX request_log_problems ON request_log (id) WHERE outcome <> 'allowed' OR status >= 500;

-- "Requests through this consumer access" (Requests ?access=).
CREATE INDEX request_log_grant ON request_log (grant_id, id);
