// Audit log page end to end: listing, link-tab and select filters, keyset pagination both ways,
// the diff table, escaping, the category map and RBAC.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { AUDIT_CATEGORIES, auditCategoriesOf } from '../../src/admin/routes/audit';
import { AUDIT_ACTION_TEXT } from '../../src/admin/views/monitoring';
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
const SVC_A = 'svc_01JAAAAAAAAAAAAAAAAAAAAAAA';
const SVC_B = 'svc_01JBBBBBBBBBBBBBBBBBBBBBBB';
const GRT_C = 'grt_01JCCCCCCCCCCCCCCCCCCCCCCC';

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
  it('lists events newest first with a diff table for a viewer', async () => {
    const created = await audit(actorFor(owner), {
      action: 'service.create',
      targetType: 'service',
      targetId: SVC_A,
      summary: 'Created service slack',
      diff: { after: { slug: 'slack', credential_sealed: 'sealed-bytes' } },
    });
    const updated = await audit(actorFor(owner), {
      action: 'grant.update',
      targetType: 'grant',
      targetId: GRT_C,
      summary: 'Updated grant deploy',
      diff: {
        before: { name: 'old', rules: [1] },
        after: { name: 'new', rules: [1] },
        warnings: ['check me'],
      },
    });
    const system = await audit(SYSTEM_ACTOR, {
      action: 'credential.expiring',
      targetType: 'service',
      targetId: SVC_A,
      summary: 'Credential of slack expires in 3 days',
    });

    const res = await adminGet(app, session, '/admin/audit');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(eventIds(html)).toEqual([system, updated, created]);
    expect(html).toContain('System (hourly job)');
    expect(html).toContain('<th scope="col">Before</th>');
    // Each diff table has its own name: the object and the time.
    const captions = [...html.matchAll(/<table class="diff"><caption class="vh">([^<]*)</g)].map(
      (m) => m[1],
    );
    expect(captions.length).toBeGreaterThan(1);
    expect(new Set(captions).size).toBe(captions.length);
    expect(captions.every((c) => c?.startsWith('Changed fields of '))).toBe(true);
    // Changed keys only: `rules` did not change. Old value struck, new value inserted.
    expect(html).toContain('Changes: name<span class="vh">');
    expect(html).toContain(
      '<td><del><code>old</code></del></td><td><ins><code>new</code></ins></td>',
    );
    // The feed groups events by UTC day.
    expect(html).toContain('<h3 class="day">Today, ');
    expect(html).toContain('&quot;warnings&quot;');
    expect(html).toContain('secret expires soon');
    // Deleted (unknown) entities are named as such, with a History link.
    expect(html).toContain(`deleted token <code>${SVC_A}</code>`);
    expect(html).toContain(`href="/admin/audit?target=${SVC_A}"`);
    // Redacted at write time; the page never sees the value.
    expect(html).not.toContain('sealed-bytes');
    expect(html).toContain('[redacted]');
  });

  it('links targets that exist to their page by name', async () => {
    await env.DB.prepare(
      `INSERT INTO services (id, slug, name, base_url, injection, created_at, updated_at)
       VALUES (?, 'slack', 'Slack bot', 'https://slack.com/api', '{"kind":"bearer"}', 0, 0)`,
    )
      .bind(SVC_A)
      .run();
    await audit(actorFor(owner), {
      action: 'service.update',
      targetType: 'service',
      targetId: SVC_A,
      summary: 'Updated',
    });
    // One event and no filter: the filter form stays hidden (A7.1).
    const plain = await (await adminGet(app, session, '/admin/audit')).text();
    expect(plain).not.toContain('aria-label="Filter audit log"');
    // Any active filter shows it, with every target in the "+ Target" menu, keeping the range.
    const html = await (await adminGet(app, session, '/admin/audit?range=24h')).text();
    expect(html).toContain('aria-label="Filter audit log"');
    expect(html).toContain(`<a href="/admin/tokens/${SVC_A}">Slack bot</a>`);
    expect(html).toContain(
      `<a href="/admin/audit?range=24h&amp;target=${SVC_A}">Slack bot <span class="slug">token</span></a>`,
    );
  });

  it('filters by target and actor', async () => {
    const other = await createUser({ email: 'admin@example.com', role: 'admin' });
    const a = await audit(actorFor(owner), {
      action: 'service.create',
      targetType: 'service',
      targetId: SVC_A,
      summary: 'a',
    });
    const b = await audit(actorFor(other), {
      action: 'service.update',
      targetType: 'service',
      targetId: SVC_B,
      summary: 'b',
    });
    const c = await audit(actorFor(other), {
      action: 'grant.create',
      targetType: 'grant',
      targetId: GRT_C,
      summary: 'c',
    });
    const s = await audit(SYSTEM_ACTOR, {
      action: 'settings.update',
      targetType: 'settings',
      targetId: null,
      summary: 's',
    });
    const get = async (query: string) =>
      eventIds(await (await adminGet(app, session, `/admin/audit?${query}`)).text());
    expect(await get(`target=${SVC_A}`)).toEqual([a]);
    expect(await get('target=settings')).toEqual([s]);
    expect(await get('actor=admin%40example.com')).toEqual([c, b]);
    expect(await get(`actor=${owner.id}`)).toEqual([a]);
    expect(await get('actor=system')).toEqual([s]);
  });

  it('filters by category through the action index', async () => {
    const t = await audit(actorFor(owner), {
      action: 'service.credential.set',
      targetType: 'service',
      targetId: SVC_A,
      summary: 't',
    });
    const h = await audit(actorFor(owner), {
      action: 'settings.upstream_hosts',
      targetType: 'settings',
      targetId: null,
      summary: 'h',
    });
    const g = await audit(actorFor(owner), {
      action: 'grant.create',
      targetType: 'grant',
      targetId: GRT_C,
      summary: 'g',
    });
    const get = async (query: string) =>
      eventIds(await (await adminGet(app, session, `/admin/audit?${query}`)).text());
    expect(await get('category=tokens')).toEqual([h, t]);
    expect(await get('category=access')).toEqual([g]);
    expect(await get('category=users')).toEqual([]);
    const { results } = await env.DB.prepare(
      "EXPLAIN QUERY PLAN SELECT * FROM audit_log WHERE ((action >= 'service.' AND action < 'service/')) ORDER BY id DESC LIMIT 51",
    ).all<{ detail: string }>();
    expect(results.map((row) => row.detail).join('\n')).toContain('audit_log_action');
  });

  it('paginates both ways, keeping the filters', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 53; i++) {
      ids.push(
        await audit(actorFor(owner), {
          action: 'grant.update',
          targetType: 'grant',
          targetId: GRT_C,
          summary: `change ${i}`,
        }),
      );
    }
    const newest = [...ids].reverse();
    const first = await (await adminGet(app, session, `/admin/audit?target=${GRT_C}`)).text();
    expect(eventIds(first)).toEqual(newest.slice(0, 50));
    const older = first.match(/href="(\/admin\/audit\?[^"]*before=[^"]*)"/)?.[1];
    expect(older).toContain(`target=${GRT_C}`);
    const second = await (
      await adminGet(app, session, (older ?? '').replaceAll('&amp;', '&'))
    ).text();
    expect(eventIds(second)).toEqual(newest.slice(50));
    // The last page has no Older link (the pager shows the word as plain faint text).
    expect(second).not.toMatch(/<a [^>]*rel="next"/);
    const newer = second.match(/href="(\/admin\/audit\?[^"]*after=[^"]*)"/)?.[1];
    const back = await (
      await adminGet(app, session, (newer ?? '').replaceAll('&amp;', '&'))
    ).text();
    expect(eventIds(back)).toEqual(newest.slice(0, 50));
  });

  it('answers 400 for invalid filters, drops them and still lists events', async () => {
    const id = await audit(actorFor(owner), {
      action: 'x',
      targetType: null,
      targetId: null,
      summary: 's',
    });
    for (const query of [
      'before=aud_bad',
      'target=%3Cscript%3E',
      'actor=nobody',
      'category=bogus',
    ]) {
      const res = await adminGet(app, session, `/admin/audit?${query}`);
      expect(res.status, query).toBe(400);
      const html = await res.text();
      expect(html).toContain('class="callout bad errsum"');
      expect(eventIds(html)).toEqual([id]);
      expect(html).not.toContain('<script>');
    }
    const html = await (await adminGet(app, session, '/admin/audit?actor=nobody')).text();
    // The summary links the "+ Who" menu, rendered open, with the error after the menus.
    expect(html).toContain('<a href="#f-actor">Choose a person from the list.</a>');
    expect(html).toContain('<details class="fadd" id="f-actor" open="">');
    expect(html).toContain('<p class="field-error" id="f-actor-error">');
  });

  it('shows a helpful empty state', async () => {
    const html = await (await adminGet(app, session, '/admin/audit')).text();
    expect(html).toContain('No audit events yet');
    const filtered = await (await adminGet(app, session, '/admin/audit?category=tokens')).text();
    expect(filtered).toContain('No audit events match these filters');
  });

  it('labels suspended users in the actor list and in the table', async () => {
    const gone = await createUser({
      email: 'gone@example.com',
      role: 'admin',
      status: 'suspended',
    });
    await audit(actorFor(gone), {
      action: 'grant.create',
      targetType: 'grant',
      targetId: GRT_C,
      summary: 'x',
    });
    const html = await (await adminGet(app, session, '/admin/audit?range=24h')).text();
    expect(html).toContain(
      `<a href="/admin/audit?range=24h&amp;actor=${gone.id}"><span class="avatar" aria-hidden="true">G</span>gone@example.com (suspended)</a>`,
    );
    expect(html).toContain('gone@example.com (suspended)<span class="vh">');
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
  it('matches the actor email case-insensitively through users', async () => {
    const id = await audit(actorFor(owner), {
      action: 'service.create',
      targetType: 'service',
      targetId: SVC_A,
      summary: 'a',
    });
    const html = await (
      await adminGet(app, session, '/admin/audit?actor=Owner%40Example.com')
    ).text();
    expect(eventIds(html)).toEqual([id]);
  });

  it('never turns an invalid target into an option label', async () => {
    const spoof = 'Your session expired';
    const res = await adminGet(app, session, `/admin/audit?target=${encodeURIComponent(spoof)}`);
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain(`>${spoof}<`);
  });

  it('gives a well-formed id of a deleted object its own chip label, and nothing else', async () => {
    const html = await (await adminGet(app, session, `/admin/audit?target=${SVC_B}`)).text();
    expect(html).toContain(
      `<a class="achip" href="/admin/audit"><span class="vh">Remove filter </span>Target: Deleted token ${SVC_B}<span class="x" aria-hidden="true">✕</span></a>`,
    );
  });
});

