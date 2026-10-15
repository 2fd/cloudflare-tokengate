-- 0002: role split (ADR 0018); refused sign-ins; services.template_id; claim labels (ADR 0021);
-- audit indexes. Not additive: rebuilds users and user_identities. Export a backup first
-- (docs/operations/upgrades.md). D1 enforces FKs, and DROP TABLE runs an implicit DELETE that
-- fires no triggers but does cascade, so user_identities is rebuilt against users_new first.
PRAGMA defer_foreign_keys = true;

CREATE TABLE users_new (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'token_manager', 'access_manager', 'viewer')),
  status TEXT NOT NULL CHECK (status IN ('invited', 'pending', 'active', 'suspended')),
  invite_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_login_at INTEGER,
  last_refused_at INTEGER,          -- last refused sign-in (not audited, like last_login_at)
  last_refused_subject TEXT         -- login subject of that attempt
);
INSERT INTO users_new (id, email, name, role, status, invite_expires_at, created_at, updated_at, last_login_at)
  SELECT id, email, name, role, status, invite_expires_at, created_at, updated_at, last_login_at FROM users;

CREATE TABLE user_identities_new (
  login_provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users_new (id) ON DELETE CASCADE,
  email TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  PRIMARY KEY (login_provider, subject)
);
INSERT INTO user_identities_new (login_provider, subject, user_id, email, created_at, last_used_at)
  SELECT login_provider, subject, user_id, email, created_at, last_used_at FROM user_identities;

DROP TABLE user_identities;
DROP TABLE users;                                        -- also drops both last-owner triggers
ALTER TABLE users_new RENAME TO users;                   -- rewrites the FK in user_identities_new
ALTER TABLE user_identities_new RENAME TO user_identities;
CREATE INDEX user_identities_user ON user_identities (user_id);
CREATE INDEX users_status ON users (status);

-- I-OWNER-1 triggers, verbatim from 0001.
CREATE TRIGGER users_last_owner_update
BEFORE UPDATE OF role, status ON users
WHEN OLD.role = 'owner' AND OLD.status = 'active'
  AND (NEW.role <> 'owner' OR NEW.status <> 'active')
  AND (SELECT count(*) FROM users WHERE role = 'owner' AND status = 'active') <= 1
BEGIN SELECT RAISE(ABORT, 'last_owner'); END;
CREATE TRIGGER users_last_owner_delete
BEFORE DELETE ON users
WHEN OLD.role = 'owner' AND OLD.status = 'active'
  AND (SELECT count(*) FROM users WHERE role = 'owner' AND status = 'active') <= 1
BEGIN SELECT RAISE(ABORT, 'last_owner'); END;

-- Template of a service: display and preset data only, never part of the AAD (ADR 0004).
ALTER TABLE services ADD COLUMN template_id TEXT;
UPDATE services SET template_id = 'slack'           WHERE base_url = 'https://slack.com/api'            AND injection = '{"kind":"bearer"}';
UPDATE services SET template_id = 'slack-webhook'   WHERE base_url = 'https://hooks.slack.com/services' AND injection = '{"kind":"path"}';
UPDATE services SET template_id = 'discord-webhook' WHERE base_url = 'https://discord.com/api/webhooks' AND injection = '{"kind":"path"}';
UPDATE services SET template_id = 'openai'          WHERE base_url = 'https://api.openai.com/v1'        AND injection = '{"kind":"bearer"}';
UPDATE services SET template_id = 'anthropic'       WHERE base_url = 'https://api.anthropic.com'        AND injection = '{"kind":"header","name":"x-api-key"}';
UPDATE services SET template_id = 'github'          WHERE base_url = 'https://api.github.com'           AND injection = '{"kind":"bearer"}';
UPDATE services SET template_id = 'github-uploads'  WHERE base_url = 'https://uploads.github.com'       AND injection = '{"kind":"bearer"}';
-- (The injection literals must equal canonicalJson(template.injection); a unit test asserts each UPDATE.)

-- Human labels for numeric IDs, per consumer. Written only by consumer and access saves.
-- Display and form derivation only; src/policy/* never reads it.
CREATE TABLE claim_labels (
  caller_provider_id TEXT NOT NULL REFERENCES caller_providers (id),
  claim TEXT NOT NULL CHECK (claim IN ('repository_owner_id', 'repository_id', 'namespace_id', 'project_id')),
  value TEXT NOT NULL CHECK (length(value) BETWEEN 1 AND 20 AND value NOT GLOB '*[^0-9]*'),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 256),
  updated_at INTEGER NOT NULL,
  updated_by TEXT,
  PRIMARY KEY (caller_provider_id, claim, value)
);

-- Audit list filters; the list orders by id.
CREATE INDEX audit_log_actor ON audit_log (actor_id, id);
CREATE INDEX audit_log_action ON audit_log (action, id);
