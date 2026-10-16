import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_FORM_MAX_BYTES } from '../../src/admin/render';
import { registerExportRoutes } from '../../src/admin/routes/export';
import {
  adminGet,
  adminPost,
  createAdminTestApp,
  createUser,
  loginAs,
  resetControlPlane,
  stubAdminPages,
} from '../helpers/admin-auth';

beforeEach(resetControlPlane);

async function setup(envOverrides: Record<string, string> = {}) {
  const app = createAdminTestApp({ routes: stubAdminPages, env: envOverrides });
  const owner = await createUser({ email: 'o@example.com', role: 'owner' });
  const session = await loginAs(app, owner);
  return { app, owner, session };
}

describe('I-CSRF-1: unsafe admin requests need same-site metadata AND the double-submit token', () => {
  it('accepts a same-origin form POST whose token matches the CSRF cookie', async () => {
    const { app, session } = await setup();
    expect((await adminPost(app, session, '/admin/tokens', { name: 'x' })).status).toBe(200);
  });

  it('rejects a missing token', async () => {
    const { app, session } = await setup();
    expect((await adminPost(app, session, '/admin/tokens', {}, { csrf: null })).status).toBe(403);
  });

  it('rejects a mismatched token', async () => {
    const { app, session } = await setup();
    const res = await adminPost(
      app,
      session,
      '/admin/tokens',
      {},
      { csrf: `${session.csrfToken}x` },
    );
    expect(res.status).toBe(403);
  });

  it("rejects another browser's token", async () => {
    const { app, owner, session } = await setup();
    const other = await loginAs(app, owner);
    const res = await adminPost(app, session, '/admin/tokens', {}, { csrf: other.csrfToken });
    expect(res.status).toBe(403);
  });

  it('rejects a matching token when the browser sent no CSRF cookie', async () => {
    const { app, session } = await setup();
    const res = await adminPost(app, session, '/admin/tokens', {}, { headers: { cookie: null } });
    expect(res.status).toBe(403);
  });

  it('rejects a cookie value that is not a token we issue, even when the field matches it', async () => {
    const { app, session } = await setup();
    const res = await adminPost(
      app,
      session,
      '/admin/tokens',
      {},
      { csrf: 'x', headers: { cookie: '__Host-tokengate_csrf=x' } },
    );
    expect(res.status).toBe(403);
  });

  it('rejects the token sent only in a query string or a JSON body', async () => {
    const { app, session } = await setup();
    const query = await adminPost(
      app,
      session,
      `/admin/tokens?_csrf=${session.csrfToken}`,
      {},
      { csrf: null },
    );
    expect(query.status).toBe(403);
    const json = await app.request('/admin/tokens', {
      method: 'POST',
      headers: {
        ...session.headers,
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ _csrf: session.csrfToken }),
    });
    expect(json.status).toBe(403);
  });

  it.each(['cross-site', 'same-site'])(
    'rejects Sec-Fetch-Site: %s even with a valid token',
    async (site) => {
      const { app, session } = await setup();
      const res = await adminPost(
        app,
        session,
        '/admin/tokens',
        {},
        { headers: { 'sec-fetch-site': site } },
      );
      expect(res.status).toBe(403);
    },
  );

  it('rejects a request with neither Sec-Fetch-Site nor Origin', async () => {
    const { app, session } = await setup();
    const res = await adminPost(
      app,
      session,
      '/admin/tokens',
      {},
      { headers: { 'sec-fetch-site': null } },
    );
    expect(res.status).toBe(403);
  });

  it('falls back to Origin when Sec-Fetch-Site is absent', async () => {
    const { app, session } = await setup();
    const same = await adminPost(
      app,
      session,
      '/admin/tokens',
      {},
      {
        headers: { 'sec-fetch-site': null, origin: 'https://gw.test' },
      },
    );
    expect(same.status).toBe(200);
    const cross = await adminPost(
      app,
      session,
      '/admin/tokens',
      {},
      {
        headers: { 'sec-fetch-site': null, origin: 'https://evil.test' },
      },
    );
    expect(cross.status).toBe(403);
  });

  it('compares Origin with the request origin', async () => {
    const { app, session } = await setup();
    const post = (origin: string) =>
      app.request('/admin/tokens', {
        method: 'POST',
        headers: {
          ...session.headers,
          origin,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ _csrf: session.csrfToken }),
        origin: 'https://admin.example.com',
      });
    expect((await post('https://admin.example.com')).status).toBe(200);
    expect((await post('https://gw.test')).status).toBe(403);
  });

  it('does not require the token on GET', async () => {
    const { app, session } = await setup();
    expect((await adminGet(app, session, '/admin/tokens')).status).toBe(200);
  });

  it('rejects a repeated _csrf field, even when every copy is the valid token', async () => {
    const { app, session } = await setup();
    for (const copies of [
      [session.csrfToken, session.csrfToken],
      [session.csrfToken, 'wrong'],
      ['wrong', session.csrfToken],
    ]) {
      const res = await adminPost(app, session, '/admin/tokens', { _csrf: copies }, { csrf: null });
      expect(res.status).toBe(403);
    }
  });

  it('accepts the token in a multipart form', async () => {
    const { app, session } = await setup();
    const body = new FormData();
    body.set('_csrf', session.csrfToken);
    const res = await app.request('/admin/tokens', {
      method: 'POST',
      headers: { ...session.headers, 'sec-fetch-site': 'same-origin' },
      body,
    });
    expect(res.status).toBe(200);
  });

  it('checks the token before the role: a viewer with a forged form gets the CSRF refusal', async () => {
    const app = createAdminTestApp({ routes: stubAdminPages });
    const viewer = await createUser({ email: 'v@example.com', role: 'viewer' });
    const session = await loginAs(app, viewer);
    const res = await adminPost(app, session, '/admin/tokens', {}, { csrf: null });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('The form was not accepted');
  });
});