describe('AUDIT_CATEGORIES', () => {
  // Every audit action the ops, the routes and the cron write (string literals in src/).
  const sources = import.meta.glob<string>(['../../src/**/*.ts', '../../src/**/*.tsx'], {
    query: '?raw',
    import: 'default',
    eager: true,
  });
  const emitted = new Set<string>();
  for (const [file, text] of Object.entries(sources)) {
    if (file.includes('/admin/views/') || file.endsWith('/routes/audit.tsx')) continue;
    for (const match of text.matchAll(
      /\baction: (?:[a-z]+ \? )?'((?:service|grant|caller_provider|user|settings|keyring|credential|config)\.[a-z_.]+)'(?: : '([a-z_.]+)')?/g,
    )) {
      emitted.add(match[1] as string);
      if (match[2]) emitted.add(match[2]);
    }
  }

  it('finds the emitted actions', () => {
    expect(emitted.size).toBeGreaterThan(25);
    expect(emitted).toContain('grant.enable');
    expect(emitted).toContain('grant.disable');
  });

  it('maps every emitted action to exactly one category, and every action has a text', () => {
    for (const action of emitted) {
      expect(auditCategoriesOf(action), action).toHaveLength(1);
      expect(Object.hasOwn(AUDIT_ACTION_TEXT, action), action).toBe(true);
    }
  });

  it('maps every action of the text table to exactly one category', () => {
    for (const action of Object.keys(AUDIT_ACTION_TEXT)) {
      expect(auditCategoriesOf(action), action).toHaveLength(1);
    }
    expect(Object.keys(AUDIT_CATEGORIES)).toEqual([
      'tokens',
      'consumers',
      'access',
      'users',
      'signins',
      'system',
    ]);
  });
});
