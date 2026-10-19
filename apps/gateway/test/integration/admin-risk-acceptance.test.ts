// §A7.7: a risky credential access rule is saved only with the risk explicitly accepted, either by
// the structured choice that causes it or by ticking a box bound to a digest of exactly the risks
// shown (I-AUTHZ-3). A tick or choice for one risk never covers another, and nothing is written on
// refusal.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { getCredentialAccessRule, listCredentialAccessRules } from '../../src/db/access-rules';
import {
  type RulesWorld,
  rulesWorld,
  formFields,
  idFromLocation,
  inputValue,
  lastAudit,
  locationOf,
} from '../helpers/access-rules';
import { adminGet, adminPost } from '../helpers/admin-auth';
import {
  OWNER_ID,
  REPOSITORY_ID,
  seedCredentialRule,
  seedService,
} from '../unit/admin/ops/helpers';

let world: RulesWorld;
let serviceId: string;

beforeEach(async () => {
  world = await rulesWorld();
  serviceId = await seedService(world.app.deps);
});

const session = () => world.sessions.access_manager;
const RULES = '/admin/credential-access-rules';
const J = 'new.github-actions.';

/** The structured GitHub form: organization acme, repository acme/api, branch main. */
function fields(overrides: Record<string, string | string[]> = {}) {
  return {
    token_id: serviceId,
    'new.type': 'github-actions',
    'new.github_org': `acme (${OWNER_ID})`,
    [`${J}editor`]: 'structured',
    [`${J}repository`]: `acme/api (${REPOSITORY_ID})`,
    [`${J}context`]: 'branch',
    [`${J}branch`]: 'main',
    [`${J}ref_protection`]: 'protected',
    ops: '1',
    op: 'read-repo',
    expires: 'never',
    ...overrides,
  };
}

/** The same rule written by hand: condition rows and one operation row. */
function rows(extra: Record<string, string> = {}) {
  return {
    token_id: serviceId,
    'new.type': 'github-actions',
    'new.github_org': `acme (${OWNER_ID})`,
    [`${J}editor`]: 'rows',
    [`${J}cond.0.claim`]: 'repository_owner_id',
    [`${J}cond.0.values`]: OWNER_ID,
    [`${J}cond.1.claim`]: 'repository_id',
    [`${J}cond.1.values`]: REPOSITORY_ID,
    [`${J}cond.2.claim`]: 'ref',
    [`${J}cond.2.match`]: 'glob',
    [`${J}cond.2.values`]: 'refs/heads/main',
    ops: '1',
    op: 'custom',
    'rule.0.m': 'GET',
    'rule.0.path': '/repos/acme/api',
    expires: 'never',
    ...extra,
  };
}

const rules = () => listCredentialAccessRules(env.DB);

