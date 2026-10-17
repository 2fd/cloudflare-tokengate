// Sealed credential drafts (A13.6, ADR 0020): a re-rendered form carries the secret sealed, never
// in plaintext (I-CRED-1), bound to the user and login, the target and the destination (I-CRED-2),
// valid for 15 minutes and never renewed. A draft never opens as a stored credential or the reverse.
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CREDENTIAL_DRAFT_TTL_MS,
  type CredentialDraftContext,
  openCredentialDraft,
  sealCredentialDraft,
} from '../../src/admin/ops/credential-draft';
import { fromBase64Url, toBase64Url, utf8 } from '../../src/lib/encoding';
import { adminPost, createUser, loginAs, resetControlPlane } from '../helpers/admin-auth';
import { createTestApp, type TestApp } from '../helpers/app';
import {
  dumpControlPlane,
  fakeNetwork,
  KEK_1,
  opsDeps,
  seedService,
} from '../unit/admin/ops/helpers';

const SECRET = 'sk-proj-draftSecret0123456789abcdWXYZ';

const CONTEXT: CredentialDraftContext = {
  userId: 'usr_01JDRAFT00000000000000000',
  loginProvider: 'access',
  subject: 'team|alice',
  target: 'new',
  baseUrl: 'https://api.openai.com/v1',
  injectionJson: '{"kind":"bearer"}',
};

/** Upstream that refuses every secret, so every create is a 422 re-render with a draft. */
function refusingNetwork() {
  return fakeNetwork(() => Response.json({ error: 'invalid' }, { status: 401 }));
}

const draftOf = (html: string) => /name="credential_draft" value="([^"]+)"/.exec(html)?.[1] ?? null;

let consoleLines: string[];

