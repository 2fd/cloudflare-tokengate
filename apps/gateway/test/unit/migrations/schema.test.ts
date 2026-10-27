// The control-plane schema (migrations/0001_initial.sql) on an empty database: the role CHECK, the
// last-owner triggers, the identity cascade, the indexes, the access_rules checks and triggers
// (ADR 0026, I-AUTHZ-5) and the claim_labels checks.
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
      VALUES ('svc_schema', 'schema', 'Schema fixture', 'https://schema.example.com', '{"kind":"bearer"}', 0, 0)`),
    user('usr_owner1', 'owner'),
    user('usr_owner2', 'owner'),
    user('usr_viewer', 'viewer'),
    identity('team|owner1', 'usr_owner1'),
    identity('team|viewer-a', 'usr_viewer'),
    identity('team|viewer-b', 'usr_viewer'),
    credentialRule({ id: 'acr_1', name: 'GitHub' }),
  ]);
});

const GH = 'https://token.actions.githubusercontent.com';

/** A valid credential access rule of svc_schema; `over` replaces columns (null is SQL NULL). */
function credentialRule(over: Record<string, unknown> = {}): D1PreparedStatement {
  return ruleRow({
    credential_id: 'svc_schema',
    jwks_uri: `${GH}/.well-known/jwks`,
    audience: 'tokengate:0123456789abcdef',
    allowed_algs: '["RS256"]',
    max_token_age_seconds: 900,
    tenant_pin: '[{"claim":"repository_owner_id","match":"exact","values":["1"]}]',
    anchor_claims: '[]',
    conditions: '[{"claim":"repository_id","match":"exact","values":["2"]}]',
    rules: '[{"methods":["GET"],"path":"/**"}]',
    ...over,
  });
}

/** A global access rule of GitHub with no limits; `over` replaces columns. */
function globalRule(over: Record<string, unknown> = {}): D1PreparedStatement {
  return ruleRow({ credential_id: null, ...over });
}

const RULE_COLUMNS = [
  'id',
  'credential_id',
  'name',
  'profile',
  'issuer',
  'issuer_key',
  'jwks_uri',
  'audience',
  'allowed_algs',
  'max_token_age_seconds',
  'tenant_pin',
  'anchor_claims',
  'conditions',
  'rules',
  'description',
  'created_at',
  'updated_at',
] as const;

let ruleSequence = 0;
function ruleRow(over: Record<string, unknown>): D1PreparedStatement {
  ruleSequence++;
  const global = over.credential_id === null;
  const issuer = (over.issuer as string | undefined) ?? GH;
  const row: Record<string, unknown> = {
    id: `${global ? 'gar' : 'acr'}_${ruleSequence}`,
    name: `rule ${ruleSequence}`,
    profile: 'github-actions',
    issuer,
    issuer_key: issuer.replace(/\/+$/, '').toLowerCase(),
    jwks_uri: null,
    audience: null,
    allowed_algs: null,
    max_token_age_seconds: null,
    tenant_pin: null,
    anchor_claims: null,
    conditions: null,
    rules: null,
    description: '',
    created_at: T + ruleSequence,
    updated_at: T + ruleSequence,
    ...over,
  };
  return db
    .prepare(
      `INSERT INTO access_rules (${RULE_COLUMNS.join(', ')}) VALUES (${RULE_COLUMNS.map(() => '?').join(', ')})`,
    )
    .bind(...RULE_COLUMNS.map((column) => row[column] ?? null));
}

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
         VALUES ('svc_1', 'one', 'One', 'https://one.example.com', '{"kind":"bearer"}', ?, ?)`,
      )
      .bind(T, T)
      .run();
    expect(await rows("SELECT template_id FROM credentials WHERE id = 'svc_1'")).toEqual([
      { template_id: null },
    ]);
  });
});