describe('I-CSRF-1: the audited configuration export is a CSRF-checked POST', () => {
  async function exportSetup() {
    const app = createAdminTestApp({ routes: registerExportRoutes });
    const admin = await createUser({ email: 'a@example.com', role: 'admin' });
    return { app, session: await loginAs(app, admin) };
  }
  const exportRows = async () =>
    env.DB.prepare("SELECT count(*) AS n FROM audit_log WHERE action = 'config.export'").first('n');

  it('a cross-site top-level navigation (GET) neither exports nor audits', async () => {
    const { app, session } = await exportSetup();
    const res = await adminGet(app, session, '/admin/export', {
      'sec-fetch-site': 'cross-site',
      'sec-fetch-mode': 'navigate',
    });
    expect(res.status).not.toBe(200);
    expect(await exportRows()).toBe(0);
  });

  it('a cross-site POST is refused even with the token', async () => {
    const { app, session } = await exportSetup();
    const res = await adminPost(
      app,
      session,
      '/admin/export',
      {},
      { headers: { 'sec-fetch-site': 'cross-site' } },
    );
    expect(res.status).toBe(403);
    expect(await exportRows()).toBe(0);
  });

  it('a POST without the token is refused', async () => {
    const { app, session } = await exportSetup();
    expect((await adminPost(app, session, '/admin/export', {}, { csrf: null })).status).toBe(403);
    expect(await exportRows()).toBe(0);
  });

  it('a same-origin POST with the token downloads and audits once', async () => {
    const { app, session } = await exportSetup();
    const res = await adminPost(app, session, '/admin/export');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; /);
    expect(await exportRows()).toBe(1);
  });
});

describe('I-CSRF-1: admin form bodies are capped before they are parsed (any role)', () => {
  /** A form body stream of `total` bytes in 16 KiB chunks; `pulled()` reports bytes read. */
  function countingBody(total: number) {
    const chunk = new TextEncoder().encode('a'.repeat(16 * 1024));
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= total) return controller.close();
        sent += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    return { stream, pulled: () => sent };
  }

  async function viewerSetup() {
    const app = createAdminTestApp({ routes: stubAdminPages });
    const viewer = await createUser({ email: 'v@example.com', role: 'viewer' });
    return { app, session: await loginAs(app, viewer) };
  }

  it('refuses a form over the cap with 413 before the CSRF and role checks', async () => {
    const { app, session } = await viewerSetup();
    const res = await adminPost(app, session, '/admin/tokens', {
      blob: 'a'.repeat(ADMIN_FORM_MAX_BYTES),
    });
    expect(res.status).toBe(413);
  });

  it('refuses a declared Content-Length over the cap without reading the body', async () => {
    const { app, session } = await viewerSetup();
    const body = countingBody(ADMIN_FORM_MAX_BYTES * 4);
    const res = await app.request('/admin/tokens', {
      method: 'POST',
      headers: {
        ...session.headers,
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': String(ADMIN_FORM_MAX_BYTES * 4),
      },
      body: body.stream,
    });
    expect(res.status).toBe(413);
    expect(body.pulled()).toBeLessThanOrEqual(2 * 16 * 1024);
  });

  it('stops reading a body without Content-Length once it passes the cap', async () => {
    const { app, session } = await viewerSetup();
    const body = countingBody(8 * 1024 * 1024);
    const res = await app.request('/admin/tokens', {
      method: 'POST',
      headers: {
        ...session.headers,
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: body.stream,
    });
    expect(res.status).toBe(413);
    expect(body.pulled()).toBeLessThanOrEqual(ADMIN_FORM_MAX_BYTES + 2 * 16 * 1024);
  });

  it('accepts a form just under the cap', async () => {
    const { app } = await setup();
    const owner = await createUser({ email: 'o2@example.com', role: 'owner' });
    const session = await loginAs(app, owner);
    const filler = 'a'.repeat(ADMIN_FORM_MAX_BYTES - 200);
    expect((await adminPost(app, session, '/admin/tokens', { filler })).status).toBe(200);
  });
});