beforeEach(async () => {
  await resetControlPlane();
  consoleLines = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      consoleLines.push(args.map(String).join(' '));
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('I-CRED-1 and I-CRED-2: credential drafts', () => {
  it('opens for the same user, login, target and destination within 15 minutes', async () => {
    const deps = opsDeps();
    const draft = await sealCredentialDraft(deps, CONTEXT, SECRET);
    expect(draft).toMatch(/^cd1\.\d+\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
    expect(draft).not.toContain(SECRET);
    expect(await openCredentialDraft(deps, CONTEXT, draft ?? '')).toEqual({
      ok: true,
      credential: SECRET,
    });
  });

  it.each([
    ['base URL', { baseUrl: 'https://api.openai.com/v2' }],
    ['injection', { injectionJson: '{"kind":"header","name":"x-api-key"}' }],
  ])('a changed %s is refused as a destination change', async (_, change) => {
    const deps = opsDeps();
    const draft = (await sealCredentialDraft(deps, CONTEXT, SECRET)) ?? '';
    expect(await openCredentialDraft(deps, { ...CONTEXT, ...change }, draft)).toEqual({
      ok: false,
      reason: 'mismatch',
    });
  });

  it.each([
    ['another user', { userId: 'usr_01JOTHER00000000000000000' }],
    ['another login subject', { subject: 'team|mallory' }],
    ['another login provider', { loginProvider: 'dev' }],
    ['another target', { target: 'svc_01JOTHER00000000000000000' }],
  ])('a draft of %s is refused', async (_, change) => {
    const deps = opsDeps();
    const draft = (await sealCredentialDraft(deps, CONTEXT, SECRET)) ?? '';
    expect(await openCredentialDraft(deps, { ...CONTEXT, ...change }, draft)).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('an expired draft is refused (no renewal by the clock)', async () => {
    const t0 = Date.UTC(2026, 9, 15, 12);
    const draft = (await sealCredentialDraft(opsDeps({ now: () => t0 }), CONTEXT, SECRET)) ?? '';
    const later = opsDeps({ now: () => t0 + CREDENTIAL_DRAFT_TTL_MS });
    expect(await openCredentialDraft(later, CONTEXT, draft)).toEqual({
      ok: false,
      reason: 'expired',
    });
    const almost = opsDeps({ now: () => t0 + CREDENTIAL_DRAFT_TTL_MS - 1 });
    expect((await openCredentialDraft(almost, CONTEXT, draft)).ok).toBe(true);
  });

  it('a tampered draft or a tampered expiry is refused', async () => {
    const deps = opsDeps();
    const draft = (await sealCredentialDraft(deps, CONTEXT, SECRET)) ?? '';
    const [version, expires, fingerprint, sealed] = draft.split('.') as [
      string,
      string,
      string,
      string,
    ];
    const longer = `${version}.${Number(expires) + 3_600_000}.${fingerprint}.${sealed}`;
    expect(await openCredentialDraft(deps, CONTEXT, longer)).toEqual({
      ok: false,
      reason: 'invalid',
    });
    const json = JSON.parse(new TextDecoder().decode(fromBase64Url(sealed))) as Record<
      string,
      string
    >;
    const flipped = { ...json, ct: `${json.ct?.slice(0, -2)}AA` };
    const tampered = `${version}.${expires}.${fingerprint}.${toBase64Url(utf8(JSON.stringify(flipped)))}`;
    expect(await openCredentialDraft(deps, CONTEXT, tampered)).toEqual({
      ok: false,
      reason: 'invalid',
    });
    for (const junk of [
      '',
      'cd1',
      'cd1.x.y.z',
      `cd2.${expires}.${fingerprint}.${sealed}`,
      'a'.repeat(20_000),
    ]) {
      expect((await openCredentialDraft(deps, CONTEXT, junk)).ok).toBe(false);
    }
  });

  it('a stored sealed credential pasted as a draft is refused (domain separation)', async () => {
    const deps = opsDeps();
    const id = await seedService(deps, {
      slug: 'openai',
      base_url: CONTEXT.baseUrl,
      secret: SECRET,
    });
    const stored = await env.DB.prepare('SELECT credential_sealed FROM credentials WHERE id = ?')
      .bind(id)
      .first<string>('credential_sealed');
    const context = { ...CONTEXT, target: id };
    const shell = ((await sealCredentialDraft(deps, context, 'x')) ?? '').split('.');
    const forged = `${shell[0]}.${shell[1]}.${shell[2]}.${toBase64Url(utf8(stored ?? ''))}`;
    expect(await openCredentialDraft(deps, context, forged)).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('without a keyring there is no draft', async () => {
    const deps = opsDeps({ env: { TOKENGATE_KEK: '' } });
    expect(await sealCredentialDraft(deps, CONTEXT, SECRET)).toBeNull();
  });
});

describe('I-CRED-1 and I-CRED-2: credential drafts in the token forms', () => {
  let app: TestApp;
  let network: ReturnType<typeof fakeNetwork>;

  beforeEach(() => {
    network = refusingNetwork();
    app = createTestApp({ fetch: network.fetch, env: { TOKENGATE_KEK: KEK_1 } });
  });

  async function owner() {
    return loginAs(app, await createUser({ email: 'o@example.com', role: 'owner' }));
  }

  it('a failed check keeps the draft; a re-render that used it echoes the same string; save_anyway saves', async () => {
    const session = await owner();
    const first = await adminPost(app, session, '/admin/credentials', {
      template: 'openai',
      credential: SECRET,
    });
    expect(first.status).toBe(422);
    const html = await first.text();
    expect(html).not.toContain(SECRET);
    expect(html).toContain(`Secret kept for 15 minutes (…WXYZ, ${SECRET.length} characters).`);
    // The secret field is no longer required: leaving it empty uses the draft.
    // A secret input never renders a value (the draft is not echoed into the field).
    const field = /<input [^>]*id="f-openai-credential"[^>]*>/.exec(html)?.[0] ?? '';
    expect(field).toContain('name="credential" type="password"');
    expect(field).not.toContain('required');
    expect(field).not.toContain('value=');
    const draft = draftOf(html);
    expect(draft).not.toBeNull();

    const again = await adminPost(app, session, '/admin/credentials', {
      template: 'openai',
      credential_draft: draft ?? '',
    });
    expect(again.status).toBe(422);
    expect(draftOf(await again.text())).toBe(draft);

    const saved = await adminPost(app, session, '/admin/credentials', {
      template: 'openai',
      credential_draft: draft ?? '',
      save_anyway: '1',
    });
    expect(saved.status).toBe(303);
    expect(
      await env.DB.prepare("SELECT credential_hint FROM credentials WHERE slug = 'openai'").first(
        'credential_hint',
      ),
    ).toBe(`…WXYZ (${SECRET.length} chars)`);
  });

  it('the draft hint of username:password shows only the password length, never its characters', async () => {
    const session = await owner();
    for (const [secret, length] of [
      ['ci-service-account-name:pw12', 4],
      // Stripe-style: the secret is the user part and the password is empty.
      ['sk_test_short:', 13],
    ] as const) {
      const res = await adminPost(app, session, '/admin/credentials', {
        template: 'custom',
        base_url: 'https://api.basic.example',
        injection_kind: 'basic',
        verify_path: '/check',
        credential: secret,
      });
      expect(res.status, secret).toBe(422);
      const html = await res.text();
      expect(html, secret).toContain(`Secret kept for 15 minutes (${length} characters).`);
      const tail = secret.replace(/:$/, '').slice(-4);
      expect(html, secret).not.toContain(`…${tail}`);
      expect(html, secret).not.toContain(secret);
      expect(draftOf(html), secret).not.toBeNull();
    }
  });

  it('a typed secret wins over a draft', async () => {
    const session = await owner();
    const first = await adminPost(app, session, '/admin/credentials', {
      template: 'openai',
      credential: SECRET,
    });
    const draft = draftOf(await first.text()) ?? '';
    const other = 'sk-proj-typedWins0123456789abcdefABCD';
    await adminPost(app, session, '/admin/credentials', {
      template: 'openai',
      credential: other,
      credential_draft: draft,
      save_anyway: '1',
    });
    expect(
      await env.DB.prepare("SELECT credential_hint FROM credentials WHERE slug = 'openai'").first(
        'credential_hint',
      ),
    ).toBe(`…ABCD (${other.length} chars)`);
  });

  it("another user's draft is refused with a field error", async () => {
    const session = await owner();
    const draft = draftOf(
      await (
        await adminPost(app, session, '/admin/credentials', {
          template: 'openai',
          credential: SECRET,
        })
      ).text(),
    );
    const other = await loginAs(app, await createUser({ email: 'b@example.com', role: 'admin' }));
    const res = await adminPost(app, other, '/admin/credentials', {
      template: 'openai',
      credential_draft: draft ?? '',
      save_anyway: '1',
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('Enter the API key again');
    expect(await env.DB.prepare('SELECT count(*) AS n FROM credentials').first('n')).toBe(0);
  });

  it('a draft made in one card does not open in another (other destination)', async () => {
    const session = await owner();
    const draft = draftOf(
      await (
        await adminPost(app, session, '/admin/credentials', {
          template: 'openai',
          credential: SECRET,
        })
      ).text(),
    );
    const res = await adminPost(app, session, '/admin/credentials', {
      template: 'github',
      credential_draft: draft ?? '',
      save_anyway: '1',
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('the destination changed');
  });

  it('a secret that fails the local format check gets no draft', async () => {
    const session = await owner();
    const res = await adminPost(app, session, '/admin/credentials', {
      template: 'openai',
      credential: 'sk-proj-with space in it 0123456789',
    });
    expect(res.status).toBe(400);
    expect(draftOf(await res.text())).toBeNull();
  });

  it('the draft and the secret are never in D1, audit diffs or console output', async () => {
    const session = await owner();
    const first = await adminPost(app, session, '/admin/credentials', {
      template: 'openai',
      credential: SECRET,
    });
    const draft = draftOf(await first.text()) ?? '';
    await adminPost(app, session, '/admin/credentials', {
      template: 'openai',
      credential_draft: draft,
      save_anyway: '1',
    });
    const dump = await dumpControlPlane();
    const telemetry = JSON.stringify(
      (await env.TELEMETRY_DB.prepare('SELECT * FROM request_log').all()).results,
    );
    for (const sink of [dump, telemetry, consoleLines.join('\n')]) {
      expect(sink).not.toContain(SECRET);
      expect(sink).not.toContain(draft);
      expect(sink).not.toContain(draft.split('.')[3] ?? 'none');
    }
  });

  it('with no keyring the forms are not rendered and a POST gets no draft', async () => {
    const noKey = createTestApp({ fetch: network.fetch, env: { TOKENGATE_KEK: '' } });
    const session = await loginAs(
      noKey,
      await createUser({ email: 'o@example.com', role: 'owner' }),
    );
    const res = await adminPost(noKey, session, '/admin/credentials', {
      template: 'openai',
      credential: SECRET,
    });
    expect(res.status).toBe(503);
    const html = await res.text();
    expect(html).not.toContain('name="credential_draft"');
    expect(html).not.toContain('type="password"');
    expect(html).not.toContain(SECRET);
  });
});