describe('I-AUTHZ-3: a risky credential access rule needs explicit acceptance', () => {
  it('choosing unprotected refs accepts that risk in one submit, recorded in the audit row', async () => {
    const res = await adminPost(
      world.app,
      session(),
      RULES,
      fields({ [`${J}ref_protection`]: 'unprotected' }),
    );
    expect(res.status).toBe(303);
    const audit = await lastAudit('credential_access_rule.create');
    expect(audit?.accepted_risks).toEqual(['unprotected_ref']);
    expect(audit?.warnings).toEqual([expect.stringContaining('ref_protected')]);
  });

  it('the pull request and any contexts carry their own risk in their choice', async () => {
    for (const context of ['pull_request', 'any']) {
      const res = await adminPost(
        world.app,
        session(),
        RULES,
        fields({ [`${J}context`]: context, [`${J}pr_base`]: 'main', name: `rule ${context}` }),
      );
      expect(res.status, context).toBe(303);
    }
    expect((await lastAudit('credential_access_rule.create'))?.accepted_risks).toEqual(['any_ref']);
  });

  it('rows with an uncovered warning need the digest and the box: 422 first, then one submit', async () => {
    const first = await adminPost(world.app, session(), RULES, rows());
    expect(first.status).toBe(422);
    const html = await first.text();
    expect(html).toContain('href="#ga-risk-ack"');
    expect(html).toMatch(/name="acknowledge_warnings"[^>]*required/);
    const digest = inputValue(html, 'warnings_digest');
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(await rules()).toEqual([]);
    const unticked = await adminPost(world.app, session(), RULES, {
      ...rows(),
      warnings_digest: digest ?? '',
    });
    expect(unticked.status).toBe(422);
    const second = await adminPost(world.app, session(), RULES, {
      ...rows(),
      warnings_digest: digest ?? '',
      acknowledge_warnings: '1',
    });
    expect(second.status).toBe(303);
    expect((await lastAudit('credential_access_rule.create'))?.accepted_risks).toEqual([
      'unprotected_ref',
    ]);
  });

  it('rows that constrain no ref, environment or event carry the any-ref risk too', async () => {
    const anyRef = rows({
      [`${J}cond.2.claim`]: '',
      [`${J}cond.2.match`]: '',
      [`${J}cond.2.values`]: '',
    });
    const first = await adminPost(world.app, session(), RULES, anyRef);
    expect(first.status).toBe(422);
    const html = await first.text();
    expect(html).toContain('anyone with write access to the repository');
    expect(await rules()).toEqual([]);
    const second = await adminPost(world.app, session(), RULES, {
      ...anyRef,
      warnings_digest: inputValue(html, 'warnings_digest') ?? '',
      acknowledge_warnings: '1',
    });
    expect(second.status).toBe(303);
    expect((await lastAudit('credential_access_rule.create'))?.accepted_risks).toEqual(['any_ref']);
    // The rule page agrees with the acceptance.
    const page = await (await adminGet(world.app, session(), locationOf(second))).text();
    expect(page).toContain('anyone with write access to the repository');
  });

  it('a digest of other risks does not count', async () => {
    const first = await adminPost(world.app, session(), RULES, rows());
    const digest = inputValue(await first.text(), 'warnings_digest') ?? '';
    const broader = await adminPost(world.app, session(), RULES, {
      ...rows({ [`${J}cond.2.values`]: 'refs/heads/**' }),
      warnings_digest: digest,
      acknowledge_warnings: '1',
    });
    expect(broader.status).toBe(422);
    expect(await broader.text()).toContain('The risks changed');
    expect(await rules()).toEqual([]);
  });

  it('a copy of a risk-accepted rule asks for the acknowledgement on its first render', async () => {
    const created = await adminPost(
      world.app,
      session(),
      RULES,
      fields({ [`${J}ref_protection`]: 'unprotected' }),
    );
    const sourceId = idFromLocation(locationOf(created));
    const html = await (
      await adminGet(world.app, session(), `${RULES}/new?copy=${sourceId}`)
    ).text();
    expect(html).toContain('Copied the values of');
    expect(html).toMatch(new RegExp(`name="${J}ref_protection" value="unprotected" checked`));
    expect(html).toMatch(/name="acknowledge_warnings"[^>]*required/);
    expect(html).not.toMatch(/name="acknowledge_warnings"[^>]*checked/);
    const digest = inputValue(html, 'warnings_digest') ?? '';
    const without = await adminPost(world.app, session(), RULES, {
      ...fields({ [`${J}ref_protection`]: 'unprotected', [`${J}repository`]: 'acme/web (5)' }),
      warnings_digest: digest,
    });
    expect(without.status).toBe(422);
    expect(await rules()).toHaveLength(1);
  });

  it('a copy of a rule whose repository has no stored name asks for the acknowledgement too', async () => {
    // Created by the ops: owner and repository conditions, no labels: any_ref.
    const source = await seedCredentialRule(world.app.deps, { credential_id: serviceId });
    const html = await (
      await adminGet(world.app, session(), `${RULES}/new?copy=${source.id}`)
    ).text();
    expect(html).toContain('<div class="riskacc always" id="ga-risk"');
    expect(html).toMatch(/name="acknowledge_warnings"[^>]*required/);
    // The bare ID has no name yet: the hint names the command that prints it.
    expect(html).toContain(`gh api repositories/${REPOSITORY_ID}`);
    const form = await formFields(html, 'rule-form');
    // The organization has no stored name either.
    expect(form['new.github_org']).toBe(OWNER_ID);
    const repository = {
      'new.github_org': `acme (${OWNER_ID})`,
      [`${J}repository`]: `acme/api (${REPOSITORY_ID})`,
    };
    // Typing the names alone does not accept the prefilled risky choice.
    const unticked = await adminPost(world.app, session(), RULES, { ...form, ...repository });
    expect(unticked.status).toBe(422);
    const { warnings_digest: _digest, ...withoutDigest } = form;
    const noDigest = await adminPost(world.app, session(), RULES, {
      ...withoutDigest,
      ...repository,
    });
    expect(noDigest.status).toBe(422);
    expect(await noDigest.text()).toMatch(/name="acknowledge_warnings"[^>]*required/);
    // A 422 for another input keeps the acknowledgement on the page.
    const missing = await adminPost(world.app, session(), RULES, withoutDigest);
    expect(missing.status).toBe(422);
    expect(await missing.text()).toContain('<div class="riskacc always" id="ga-risk"');
    expect(await rules()).toHaveLength(1);
    const ticked = await adminPost(world.app, session(), RULES, {
      ...form,
      ...repository,
      acknowledge_warnings: '1',
    });
    expect(ticked.status).toBe(303);
    expect((await lastAudit('credential_access_rule.create'))?.accepted_risks).toEqual(['any_ref']);
  });

  it('a decoy choice in another branch covers nothing', async () => {
    const other = await seedService(world.app.deps, { slug: 'other', name: 'Other' });
    // Two credentials: the operation fields are prefixed with the credential id. The chosen
    // jobs are rows; a decoy "unprotected" sits in fields that are not read.
    const res = await adminPost(world.app, session(), RULES, {
      ...rows(),
      [`${serviceId}.ops`]: '1',
      [`${serviceId}.op`]: 'custom',
      [`${serviceId}.rule.0.m`]: 'GET',
      [`${serviceId}.rule.0.path`]: '/repos/acme/api',
      [`${other}.ops`]: '1',
      [`${J}context`]: 'branch',
      [`${J}ref_protection`]: 'unprotected',
      context: 'branch',
      ref_protection: 'unprotected',
    });
    expect(res.status).toBe(422);
    expect(await rules()).toEqual([]);
  });

  it('an edit that adds a risk asks again', async () => {
    const created = await adminPost(world.app, session(), RULES, fields());
    const id = idFromLocation(locationOf(created));
    const res = await adminPost(world.app, session(), `${RULES}/${id}`, {
      ...rows(),
      intent: 'save',
      expires: 'keep',
    });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain('id="rule-edit"');
    expect((await getCredentialAccessRule(env.DB, id))?.conditions).toHaveLength(6);
  });
});
