// migrations/0002_admin_redesign.sql on a database that holds 0001 data: the users and
// user_identities rebuild keeps every row (no cascade fires), the last-owner triggers survive,
// and the template backfill and claim_labels checks hold. MIGRATION_TEST_DB starts empty; this
// file applies the migrations itself.
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { SERVICE_TEMPLATES } from '../../../src/admin/service-templates';
import { canonicalJson } from '../../../src/lib/json';

const db = env.MIGRATION_TEST_DB;
const migrations = env.TEST_MIGRATIONS.toSorted((a, b) => a.name.localeCompare(b.name));
const initial = migrations.filter((migration) => migration.name === '0001_initial.sql');
const redesign = migrations.find((migration) => migration.name === '0002_admin_redesign.sql');

const T = 1_700_000_000_000;

/** A service row as 0001 stores it; `injection` is canonical JSON. */
function service(id: string, baseUrl: string, injection: unknown) {
  return db
    .prepare(
      `INSERT INTO services (id, slug, name, base_url, injection, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, id.replace('svc_', ''), id, baseUrl, canonicalJson(injection), T, T);
}

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

let usersBefore: Array<Record<string, unknown>>;
let identitiesBefore: Array<Record<string, unknown>>;

beforeAll(async () => {
  if (!redesign || initial.length !== 1) throw new Error('migrations 0001 and 0002 not found');
  await applyD1Migrations(db, initial);
  const user = (id: string, email: string, role: string) =>
    db
      .prepare(
        `INSERT INTO users (id, email, name, role, status, created_at, updated_at, last_login_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
      )
      .bind(id, email, `Name ${id}`, role, T, T + 1, T + 2);
  const identity = (subject: string, userId: string) =>
    db
      .prepare(
        `INSERT INTO user_identities (login_provider, subject, user_id, email, created_at, last_used_at)
         VALUES ('access', ?, ?, ?, ?, ?)`,
      )
      .bind(subject, userId, `${userId}@example.com`, T, T + 3);
  await db.batch([
    user('usr_owner1', 'owner1@example.com', 'owner'),
    user('usr_owner2', 'owner2@example.com', 'owner'),
    user('usr_viewer', 'viewer@example.com', 'viewer'),
    identity('team|owner1', 'usr_owner1'),
    identity('team|owner2', 'usr_owner2'),
    identity('team|viewer-a', 'usr_viewer'),
    identity('team|viewer-b', 'usr_viewer'),
    ...SERVICE_TEMPLATES.map((template) =>
      service(`svc_${template.id}`, template.base_url, template.injection),
    ),
    // Same host as a template, other injection: no template.
    service('svc_custom', 'https://api.openai.com/v1', { kind: 'header', name: 'x-api-key' }),
    db
      .prepare(
        `INSERT INTO caller_providers (id, name, profile, issuer, jwks_uri, audience, allowed_algs,
           created_at, updated_at, max_token_age_seconds)
         VALUES ('cpr_1', 'GitHub', 'github-actions', 'https://token.actions.githubusercontent.com',
           'https://token.actions.githubusercontent.com/.well-known/jwks',
           'tokengate:0123456789abcdef', '["RS256"]', ?, ?, 900)`,
      )
      .bind(T, T),
  ]);
  usersBefore = await rows('SELECT * FROM users ORDER BY id');
  identitiesBefore = await rows('SELECT * FROM user_identities ORDER BY subject');
  await applyD1Migrations(db, migrations);
});

describe('I-OWNER-1: migration 0002 rebuilds users and user_identities without losing rows', () => {
  it('keeps every user, with the new columns null', async () => {
    expect(await rows('SELECT * FROM users ORDER BY id')).toEqual(
      usersBefore.map((row) => ({ ...row, last_refused_at: null, last_refused_subject: null })),
    );
  });

  it('keeps every identity (no cascade fired during the rebuild)', async () => {
    expect(await rows('SELECT * FROM user_identities ORDER BY subject')).toEqual(identitiesBefore);
    expect(identitiesBefore).toHaveLength(4);
  });

  it('accepts the five roles and refuses others', async () => {
    const insert = (id: string, role: string) =>
      db
        .prepare(
          `INSERT INTO users (id, email, role, status, created_at, updated_at)
           VALUES (?, ?, ?, 'active', ?, ?)`,
        )
        .bind(id, `${id}@example.com`, role, T, T);
    for (const role of ['owner', 'admin', 'token_manager', 'access_manager', 'viewer']) {
      await insert(`usr_role_${role}`, role).run();
    }
    expect(await refused(insert('usr_role_superuser', 'superuser'))).toMatch(/CHECK constraint/);
    await db.prepare("DELETE FROM users WHERE id LIKE 'usr_role_%' AND role <> 'owner'").run();
  });

  it('keeps both last-owner triggers', async () => {
    const owners = await rows("SELECT id FROM users WHERE role = 'owner' AND status = 'active'");
    await db
      .prepare("UPDATE users SET role = 'viewer' WHERE id IN (?, ?)")
      .bind('usr_owner2', 'usr_role_owner')
      .run();
    expect(owners.length).toBe(3);
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

  it('deleting a user cascades to its identities (the FK follows the renamed table)', async () => {
    await db.prepare("DELETE FROM users WHERE id = 'usr_viewer'").run();
    expect(await rows("SELECT * FROM user_identities WHERE user_id = 'usr_viewer'")).toEqual([]);
    expect(await rows('SELECT subject FROM user_identities ORDER BY subject')).toEqual([
      { subject: 'team|owner1' },
      { subject: 'team|owner2' },
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

describe('migration 0002: services.template_id backfill', () => {
  it('sets the template of services whose base URL and injection match one, else null', async () => {
    const stored = await rows('SELECT id, template_id FROM services ORDER BY id');
    expect(Object.fromEntries(stored.map((row) => [row.id, row.template_id]))).toEqual({
      ...Object.fromEntries(SERVICE_TEMPLATES.map((t) => [`svc_${t.id}`, t.id])),
      svc_custom: null,
    });
  });

  it('every UPDATE literal equals the base URL and canonical injection of its template', () => {
    const updates = (redesign?.queries ?? [])
      .map((query) =>
        /UPDATE services SET template_id = '([^']+)'\s+WHERE base_url = '([^']+)'\s+AND injection = '([^']+)'/.exec(
          query,
        ),
      )
      .filter((match) => match !== null);
    expect(updates.length).toBeGreaterThan(0);
    for (const [, id, baseUrl, injection] of updates) {
      const template = SERVICE_TEMPLATES.find((candidate) => candidate.id === id);
      expect(template, id).toBeDefined();
      expect(baseUrl, id).toBe(template?.base_url);
      expect(injection, id).toBe(canonicalJson(template?.injection));
    }
  });
});

describe('migration 0002: claim_labels', () => {
  const label = (value: string) =>
    db
      .prepare(
        `INSERT INTO claim_labels (caller_provider_id, claim, value, label, updated_at)
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

  it('refuses unknown claims and caller providers', async () => {
    expect(
      await refused(
        db
          .prepare(
            `INSERT INTO claim_labels (caller_provider_id, claim, value, label, updated_at)
             VALUES ('cpr_1', 'sub', '1', 'x', ?)`,
          )
          .bind(T),
      ),
    ).toMatch(/CHECK constraint/);
    expect(
      await refused(
        db
          .prepare(
            `INSERT INTO claim_labels (caller_provider_id, claim, value, label, updated_at)
             VALUES ('cpr_missing', 'repository_id', '1', 'x', ?)`,
          )
          .bind(T),
      ),
    ).toMatch(/FOREIGN KEY constraint/);
  });
});
