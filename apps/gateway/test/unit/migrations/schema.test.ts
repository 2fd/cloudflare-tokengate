// The control-plane schema (migrations/0001_initial.sql) on an empty database: the role CHECK, the
// last-owner triggers, the identity cascade, the indexes and the claim_labels checks.
// MIGRATION_TEST_DB starts empty and no other test writes to it; this file applies the migrations
// itself.
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';

const db = env.MIGRATION_TEST_DB;

const T = 1_700_000_000_000;

async function rows(sql: string): Promise<Array<Record<string, unknown>>> {
  return (await db.prepare(sql).all<Record<string, unknown>>()).results;
}

async function refused(statement: D1PreparedStatement): Promise<string> {
  try {
    await statement.run();
  } catch (error) {
    return error instanceof Error ? `${error.message} ${String(error.cause ?? '')}` : String(error);
  }
  return 'not refused';
}

const user = (id: string, role: string) =>
  db
    .prepare(
      `INSERT INTO users (id, email, role, status, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?)`,
    )
    .bind(id, `${id}@example.com`, role, T, T);

const identity = (subject: string, userId: string) =>
  db
    .prepare(
      `INSERT INTO user_identities (login_provider, subject, user_id, email, created_at)
       VALUES ('access', ?, ?, ?, ?)`,
    )
    .bind(subject, userId, `${userId}@example.com`, T);

beforeAll(async () => {
  await applyD1Migrations(db, env.TEST_MIGRATIONS);
  await db.batch([
    db.prepare(`INSERT INTO credentials (id, slug, name, base_url, injection, created_at, updated_at)
      VALUES ('svc_schema', 'schema', 'Schema fixture', 'https://api.example.com', '{"kind":"bearer"}', 0, 0)`),
    user('usr_owner1', 'owner'),
    user('usr_owner2', 'owner'),
    user('usr_viewer', 'viewer'),
    identity('team|owner1', 'usr_owner1'),
    identity('team|viewer-a', 'usr_viewer'),
    identity('team|viewer-b', 'usr_viewer'),
    db
      .prepare(
        `INSERT INTO credential_access_rules (id, credential_id, name, profile, issuer, jwks_uri, audience, allowed_algs,
           created_at, updated_at, max_token_age_seconds)
         VALUES ('cpr_1', (SELECT id FROM credentials ORDER BY id LIMIT 1), 'GitHub', 'github-actions', 'https://token.actions.githubusercontent.com',
           'https://token.actions.githubusercontent.com/.well-known/jwks',
           'tokengate:0123456789abcdef', '["RS256"]', ?, ?, 900)`,
      )
      .bind(T, T),
  ]);
});

describe('I-OWNER-1: users, roles and identities', () => {
  it('accepts the five roles and refuses others', async () => {
    for (const role of ['admin', 'token_manager', 'access_manager']) {
      await user(`usr_role_${role}`, role).run();
    }
    expect(await refused(user('usr_role_superuser', 'superuser'))).toMatch(/CHECK constraint/);
    await db.prepare("DELETE FROM users WHERE id LIKE 'usr_role_%'").run();
  });

  it('stores refused sign-ins in nullable columns', async () => {
    expect(
      await rows("SELECT last_refused_at, last_refused_subject FROM users WHERE id = 'usr_viewer'"),
    ).toEqual([{ last_refused_at: null, last_refused_subject: null }]);
  });

  it('keeps the last active owner', async () => {
    await db.prepare("UPDATE users SET role = 'viewer' WHERE id = 'usr_owner2'").run();
    expect(
      await refused(db.prepare("UPDATE users SET role = 'admin' WHERE id = 'usr_owner1'")),
    ).toContain('last_owner');
    expect(
      await refused(db.prepare("UPDATE users SET status = 'suspended' WHERE id = 'usr_owner1'")),
    ).toContain('last_owner');
    expect(await refused(db.prepare("DELETE FROM users WHERE id = 'usr_owner1'"))).toContain(
      'last_owner',
    );
  });

  it('deleting a user cascades to its identities', async () => {
    await db.prepare("DELETE FROM users WHERE id = 'usr_viewer'").run();
    expect(await rows('SELECT subject FROM user_identities ORDER BY subject')).toEqual([
      { subject: 'team|owner1' },
    ]);
  });

  it('creates the indexes', async () => {
    const names = (await rows("SELECT name FROM sqlite_master WHERE type = 'index'")).map(
      (row) => row.name,
    );
    for (const index of [
      'user_identities_user',
      'users_status',
      'audit_log_actor',
      'audit_log_action',
    ]) {
      expect(names, index).toContain(index);
    }
  });
});

describe('credentials.template_id', () => {
  it('is nullable', async () => {
    await db
      .prepare(
        `INSERT INTO credentials (id, slug, name, base_url, injection, created_at, updated_at)
         VALUES ('svc_1', 'one', 'One', 'https://api.example.com', '{"kind":"bearer"}', ?, ?)`,
      )
      .bind(T, T)
      .run();
    expect(await rows("SELECT template_id FROM credentials WHERE id = 'svc_1'")).toEqual([
      { template_id: null },
    ]);
  });
});

describe('claim_labels', () => {
  const label = (value: string) =>
    db
      .prepare(
        `INSERT INTO claim_labels (credential_access_rule_id, claim, value, label, updated_at)
         VALUES ('cpr_1', 'repository_id', ?, 'acme/api', ?)`,
      )
      .bind(value, T);

  it('accepts a numeric ID', async () => {
    await label('1234567').run();
    expect(await rows('SELECT value FROM claim_labels')).toEqual([{ value: '1234567' }]);
  });

  it.each(['12a', '', 'a12', '-1', '123456789012345678901'])(
    'refuses the value %j',
    async (value) => {
      expect(await refused(label(value))).toMatch(/CHECK constraint/);
    },
  );

  it('refuses unknown claims and credential access rules', async () => {
    expect(
      await refused(
        db
          .prepare(
            `INSERT INTO claim_labels (credential_access_rule_id, claim, value, label, updated_at)
             VALUES ('cpr_1', 'sub', '1', 'x', ?)`,
          )
          .bind(T),
      ),
    ).toMatch(/CHECK constraint/);
    expect(
      await refused(
        db
          .prepare(
            `INSERT INTO claim_labels (credential_access_rule_id, claim, value, label, updated_at)
             VALUES ('cpr_missing', 'repository_id', '1', 'x', ?)`,
          )
          .bind(T),
      ),
    ).toMatch(/FOREIGN KEY constraint/);
  });
});
