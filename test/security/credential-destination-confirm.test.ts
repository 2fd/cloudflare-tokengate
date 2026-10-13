// I-CRED-2: a D1 writer who repoints a service cannot get the credential by waiting for an admin
// to re-enter it. A stored credential that does not open under the stored row makes the stored
// destination unattested: the service page says so and does not prefill it, and a credential save
// requires the admin to type the destination host before anything is sent upstream.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { setServiceCredential } from '../../src/admin/ops/services';
import {
  createAdminWorldApp,
  resetAdminWorld,
  seedAdminWorld,
  WORLD_SECRET,
} from '../fixtures/admin-forms';
import { adminGet, adminPost, createUser, loginAs } from '../helpers/admin-auth';
import {
  ACTOR,
  auditRows,
  CONTEXT,
  fakeNetwork,
  opsDeps,
  resetControlPlane,
  seedService,
} from '../unit/admin/ops/helpers';

const SECRET = 'confirm-secret-0123456789abcdef';
const VERIFY = { method: 'GET' as const, path: '/rate_limit', expect_status: 200 };
const ATTACKER = 'https://attacker.example';

async function repoint(id: string): Promise<void> {
  await env.DB.prepare('UPDATE services SET base_url = ? WHERE id = ?').bind(ATTACKER, id).run();
}

const sentTo = (calls: Array<{ url: string }>, origin: string) =>
  calls.filter((call) => call.url.startsWith(origin));

describe('I-CRED-2: re-entering a credential after a D1 repoint needs a confirmed destination', () => {
  beforeEach(resetControlPlane);

  it('refuses before the verify check when the stored credential no longer opens', async () => {
    const network = fakeNetwork();
    const deps = opsDeps({ fetch: network.fetch });
    const id = await seedService(deps, { secret: SECRET, verify: VERIFY });
    await repoint(id);
    const audits = (await auditRows(id)).length;

    for (const confirm of [undefined, '', 'api.github.com']) {
      const result = await setServiceCredential(
        deps,
        ACTOR,
        id,
        {
          base_url: ATTACKER,
          injection: { kind: 'bearer' },
          secret: SECRET,
          confirm_destination: confirm,
        },
        CONTEXT,
      );
      expect(result).toMatchObject({ ok: false, reason: 'confirmation_required' });
      if (result.ok) return;
      expect(result.errors.join(' ')).toMatch(/credential_binding_mismatch/);
    }
    expect(sentTo(network.calls, ATTACKER)).toEqual([]);
    expect((await auditRows(id)).length).toBe(audits);
  });

  it('saves once the typed host matches, and the audit row reports the destination', async () => {
    const network = fakeNetwork();
    const deps = opsDeps({ fetch: network.fetch });
    const id = await seedService(deps, { secret: SECRET, verify: VERIFY });
    await repoint(id);

    const result = await setServiceCredential(
      deps,
      ACTOR,
      id,
      {
        base_url: 'https://api.github.com',
        injection: { kind: 'bearer' },
        secret: SECRET,
        confirm_destination: ' API.GitHub.com ',
      },
      CONTEXT,
    );
    expect(result.ok).toBe(true);
    expect(sentTo(network.calls, ATTACKER)).toEqual([]);
    const audit = (await auditRows(id)).at(-1);
    expect(audit?.action).toBe('service.credential.set');
    expect(audit?.summary).toContain('set its destination to https://api.github.com');
    expect(audit?.summary).toContain('credential_binding_mismatch');
    expect(audit?.diff).toMatchObject({
      before: { base_url: ATTACKER },
      after: { base_url: 'https://api.github.com' },
      stored_binding: {
        attested: false,
        error: 'credential_binding_mismatch',
        confirmed_destination: 'api.github.com',
      },
    });
  });

  it.each([
    ['damaged', "UPDATE services SET credential_sealed = '{}', base_url = ? WHERE id = ?"],
    [
      'unknown key id',
      `UPDATE services SET credential_sealed = json_set(credential_sealed, '$.kid', 'gone'), base_url = ? WHERE id = ?`,
    ],
  ])('also requires the confirmation for a %s stored credential', async (_, sql) => {
    const network = fakeNetwork();
    const deps = opsDeps({ fetch: network.fetch });
    const id = await seedService(deps, { secret: SECRET, verify: VERIFY });
    await env.DB.prepare(sql).bind(ATTACKER, id).run();
    const result = await setServiceCredential(
      deps,
      ACTOR,
      id,
      { base_url: ATTACKER, injection: { kind: 'bearer' }, secret: SECRET },
      CONTEXT,
    );
    expect(result).toMatchObject({ ok: false, reason: 'confirmation_required' });
    expect(sentTo(network.calls, ATTACKER)).toEqual([]);
  });

  it('needs no confirmation while the stored credential opens', async () => {
    const deps = opsDeps();
    const id = await seedService(deps, { secret: SECRET, verify: VERIFY });
    const result = await setServiceCredential(
      deps,
      ACTOR,
      id,
      { base_url: 'https://api.github.com', injection: { kind: 'bearer' }, secret: SECRET },
      CONTEXT,
    );
    expect(result.ok).toBe(true);
  });
});

describe('I-CRED-2: the service page flags an unattested destination', () => {
  beforeEach(resetAdminWorld);

  it('shows an error banner, does not prefill the tampered destination, and asks for the host', async () => {
    const network = fakeNetwork();
    const app = createAdminWorldApp(network.fetch);
    const world = await seedAdminWorld(app);
    const session = await loginAs(app, await createUser({ email: 'o@example.com', role: 'owner' }));
    await repoint(world.serviceId);
    const path = `/admin/services/${world.serviceId}`;

    const page = await (await adminGet(app, session, path)).text();
    expect(page).toContain('was changed outside the admin UI');
    expect(page).toContain('the encryption key is unchanged');
    expect(page).toContain('name="confirm_destination"');
    // The stored destination is shown, but flagged, and the credential is not shown as usable.
    expect(page).toMatch(/attacker\.example<\/code>\s*<span class="badge bad">not confirmed/);
    expect(page).toContain('does not open');
    expect(page).not.toMatch(/name="base_url"[^>]*value="https:\/\/attacker\.example"/);
    expect(page).not.toMatch(/value="https:\/\/attacker\.example"[^>]*name="base_url"/);

    const fields = { base_url: ATTACKER, injection_kind: 'bearer', credential: WORLD_SECRET };
    const refused = await adminPost(app, session, `${path}/credential`, fields);
    expect(refused.status).toBe(422);
    expect(await refused.text()).toContain('Confirm destination host');
    expect(sentTo(network.calls, ATTACKER)).toEqual([]);

    const saved = await adminPost(app, session, `${path}/credential`, {
      ...fields,
      base_url: 'https://api.github.com',
      confirm_destination: 'api.github.com',
    });
    expect(saved.status).toBe(303);
    const after = await (await adminGet(app, session, path)).text();
    expect(after).not.toContain('was changed outside the admin UI');
    expect(after).not.toContain('name="confirm_destination"');
  });

  it('shows no banner for an intact service', async () => {
    const app = createAdminWorldApp();
    const world = await seedAdminWorld(app);
    const session = await loginAs(app, await createUser({ email: 'o@example.com', role: 'owner' }));
    const page = await (await adminGet(app, session, `/admin/services/${world.serviceId}`)).text();
    expect(page).not.toContain('outside the admin UI');
    expect(page).not.toContain('not confirmed');
    expect(page).not.toContain('name="confirm_destination"');
  });
});
