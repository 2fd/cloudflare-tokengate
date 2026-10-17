// Display labels of numeric IDs (claim_labels) name repositories and organizations in the admin UI
// and help the access form derive an access's owner. Policy evaluation never reads them, so a
// label can never widen or narrow what an access allows; they are escaped wherever shown, are part
// of the configuration export, and IDs stay strings end to end (they can exceed 2^53).
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { getIssuerAccessRule } from '../../src/db/issuer_access_rules';
// oxlint-disable-next-line import/default -- a ?raw import is the file text
import proxyContextSource from '../../src/db/proxy-context.ts?raw';
import type { CredentialAccessRule } from '../../src/db/types';
import { getProfile } from '../../src/identity/profiles';
// oxlint-disable-next-line import/default -- a ?raw import is the file text
import conditionsSource from '../../src/policy/conditions.ts?raw';
import { evaluateIssuerAccessRules } from '../../src/policy/evaluate';
// oxlint-disable-next-line import/default -- a ?raw import is the file text
import evaluateSource from '../../src/policy/evaluate.ts?raw';
// oxlint-disable-next-line import/default -- a ?raw import is the file text
import validateSource from '../../src/policy/validate.ts?raw';
// oxlint-disable-next-line import/default -- a ?raw import is the file text
import handlerSource from '../../src/proxy/handler.ts?raw';
import { adminGet, adminPost } from '../helpers/admin-auth';
import {
  type ConsumersWorld,
  consumersWorld,
  idFromLocation,
  locationOf,
  seedLabel,
} from '../helpers/consumers';
import { OWNER_ID, seedGithubProvider, seedService } from '../unit/admin/ops/helpers';

let world: ConsumersWorld;
let provider: CredentialAccessRule;
let serviceId: string;

beforeEach(async () => {
  world = await consumersWorld();
  serviceId = await seedService(world.app.deps);
  provider = await seedGithubProvider(world.app.deps);
});

const session = () => world.sessions.admin;
const BIG_ID = '18446744073709551615';

describe('I-AUTHZ-2: labels are display only', () => {
  it('no policy or proxy module reads claim_labels', () => {
    for (const [name, source] of Object.entries({
      evaluateSource,
      validateSource,
      conditionsSource,
      handlerSource,
      proxyContextSource,
    })) {
      expect(source, name).not.toMatch(/claim_labels|claim-labels/);
    }
  });

  it('a label change never changes an evaluation decision', async () => {
    const res = await adminPost(world.app, session(), '/admin/issuer-access-rules', {
      consumer_id: provider.id,
      token_id: serviceId,
      repository: 'acme/api (55)',
      context: 'branch',
      branch: 'main',
      ref_protection: 'protected',
      op: 'read-repo',
      expires: 'never',
    });
    const grant = await getIssuerAccessRule(env.DB, idFromLocation(locationOf(res)));
    if (!grant) throw new Error('missing');
    const profile = getProfile('github-actions');
    if (!profile) throw new Error('profile');
    const input = (repository: string) => ({
      claims: {
        repository_owner_id: OWNER_ID,
        repository_id: '55',
        repository,
        ref: 'refs/heads/main',
        ref_type: 'branch',
        ref_protected: 'true',
        event_name: 'push',
      },
      profile,
      provider,
      method: 'GET',
      path: '/repos/acme/api/contents',
      matchPath: '/repos/acme/api/contents',
      revealClaims: new Set<string>(),
    });
    const before = evaluateIssuerAccessRules([grant], input('acme/api')).decision;
    await seedLabel(provider.id, 'repository_id', '55', 'someone-else/repo');
    const reloaded = await getIssuerAccessRule(env.DB, grant.id);
    if (!reloaded) throw new Error('missing');
    expect(reloaded.conditions).toEqual(grant.conditions);
    expect(evaluateIssuerAccessRules([reloaded], input('acme/api')).decision).toBe(before);
    expect(before).toBe('allow');
  });

  it('escapes labels on every page that shows them', async () => {
    await seedLabel(provider.id, 'repository_owner_id', OWNER_ID, '"><img src=x onerror=1>');
    await seedLabel(provider.id, 'repository_id', '55', '<script>alert(1)</script>');
    for (const path of [
      '/admin/credential-access-rules',
      `/admin/credential-access-rules/${provider.id}`,
      '/admin/issuer-access-rules',
      '/admin/issuer-access-rules/new',
      '/admin/issuer-access-rules?view=list&repository=script',
    ]) {
      const html = await (await adminGet(world.app, session(), path)).text();
      expect(html, path).not.toContain('<script>alert(1)</script>');
      expect(html, path).not.toContain('<img src=x');
    }
  });

  it('keeps IDs above 2^53 as exact strings and exports the labels (v2)', async () => {
    const res = await adminPost(world.app, session(), '/admin/issuer-access-rules', {
      consumer_id: provider.id,
      token_id: serviceId,
      repository: `acme/big (${BIG_ID})`,
      context: 'any',
      op: 'read-repo',
      expires: 'never',
    });
    expect(res.status).toBe(303);
    const grant = await getIssuerAccessRule(env.DB, idFromLocation(locationOf(res)));
    expect(grant?.conditions).toContainEqual({
      claim: 'repository_id',
      match: 'exact',
      values: [BIG_ID],
    });
    const exported = await adminPost(world.app, world.sessions.owner, '/admin/export');
    const document = (await exported.json()) as { claim_labels: Array<Record<string, string>> };
    expect(document.claim_labels).toContainEqual(
      expect.objectContaining({ claim: 'repository_id', value: BIG_ID, label: 'acme/big' }),
    );
  });
});