describe('access_rules: kinds and checks (ADR 0026, I-AUTHZ-5)', () => {
  it('accepts a credential access rule and a global access rule without limits', async () => {
    await credentialRule({ id: 'acr_ok' }).run();
    await globalRule({ id: 'gar_ok' }).run();
    expect(
      await rows(
        "SELECT id, credential_id FROM access_rules WHERE id IN ('acr_ok', 'gar_ok') ORDER BY id",
      ),
    ).toEqual([
      { id: 'acr_ok', credential_id: 'svc_schema' },
      { id: 'gar_ok', credential_id: null },
    ]);
    await db.prepare("DELETE FROM access_rules WHERE id IN ('acr_ok', 'gar_ok')").run();
  });

  // Profiles are code (ADR 0028): a new one needs no migration; getProfile fails closed on unknown ids.
  it('takes any profile id and refuses an empty one', async () => {
    await credentialRule({ id: 'acr_vercel', profile: 'vercel' }).run();
    expect(await refused(credentialRule({ id: 'acr_empty', profile: '' }))).toMatch(
      /CHECK constraint/,
    );
    await db.prepare("DELETE FROM access_rules WHERE id = 'acr_vercel'").run();
  });

  it('ties the id prefix to the kind', async () => {
    expect(await refused(credentialRule({ id: 'gar_wrong' }))).toMatch(/CHECK constraint/);
    expect(await refused(globalRule({ id: 'acr_wrong' }))).toMatch(/CHECK constraint/);
    expect(await refused(credentialRule({ id: 'svc_old' }))).toMatch(/CHECK constraint/);
  });

  it.each([
    ['jwks_uri', null],
    ['audience', null],
    ['max_token_age_seconds', null],
    ['allowed_algs', '[]'],
    ['allowed_algs', 'not json'],
    ['tenant_pin', '{}'],
    ['anchor_claims', null],
    ['conditions', '[]'],
    ['conditions', '{"claim":"x"}'],
    ['rules', '[]'],
    ['rules', null],
  ])('requires every limit of a credential access rule (%s = %j)', async (column, value) => {
    expect(await refused(credentialRule({ [column]: value }))).toMatch(/CHECK constraint/);
  });

  it.each([
    ['allowed_algs', '[]'],
    ['tenant_pin', '[]'],
    ['anchor_claims', '[]'],
    ['conditions', '[]'],
    ['rules', '[]'],
    ['conditions', 'not json'],
    ['rules', '{"methods":["GET"]}'],
    ['anchor_claims', '["a","b","c","d","e","f","g","h","i"]'],
  ])(
    'refuses an empty or malformed limit of a global access rule (%s = %j)',
    async (column, value) => {
      expect(await refused(globalRule({ [column]: value }))).toMatch(/CHECK constraint/);
    },
  );

  it('checks the audience length, the token age and the description length', async () => {
    expect(await refused(credentialRule({ audience: 'too-short' }))).toMatch(/CHECK constraint/);
    expect(await refused(globalRule({ audience: 'too-short' }))).toMatch(/CHECK constraint/);
    expect(await refused(credentialRule({ max_token_age_seconds: 59 }))).toMatch(
      /CHECK constraint/,
    );
    expect(await refused(globalRule({ max_token_age_seconds: 30 }))).toMatch(/CHECK constraint/);
    expect(await refused(credentialRule({ description: 'x'.repeat(2001) }))).toMatch(
      /CHECK constraint/,
    );
    expect(await refused(credentialRule({ name: '   ' }))).toMatch(/CHECK constraint/);
  });

  it('requires issuer_key = lower(rtrim(issuer, "/")) (AR-3)', async () => {
    expect(
      await refused(
        globalRule({ issuer: 'https://GitLab.com//', issuer_key: 'https://GitLab.com' }),
      ),
    ).toMatch(/CHECK constraint/);
    await globalRule({
      id: 'gar_key',
      issuer: 'https://GitLab.com//',
      issuer_key: 'https://gitlab.com',
    }).run();
    expect(await rows("SELECT issuer_key FROM access_rules WHERE id = 'gar_key'")).toEqual([
      { issuer_key: 'https://gitlab.com' },
    ]);
    await db.prepare("DELETE FROM access_rules WHERE id = 'gar_key'").run();
  });
});

