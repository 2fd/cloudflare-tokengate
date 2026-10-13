// Audit log page end to end: listing, filters, keyset pagination, diff rendering, escaping, RBAC.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { auditStatement, buildAuditEvent, SYSTEM_ACTOR } from '../../src/db/audit';
import type { Actor, User } from '../../src/db/types';
import {
  type AdminSession,
  adminGet,
  adminPost,
  createUser,
  loginAs,
  resetControlPlane,
} from '../helpers/admin-auth';
import { createTestApp, type TestApp } from '../helpers/app';
import { createClock, TEST_EPOCH_MS } from '../helpers/jwt';

const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));

let clock: ReturnType<typeof createClock>;
let app: TestApp;
let owner: User;
let session: AdminSession;

function actorFor(user: User): Actor {
  return { type: 'user', id: user.id, email: user.email, ip: '203.0.113.9', userAgent: 'test-ua' };
}

/** Inserts one audit event at the current clock time and advances the clock. */
async function audit(actor: Actor, input: Parameters<typeof buildAuditEvent>[2]): Promise<string> {
  const event = buildAuditEvent({ now: clock.now, random }, actor, input);
  await auditStatement(env.DB, event).run();
  clock.advance(1000);
  return event.id;
}

function eventIds(html: string): string[] {
  return [...html.matchAll(/Event <code>(aud_[0-9A-Z]{26})<\/code>/g)].map((m) => m[1] ?? '');
}

beforeEach(async () => {
  await resetControlPlane();
  clock = createClock(TEST_EPOCH_MS);
  app = createTestApp({ now: clock.now });
  owner = await createUser({ email: 'owner@example.com', role: 'owner' });
  const viewer = await createUser({ email: 'viewer@example.com', role: 'viewer' });
  session = await loginAs(app, viewer);
  // Only the events created by each test.
  await env.DB.prepare('DELETE FROM audit_log').run();
});

describe('GET /admin/audit', () => {
  it('lists events newest first with before/after JSON for a viewer', async () => {
    const created = await audit(actorFor(owner), {
      action: 'service.create',
      targetType: 'service',
      targetId: 'svc_01JAAAAAAAAAAAAAAAAAAAAAAA',
      summary: 'Created service slack',
      diff: { after: { slug: 'slack', credential_sealed: 'sealed-bytes' } },
    });
    const updated = await audit(actorFor(owner), {
      action: 'grant.update',
      targetType: 'grant',
      targetId: 'grt_01JAAAAAAAAAAAAAAAAAAAAAAA',
      summary: 'Updated grant deploy',
      diff: { before: { name: 'old' }, after: { name: 'new' }, warnings: ['check me'] },
    });
    const system = await audit(SYSTEM_ACTOR, {
      action: 'credential.expiring',
      targetType: 'service',
      targetId: 'svc_01JAAAAAAAAAAAAAAAAAAAAAAA',
      summary: 'Credential of slack expires in 3 days',
    });

    const res = await adminGet(app, session, '/admin/audit');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(eventIds(html)).toEqual([system, updated, created]);
    expect(html).toContain('<span class="muted">system</span>');
    expect(html).toContain('<b>Before</b>');
    expect(html).toContain('&quot;name&quot;: &quot;old&quot;');
    expect(html).toContain('&quot;warnings&quot;');
    expect(html).toContain('href="/admin/services/svc_01JAAAAAAAAAAAAAAAAAAAAAAA"');
    expect(html).toContain('href="/admin/grants/grt_01JAAAAAAAAAAAAAAAAAAAAAAA"');
    // Redacted at write time; the page never sees the value.
    expect(html).not.toContain('sealed-bytes');
    expect(html).toContain('[redacted]');
  });

  it('filters by target and actor', async () => {
    const other = await createUser({ email: 'admin@example.com', role: 'admin' });
    const a = await audit(actorFor(owner), {
      action: 'service.create',
      targetType: 'service',
      targetId: 'svc_A',
      summary: 'a',
    });
    const b = await audit(actorFor(other), {
      action: 'service.update',
      targetType: 'service',
      targetId: 'svc_B',
      summary: 'b',
    });
    const c = await audit(actorFor(other), {
      action: 'grant.create',
      targetType: 'grant',
      targetId: 'grt_C',
      summary: 'c',
    });
    const get = async (query: string) =>
      eventIds(await (await adminGet(app, session, `/admin/audit?${query}`)).text());
    expect(await get('target_type=service')).toEqual([b, a]);
    expect(await get('target_type=service&target_id=svc_A')).toEqual([a]);
    expect(await get('actor=admin%40example.com')).toEqual([c, b]);
    expect(await get(`actor=${owner.id}`)).toEqual([a]);
    expect(await get('target_type=user')).toEqual([]);
  });

  it('paginates with an "Older entries" link that keeps the filters', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 53; i++) {
      ids.push(
        await audit(actorFor(owner), {
          action: 'grant.update',
          targetType: 'grant',
          targetId: 'grt_X',
          summary: `change ${i}`,
        }),
      );
    }
    const newest = [...ids].reverse();
    const first = await (await adminGet(app, session, '/admin/audit?target_type=grant')).text();
    expect(eventIds(first)).toEqual(newest.slice(0, 50));
    const older = first.match(/href="(\/admin\/audit\?[^"]*before=[^"]*)"/)?.[1];
    expect(older).toBeDefined();
    const second = await (
      await adminGet(app, session, (older ?? '').replaceAll('&amp;', '&'))
    ).text();
    expect(eventIds(second)).toEqual(newest.slice(50));
    expect(second).not.toContain('Older entries');
  });

  it('answers 400 for invalid filters without listing events', async () => {
    await audit(actorFor(owner), { action: 'x', targetType: null, targetId: null, summary: 's' });
    for (const query of ['before=aud_bad', 'target_type=%3Cscript%3E']) {
      const res = await adminGet(app, session, `/admin/audit?${query}`);
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain('class="banner error"');
      expect(eventIds(html)).toEqual([]);
    }
  });

  it('shows a helpful empty state', async () => {
    const html = await (await adminGet(app, session, '/admin/audit')).text();
    expect(html).toContain('No audit events yet');
    const filtered = await (await adminGet(app, session, '/admin/audit?actor=nobody')).text();
    expect(filtered).toContain('No audit events match these filters');
  });

  it('escapes stored text (XSS)', async () => {
    const hostile = '<script>alert(1)</script>';
    await audit(
      { type: 'user', id: 'usr_x', email: hostile, ip: hostile, userAgent: hostile },
      {
        action: hostile,
        targetType: 'grant',
        targetId: hostile,
        summary: hostile,
        diff: { after: { name: hostile } },
      },
    );
    const html = await (await adminGet(app, session, '/admin/audit')).text();
    expect(html).not.toContain(hostile);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('is read-only: POST is refused for a viewer', async () => {
    const res = await adminPost(app, session, '/admin/audit', {});
    expect(res.status).toBe(403);
  });
});

describe('GET /admin/audit filter handling', () => {
  it('matches the actor email case-insensitively', async () => {
    const id = await audit(actorFor(owner), {
      action: 'service.create',
      targetType: 'service',
      targetId: 'svc_A',
      summary: 'a',
    });
    const html = await (
      await adminGet(app, session, '/admin/audit?actor=Owner%40Example.com')
    ).text();
    expect(eventIds(html)).toEqual([id]);
  });

  it('never turns an invalid target type into an option label', async () => {
    const spoof = 'Your session expired';
    const res = await adminGet(
      app,
      session,
      `/admin/audit?target_type=${encodeURIComponent(spoof)}`,
    );
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain(`>${spoof}<`);
  });
});
