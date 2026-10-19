// Display labels of numeric IDs (claim_labels) name repositories and organizations in the admin UI
// and help the access rule form derive a rule's owner. Labels belong to an access rule (AR-17).
// Policy evaluation never reads them, so a label can never widen or narrow what an access rule
// allows; they are escaped wherever shown, are part of the configuration export, and IDs stay
// strings end to end (they can exceed 2^53).
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { getCredentialAccessRule } from '../../src/db/access-rules';
// oxlint-disable-next-line import/default -- a ?raw import is the file text
import proxyContextSource from '../../src/db/proxy-context.ts?raw';
import type { CredentialAccessRule } from '../../src/db/types';
import { getProfile } from '../../src/identity/profiles';
import { credentialRuleDecision, globalDecision } from '../../src/policy/access-rules';
// oxlint-disable-next-line import/default -- a ?raw import is the file text
import accessRulesSource from '../../src/policy/access-rules.ts?raw';
// oxlint-disable-next-line import/default -- a ?raw import is the file text
import conditionsSource from '../../src/policy/conditions.ts?raw';
// oxlint-disable-next-line import/default -- a ?raw import is the file text
import limitsSource from '../../src/policy/limits.ts?raw';
// oxlint-disable-next-line import/default -- a ?raw import is the file text
import validateRulesSource from '../../src/policy/validate-rules.ts?raw';
// oxlint-disable-next-line import/default -- a ?raw import is the file text
import validateSource from '../../src/policy/validate.ts?raw';
// oxlint-disable-next-line import/default -- a ?raw import is the file text
import handlerSource from '../../src/proxy/handler.ts?raw';
import {
  type RulesWorld,
  rulesWorld,
  idFromLocation,
  locationOf,
  seedLabel,
} from '../helpers/access-rules';
import { adminGet, adminPost } from '../helpers/admin-auth';
import { OWNER_ID, seedCredentialRule, seedService } from '../unit/admin/ops/helpers';

let world: RulesWorld;
let rule: CredentialAccessRule;
let serviceId: string;

beforeEach(async () => {
  world = await rulesWorld();
  serviceId = await seedService(world.app.deps);
  rule = await seedCredentialRule(world.app.deps, { credential_id: serviceId });
});

const session = () => world.sessions.admin;
const BIG_ID = '18446744073709551615';

/** The credential access rule form for a GitHub repository on main (protected refs), read only. */
function ruleFields(repository: string, extra: Record<string, string> = {}) {
  const jobs = 'new.github-actions.';
  return {
    token_id: serviceId,
    token_view: 'fixed',
    'new.type': 'github-actions',
    'new.github_org': `acme (${OWNER_ID})`,
    [`${jobs}editor`]: 'structured',
    [`${jobs}repository`]: repository,
    [`${jobs}context`]: 'branch',
    [`${jobs}branch`]: 'main',
    [`${jobs}ref_protection`]: 'protected',
    ops: '1',
    op: 'read-repo',
    expires: 'never',
    ...extra,
  };
}

describe('I-AUTHZ-2: labels are display only', () => {
  it('no policy or proxy module reads claim_labels', () => {
    for (const [name, source] of Object.entries({
      accessRulesSource,
      limitsSource,
      validateSource,
      validateRulesSource,
      conditionsSource,
      handlerSource,
      proxyContextSource,
    })) {
      expect(source, name).not.toMatch(/claim_labels|claim-labels/);
    }
  });

  it('a label change never changes an evaluation decision', async () => {
    const res = await adminPost(
      world.app,
      session(),
      '/admin/credential-access-rules',
      ruleFields('acme/api (55)'),
    );
    expect(res.status).toBe(303);
    const created = await getCredentialAccessRule(env.DB, idFromLocation(locationOf(res)));
    if (!created) throw new Error('missing');
    const profile = getProfile('github-actions');
    if (!profile) throw new Error('profile');
    const decide = (subject: CredentialAccessRule) => {
      const facts = {
        claims: {
          repository_owner_id: OWNER_ID,
          repository_id: '55',
          repository: 'acme/api',
          ref: 'refs/heads/main',
          ref_type: 'branch',
          ref_protected: 'true',
          event_name: 'push',
        },
        alg: 'RS256',
        now: world.app.deps.now(),
        method: 'GET',
        path: '/repos/acme/api/contents',
        matchPath: '/repos/acme/api/contents',
        revealClaims: new Set<string>(),
      };
      return [
        credentialRuleDecision(subject, profile, facts).result,
        globalDecision(subject, [], facts).ok,
      ];
    };
    const before = decide(created);
    await seedLabel(created.id, 'repository_id', '55', 'someone-else/repo');
    const reloaded = await getCredentialAccessRule(env.DB, created.id);
    if (!reloaded) throw new Error('missing');
    expect(reloaded.conditions).toEqual(created.conditions);
    expect(decide(reloaded)).toEqual(before);
    expect(before).toEqual(['matched', true]);
  });

  it('escapes labels on every page that shows them', async () => {
    await seedLabel(rule.id, 'repository_owner_id', OWNER_ID, '"><img src=x onerror=1>');
    await seedLabel(rule.id, 'repository_id', '55', '<script>alert(1)</script>');
    for (const path of [
      '/admin/credential-access-rules',
      `/admin/credential-access-rules/${rule.id}`,
      `/admin/credential-access-rules/${rule.id}?open=edit`,
      '/admin/credential-access-rules/new',
      `/admin/credentials/${serviceId}`,
    ]) {
      const html = await (await adminGet(world.app, session(), path)).text();
      expect(html, path).not.toContain('<script>alert(1)</script>');
      expect(html, path).not.toContain('<img src=x');
    }
  });

  it('keeps IDs above 2^53 as exact strings and exports the labels', async () => {
    const res = await adminPost(
      world.app,
      session(),
      '/admin/credential-access-rules',
      ruleFields(`acme/big (${BIG_ID})`, { 'new.github-actions.context': 'any' }),
    );
    expect(res.status).toBe(303);
    const created = await getCredentialAccessRule(env.DB, idFromLocation(locationOf(res)));
    expect(created?.conditions).toContainEqual({
      claim: 'repository_id',
      match: 'exact',
      values: [BIG_ID],
    });
    const exported = await adminPost(world.app, world.sessions.owner, '/admin/export');
    const document = (await exported.json()) as {
      credential_access_rules: Array<{ id: string; labels: Array<Record<string, string>> }>;
    };
    const exportedRule = document.credential_access_rules.find((r) => r.id === created?.id);
    expect(exportedRule?.labels).toContainEqual({
      claim: 'repository_id',
      value: BIG_ID,
      label: 'acme/big',
    });
  });
});