describe('access_rules: names', () => {
  it('keeps names unique per credential and among global rules, case-insensitively', async () => {
    await credentialRule({ id: 'acr_n1', name: 'Deploy' }).run();
    expect(await refused(credentialRule({ name: 'deploy' }))).toContain(
      "UNIQUE constraint failed: index 'access_rules_name'",
    );
    await db
      .prepare(
        "INSERT INTO credentials (id, slug, name, base_url, injection, created_at, updated_at) VALUES ('svc_other', 'other', 'Other', 'https://other.example.com', '{\"kind\":\"bearer\"}', 0, 0)",
      )
      .run();
    await credentialRule({ id: 'acr_n2', name: 'Deploy', credential_id: 'svc_other' }).run();
    await globalRule({ id: 'gar_n1', name: 'Deploy' }).run();
    expect(await refused(globalRule({ name: 'DEPLOY' }))).toContain(
      "UNIQUE constraint failed: index 'access_rules_name'",
    );
    await db.prepare("DELETE FROM access_rules WHERE id IN ('acr_n1', 'acr_n2', 'gar_n1')").run();
    await db.prepare("DELETE FROM credentials WHERE id = 'svc_other'").run();
  });
});

describe('access_rules: integrity triggers (ADR 0014, AR-5)', () => {
  it("never changes the id, the credential, the profile or a global rule's issuer", async () => {
    await credentialRule({ id: 'acr_t' }).run();
    await globalRule({ id: 'gar_t', issuer: 'https://gitlab.com', profile: 'gitlab-ci' }).run();
    expect(
      await refused(db.prepare("UPDATE access_rules SET id = 'acr_t2' WHERE id = 'acr_t'")),
    ).toContain('immutable_row');
    expect(
      await refused(db.prepare("UPDATE access_rules SET credential_id = NULL WHERE id = 'acr_t'")),
    ).toContain('immutable_row');
    expect(
      await refused(db.prepare("UPDATE access_rules SET profile = 'generic' WHERE id = 'acr_t'")),
    ).toContain('immutable_row');
    expect(
      await refused(
        db.prepare(
          "UPDATE access_rules SET issuer = 'https://gitlab.example.com', issuer_key = 'https://gitlab.example.com' WHERE id = 'gar_t'",
        ),
      ),
    ).toContain('immutable_row');
    // A credential access rule may move to another issuer.
    await db
      .prepare(
        "UPDATE access_rules SET issuer = 'https://token.actions.githubusercontent.com/acme', issuer_key = 'https://token.actions.githubusercontent.com/acme' WHERE id = 'acr_t'",
      )
      .run();
    await db.prepare("DELETE FROM access_rules WHERE id IN ('acr_t', 'gar_t')").run();
  });

  it('caps the credential access rules of one credential at 100', async () => {
    await db.prepare("DELETE FROM access_rules WHERE credential_id = 'svc_schema'").run();
    await db.batch(
      Array.from({ length: 100 }, (_, i) =>
        credentialRule({ id: `acr_cap${i}`, name: `cap ${i}` }),
      ),
    );
    expect(await refused(credentialRule({ name: 'one too many' }))).toContain(
      'too_many_credential_rules',
    );
    await db.prepare("DELETE FROM access_rules WHERE id LIKE 'acr_cap%'").run();
    await credentialRule({ id: 'acr_1', name: 'GitHub' }).run();
  });

  it('caps the global access rules of one issuer key at 20', async () => {
    await db.batch(
      Array.from({ length: 20 }, (_, i) =>
        globalRule({ id: `gar_cap${i}`, name: `global cap ${i}`, issuer: `${GH}/` }),
      ),
    );
    expect(await refused(globalRule({ name: 'one too many' }))).toContain('too_many_global_rules');
    // Another issuer key is not counted.
    await globalRule({ id: 'gar_other', issuer: 'https://gitlab.com', profile: 'gitlab-ci' }).run();
    await db.prepare("DELETE FROM access_rules WHERE id LIKE 'gar_%'").run();
  });

  it('caps the (JWKS URI, audience) pairs of a credential and issuer key at 4, on insert and update', async () => {
    for (const n of [2, 3, 4]) {
      await credentialRule({ id: `acr_v${n}`, audience: `tokengate:audience-${n}-xxxxxx` }).run();
    }
    // A fifth pair is refused; a repeated pair is accepted.
    expect(await refused(credentialRule({ audience: 'tokengate:audience-5-xxxxxx' }))).toContain(
      'too_many_verification_settings',
    );
    await credentialRule({ id: 'acr_v4b', audience: 'tokengate:audience-4-xxxxxx' }).run();
    expect(
      await refused(
        db.prepare(
          "UPDATE access_rules SET audience = 'tokengate:audience-6-xxxxxx' WHERE id = 'acr_v4'",
        ),
      ),
    ).toContain('too_many_verification_settings');
    await db.prepare("DELETE FROM access_rules WHERE id LIKE 'acr_v%'").run();
  });
});

