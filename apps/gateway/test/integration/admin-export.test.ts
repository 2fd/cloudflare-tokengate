// Configuration export (`POST /admin/export`, the account menu form): admins and owners only
// (config:export), a CSRF-checked POST with an audit row, never a link or a GET.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { registerExportRoutes } from '../../src/admin/routes/export';
import { registerRetentionRoutes } from '../../src/admin/routes/retention';
import type { App } from '../../src/app';
import type { Role } from '../../src/db/types';
import {
  type AdminSession,
  type AdminTestApp,
  adminGet,
  adminPost,
  createAdminTestApp,
  createUser,
  loginAs,
  resetControlPlane,
} from '../helpers/admin-auth';

const T0 = Date.UTC(2026, 9, 13, 12);

let app: AdminTestApp;

beforeEach(async () => {
  await resetControlPlane();
  app = createAdminTestApp({
    routes: (target: App) => {
      registerRetentionRoutes(target);
      registerExportRoutes(target);
    },
    now: () => T0,
  });
});

async function sessionFor(role: Role): Promise<AdminSession> {
  return loginAs(app, await createUser({ email: `${role}@example.com`, role }, T0));
}

async function auditActions(): Promise<string[]> {
  const { results } = await env.DB.prepare('SELECT action FROM audit_log ORDER BY rowid').all<{
    action: string;
  }>();
  return results.map((row) => row.action);
}

describe('the account menu export item', () => {
  it.each(['admin', 'owner'] as const)(
    'is on every page for %s, as a POST with CSRF',
    async (role) => {
      const session = await sessionFor(role);
      const html = await (await adminGet(app, session, '/admin/retention')).text();
      // A CSRF POST inside the account menu, never a link (a GET is the 404 page).
      const form =
        /<div class="menu" id="acct" popover="auto">[\s\S]*?<form method="post" action="\/admin\/export">(.*?)<\/form>/s.exec(
          html,
        );
      expect(form?.[1]).toContain(`name="_csrf" value="${session.csrfToken}"`);
      expect(form?.[1]).toContain(
        '<button class="menu-item two" type="submit"><b>Export configuration</b>',
      );
      expect(html).not.toContain('href="/admin/export"');
    },
  );

  it.each(['viewer', 'token_manager', 'access_manager'] as const)(
    'is absent for %s',
    async (role) => {
      const html = await (await adminGet(app, await sessionFor(role), '/admin/retention')).text();
      expect(html).not.toContain('action="/admin/export"');
      expect(html).not.toContain('href="/admin/export"');
    },
  );
});

describe('POST /admin/export', () => {
  it('downloads the export as an attachment and audits it', async () => {
    const res = await adminPost(app, await sessionFor('admin'), '/admin/export');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="tokengate-export-2026-10-13.json"',
    );
    expect(res.headers.get('cache-control')).toContain('no-store');
    const body = await res.json<{
      schema_version: number;
      claim_labels: unknown[];
      users: Array<{ email: string }>;
    }>();
    expect(body.schema_version).toBe(2);
    expect(body.claim_labels).toEqual([]);
    expect(body.users.map((user) => user.email)).toEqual(['admin@example.com']);
    expect(await auditActions()).toEqual(['config.export']);
  });

  it.each(['viewer', 'token_manager', 'access_manager'] as const)(
    'is forbidden for %s',
    async (role) => {
      const res = await adminPost(app, await sessionFor(role), '/admin/export');
      expect(res.status).toBe(403);
      expect(await auditActions()).toEqual([]);
    },
  );

  it('GET is a 404 page and writes no audit row', async () => {
    const res = await adminGet(app, await sessionFor('owner'), '/admin/export');
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('Page not found');
    expect(await auditActions()).toEqual([]);
  });
});
