// Deleting a credential access rule with accesses (D9): one confirmed submit deletes the credential access rule, exactly the
// accesses the dialog listed, and its labels, with one audit row (I-AUDIT-1). An access manager
// can do it; a changed access set deletes nothing.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { getCredentialAccessRule } from '../../src/db/credential-access-rules';
import { listIssuerAccessRules } from '../../src/db/issuer_access_rules';
import type { CredentialAccessRule } from '../../src/db/types';
import { adminGet, adminPost } from '../helpers/admin-auth';
import {
  auditActions,
  type ConsumersWorld,
  consumersWorld,
  labels,
  lastAudit,
  locationOf,
  seedLabel,
} from '../helpers/consumers';
import { seedGithubProvider, seedIssuerAccessRule, seedService } from '../unit/admin/ops/helpers';

let world: ConsumersWorld;
let provider: CredentialAccessRule;
let ids: string[];

beforeEach(async () => {
  world = await consumersWorld();
  const serviceId = await seedService(world.app.deps);
  provider = await seedGithubProvider(world.app.deps);
  ids = [
    (await seedIssuerAccessRule(world.app.deps, provider.id, serviceId, 'a')).id,
    (await seedIssuerAccessRule(world.app.deps, provider.id, serviceId, 'b')).id,
  ].sort();
  await seedLabel(provider.id, 'repository_id', '987654321', 'acme/api');
});

const session = () => world.sessions.token_manager;

describe('I-AUDIT-1: deleting a credential access rule and its accesses is one audited change', () => {
  it('lists the accesses in the dialog and carries their ids', async () => {
    const html = await (
      await adminGet(world.app, session(), `/admin/credential-access-rules/${provider.id}`)
    ).text();
    expect(html).toContain('and its 2 issuer access rules?');
    expect(html).toContain('name="with_accesses" value="1"');
    expect(html).toContain(`name="access_ids" value="${ids.join(',')}"`);
  });

  it('deletes the credential access rule, its accesses and its labels with one audit row', async () => {
    const before = await auditActions();
    const res = await adminPost(
      world.app,
      session(),
      `/admin/credential-access-rules/${provider.id}/delete`,
      {
        confirm: '1',
        with_accesses: '1',
        access_ids: ids.join(','),
      },
    );
    expect(res.status).toBe(303);
    expect(locationOf(res)).toBe('/admin/credential-access-rules?notice=deleted_with_accesses');
    expect(await getCredentialAccessRule(env.DB, provider.id)).toBeNull();
    expect(await listIssuerAccessRules(env.DB)).toEqual([]);
    expect(await labels(provider.id)).toEqual([]);
    expect(await auditActions()).toEqual([...before, 'credential_access_rule.delete']);
    const diff = await lastAudit('credential_access_rule.delete');
    expect(
      (
        (diff?.before ?? { issuer_access_rules: [] }) as {
          issuer_access_rules: Array<{ id: string }>;
        }
      ).issuer_access_rules
        .map((g) => g.id)
        .sort(),
    ).toEqual(ids);
  });

  it('deletes nothing when an access was added after the dialog was shown', async () => {
    await seedIssuerAccessRule(
      world.app.deps,
      provider.id,
      (await listIssuerAccessRules(env.DB))[0]?.service_id ?? '',
      'late',
    );
    const before = await auditActions();
    const res = await adminPost(
      world.app,
      session(),
      `/admin/credential-access-rules/${provider.id}/delete`,
      {
        confirm: '1',
        with_accesses: '1',
        access_ids: ids.join(','),
      },
    );
    expect(res.status).toBe(409);
    expect(await getCredentialAccessRule(env.DB, provider.id)).not.toBeNull();
    expect(await listIssuerAccessRules(env.DB)).toHaveLength(3);
    expect(await labels(provider.id)).toHaveLength(1);
    expect(await auditActions()).toEqual(before);
  });

  it('an access manager cannot delete a credential access rule', async () => {
    const res = await adminPost(
      world.app,
      world.sessions.access_manager,
      `/admin/credential-access-rules/${provider.id}/delete`,
      {
        confirm: '1',
        with_accesses: '1',
        access_ids: ids.join(','),
      },
    );
    expect(res.status).toBe(403);
    expect(await listIssuerAccessRules(env.DB)).toHaveLength(2);
  });
});