describe('access_rules: cascades', () => {
  it('deleting a credential deletes its rules and their labels', async () => {
    await db
      .prepare(
        "INSERT INTO credentials (id, slug, name, base_url, injection, created_at, updated_at) VALUES ('svc_gone', 'gone', 'Gone', 'https://gone.example.com', '{\"kind\":\"bearer\"}', 0, 0)",
      )
      .run();
    await credentialRule({ id: 'acr_gone', credential_id: 'svc_gone' }).run();
    await db
      .prepare(
        "INSERT INTO claim_labels (access_rule_id, claim, value, label, updated_at) VALUES ('acr_gone', 'repository_id', '2', 'acme/api', 0)",
      )
      .run();
    await db.prepare("DELETE FROM credentials WHERE id = 'svc_gone'").run();
    expect(await rows("SELECT id FROM access_rules WHERE id = 'acr_gone'")).toEqual([]);
    expect(await rows("SELECT value FROM claim_labels WHERE access_rule_id = 'acr_gone'")).toEqual(
      [],
    );
  });

  it('deleting a global access rule deletes its labels', async () => {
    await globalRule({
      id: 'gar_lab',
      tenant_pin: '[{"claim":"repository_owner_id","match":"exact","values":["1"]}]',
    }).run();
    await db
      .prepare(
        "INSERT INTO claim_labels (access_rule_id, claim, value, label, updated_at) VALUES ('gar_lab', 'repository_owner_id', '1', 'acme', 0)",
      )
      .run();
    await db.prepare("DELETE FROM access_rules WHERE id = 'gar_lab'").run();
    expect(await rows("SELECT value FROM claim_labels WHERE access_rule_id = 'gar_lab'")).toEqual(
      [],
    );
  });
});

describe('claim_labels', () => {
  const label = (value: string) =>
    db
      .prepare(
        `INSERT INTO claim_labels (access_rule_id, claim, value, label, updated_at)
         VALUES ('acr_1', 'repository_id', ?, 'acme/api', ?)`,
      )
      .bind(value, T);

  // The shape of an ID is the profile's (ADR 0028): the table takes digits and prefixed opaque IDs.
  it.each(['1234567', '123456789012345678901', 'prj_7Gw5ZMBpQA8h9GF832KGp7nwbuh3'])(
    'accepts the ID %j',
    async (value) => {
      await label(value).run();
      expect(await rows(`SELECT value FROM claim_labels WHERE value = '${value}'`)).toEqual([
        { value },
      ]);
      await db.prepare('DELETE FROM claim_labels').run();
    },
  );

  it.each(['', '-1', '12 3', 'acme/api', 'x'.repeat(129)])(
    'refuses the value %j',
    async (value) => {
      expect(await refused(label(value))).toMatch(/CHECK constraint/);
    },
  );

  it('takes any claim of a profile and refuses an empty one or unknown access rules', async () => {
    await db
      .prepare(
        `INSERT INTO claim_labels (access_rule_id, claim, value, label, updated_at)
         VALUES ('acr_1', 'owner_id', 'team_1', 'acme', ?)`,
      )
      .bind(T)
      .run();
    expect(
      await refused(
        db
          .prepare(
            `INSERT INTO claim_labels (access_rule_id, claim, value, label, updated_at)
             VALUES ('acr_1', '', '1', 'x', ?)`,
          )
          .bind(T),
      ),
    ).toMatch(/CHECK constraint/);
    expect(
      await refused(
        db
          .prepare(
            `INSERT INTO claim_labels (access_rule_id, claim, value, label, updated_at)
             VALUES ('acr_missing', 'repository_id', '1', 'x', ?)`,
          )
          .bind(T),
      ),
    ).toMatch(/FOREIGN KEY constraint/);
  });
});
