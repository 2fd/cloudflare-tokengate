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

async function auditActions(): Promise<string[]> {
  const { results } = await env.DB.prepare('SELECT action FROM audit_log ORDER BY action').all<{
    action: string;
  }>();
  return results.map((row) => row.action);
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
    // One owner; the other email joins as viewer; the second identity for the owner's email is refused.
    expect(results.filter((result) => result.ok)).toHaveLength(2);
    expect(await owners()).toHaveLength(1);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM users').first('n')).toBe(2);
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM users WHERE role = 'viewer'").first('n'),
    ).toBe(1);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM user_identities').first('n')).toBe(2);
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM audit_log WHERE action = 'user.bootstrap'",
      ).first('n'),
    ).toBe(1);
  });

  it('is ignored once an owner exists: the next person joins as viewer', async () => {
    await createUser({ email: 'existing@acme.com', role: 'owner' });
    const result = await resolveLogin(deps(), {
      loginProvider: 'access',
      subject: '1',
      emails: ['first@acme.com'],
      name: null,
    });
    expect(result).toMatchObject({ ok: true, via: 'join', user: { role: 'viewer' } });
    expect(await owners()).toEqual(['existing@acme.com']);
    expect(await auditActions()).toEqual(['user.join']);
  });

  it('is ignored once bootstrap_completed_at is set, even with no owner left', async () => {
    await putSettingStatement(env.DB, 'bootstrap_completed_at', 1, 1, null).run();
    const result = await resolveLogin(deps(), {
      loginProvider: 'access',
      subject: '1',
      emails: ['first@acme.com'],
      name: null,
    });
    expect(result).toMatchObject({ ok: true, via: 'join', user: { role: 'viewer' } });
    expect(await owners()).toEqual([]);
  });

  it('with BOOTSTRAP_OWNER_EMAILS set, an unlisted first person joins as viewer', async () => {
    const result = await resolveLogin(deps(), {
      loginProvider: 'access',
      subject: '1',
      emails: ['someone@acme.com'],
      name: null,
    });
    expect(result).toMatchObject({ ok: true, via: 'join', user: { role: 'viewer' } });
    expect(await owners()).toEqual([]);
    // A listed person can still become the first owner afterwards.
    const listed = await resolveLogin(deps(), {
      loginProvider: 'access',
      subject: '2',
      emails: ['second@acme.com'],
      name: null,
    });
    expect(listed).toMatchObject({ ok: true, via: 'bootstrap' });
  });

  it('without BOOTSTRAP_OWNER_EMAILS, the first person to sign in becomes owner', async () => {
    const first = await resolveLogin(deps(''), {
      loginProvider: 'access',
      subject: '1',
      emails: ['anyone@acme.com'],
      name: null,
    });
    expect(first).toMatchObject({ ok: true, via: 'bootstrap', user: { role: 'owner' } });
    const second = await resolveLogin(deps(''), {
      loginProvider: 'access',
      subject: '2',
      emails: ['next@acme.com'],
      name: null,
    });
    expect(second).toMatchObject({ ok: true, via: 'join', user: { role: 'viewer' } });
    expect(await owners()).toEqual(['anyone@acme.com']);
  });

  it('never bootstraps over an existing user with the same email', async () => {
    await createUser({ email: 'first@acme.com', role: 'viewer', status: 'disabled' });
    const result = await resolveLogin(deps(''), {
      loginProvider: 'access',
      subject: '1',
      emails: ['first@acme.com'],
      name: null,
    });
    expect(result).toEqual({ ok: false, reason: 'email_taken' });
    expect(await owners()).toEqual([]);
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
