import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { resolveLogin } from '../../src/admin/auth/resolve-login';
import { putSettingStatement } from '../../src/db/settings';
import { createAdminTestApp, createUser, resetControlPlane } from '../helpers/admin-auth';

beforeEach(resetControlPlane);

const BOOTSTRAP = 'first@acme.com, second@acme.com';

function deps(bootstrapEmails = BOOTSTRAP) {
  return createAdminTestApp({ env: { BOOTSTRAP_OWNER_EMAILS: bootstrapEmails } }).deps;
}

async function owners(): Promise<string[]> {
  const { results } = await env.DB.prepare("SELECT email FROM users WHERE role = 'owner'").all<{
    email: string;
  }>();
  return results.map((row) => row.email);
}

describe('I-BOOT-1: bootstrap creates at most one owner, once', () => {
  it('creates an active owner with identity, marker and audit row', async () => {
    const result = await resolveLogin(deps(), {
      loginProvider: 'access',
      subject: '1',
      emails: ['first@acme.com'],
      name: 'First',
    });
    expect(result).toMatchObject({
      ok: true,
      via: 'bootstrap',
      user: { role: 'owner', status: 'active' },
    });
    expect(await owners()).toEqual(['first@acme.com']);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM user_identities').first('n')).toBe(1);
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM settings WHERE key = 'bootstrap_completed_at'",
      ).first('n'),
    ).toBe(1);
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM audit_log WHERE action = 'user.bootstrap'",
      ).first('n'),
    ).toBe(1);
  });

  it('two concurrent bootstraps yield exactly one owner', async () => {
    const d = deps();
    const results = await Promise.all([
      resolveLogin(d, {
        loginProvider: 'access',
        subject: '1',
        emails: ['first@acme.com'],
        name: null,
      }),
      resolveLogin(d, {
        loginProvider: 'dev',
        subject: 'x|2',
        emails: ['second@acme.com'],
        name: null,
      }),
      resolveLogin(d, {
        loginProvider: 'access',
        subject: '3',
        emails: ['first@acme.com'],
        name: null,
      }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(await owners()).toHaveLength(1);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM users').first('n')).toBe(1);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM user_identities').first('n')).toBe(1);
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM audit_log WHERE action = 'user.bootstrap'",
      ).first('n'),
    ).toBe(1);
  });

  it('is ignored once an owner exists', async () => {
    await createUser({ email: 'existing@acme.com', role: 'owner' });
    const result = await resolveLogin(deps(), {
      loginProvider: 'access',
      subject: '1',
      emails: ['first@acme.com'],
      name: null,
    });
    expect(result).toEqual({ ok: false, reason: 'not_invited' });
    expect(await owners()).toEqual(['existing@acme.com']);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM audit_log').first('n')).toBe(0);
  });

  it('is ignored once bootstrap_completed_at is set, even with no owner left', async () => {
    await putSettingStatement(env.DB, 'bootstrap_completed_at', 1, 1, null).run();
    const result = await resolveLogin(deps(), {
      loginProvider: 'access',
      subject: '1',
      emails: ['first@acme.com'],
      name: null,
    });
    expect(result).toEqual({ ok: false, reason: 'not_invited' });
    expect(await env.DB.prepare('SELECT count(*) AS n FROM users').first('n')).toBe(0);
  });

  it('requires an authoritative email listed in BOOTSTRAP_OWNER_EMAILS', async () => {
    const result = await resolveLogin(deps(), {
      loginProvider: 'access',
      subject: '1',
      emails: ['someone@acme.com'],
      name: null,
    });
    expect(result).toEqual({ ok: false, reason: 'not_invited' });
    const none = await resolveLogin(deps(''), {
      loginProvider: 'access',
      subject: '1',
      emails: ['first@acme.com'],
      name: null,
    });
    expect(none).toEqual({ ok: false, reason: 'not_invited' });
    expect(await env.DB.prepare('SELECT count(*) AS n FROM users').first('n')).toBe(0);
  });

  it('a second login of the bootstrapped owner resolves by identity', async () => {
    const d = deps();
    await resolveLogin(d, {
      loginProvider: 'access',
      subject: '1',
      emails: ['first@acme.com'],
      name: null,
    });
    const again = await resolveLogin(d, {
      loginProvider: 'access',
      subject: '1',
      emails: ['first@acme.com'],
      name: null,
    });
    expect(again).toMatchObject({ ok: true, via: 'identity' });
  });
});
