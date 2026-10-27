// "Copy to another credential" (§A7.8) and the form prefilled from `?copy=` (§A7.7): one submit
// when the target credential has the same operations, otherwise the prefilled form with nothing
// written; the copy of an expired rule goes through the form too. A copy never carries a risk that
// was not accepted for its credential.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { getCredentialAccessRule, listCredentialAccessRules } from '../../src/db/access-rules';
import type { CredentialAccessRule } from '../../src/db/types';
import {
  auditActions,
  checkedValues,
  formFields,
  idFromLocation,
  inputValue,
  labels,
  locationOf,
  type RulesWorld,
  rulesWorld,
} from '../helpers/access-rules';
import { adminGet, adminPost } from '../helpers/admin-auth';
import { OWNER_ID, REPOSITORY_ID, seedService } from '../unit/admin/ops/helpers';

const RULES = '/admin/credential-access-rules';
const J = 'new.github-actions.';

let world: RulesWorld;
let github: string;
let source: CredentialAccessRule;

beforeEach(async () => {
  world = await rulesWorld();
  github = await seedService(world.app.deps);
  const created = await adminPost(world.app, session(), RULES, {
    token_id: github,
    'new.type': 'github-actions',
    'new.github_org': `acme (${OWNER_ID})`,
    [`${J}repository`]: `acme/api (${REPOSITORY_ID})`,
    [`${J}context`]: 'environment',
    [`${J}environment`]: 'production',
    [`${J}ref_protection`]: 'protected',
    ops: '1',
    op: 'read-repo',
    expires: 'never',
  });
  expect(created.status).toBe(303);
  source = (await getCredentialAccessRule(
    env.DB,
    idFromLocation(locationOf(created)),
  )) as CredentialAccessRule;
});

const session = () => world.sessions.access_manager;
const copies = async () =>
  (await auditActions()).filter((action) => action === 'credential_access_rule.duplicate');

describe('copy a credential access rule', () => {
  it('copies to a credential with the same operations in one submit: enabled, labelled, a free name', async () => {
    const other = await seedService(world.app.deps, { slug: 'github', name: 'GitHub 2' });
    const res = await adminPost(world.app, session(), `${RULES}/${source.id}/copy`, {
      credential_id: other,
    });
    expect(res.status).toBe(303);
    expect(locationOf(res)).toMatch(/\?notice=copied$/);
    const copy = await getCredentialAccessRule(env.DB, idFromLocation(locationOf(res)));
    expect(copy).toMatchObject({
      credential_id: other,
      enabled: true,
      issuer: source.issuer,
      tenant_pin: source.tenant_pin,
      conditions: source.conditions,
      rules: source.rules,
      audience: source.audience,
    });
    expect(copy?.id).not.toBe(source.id);
    expect(await labels(copy?.id)).toEqual(await labels(source.id));
    expect(await copies()).toHaveLength(1);
    expect(await (await adminGet(world.app, session(), locationOf(res))).text()).toContain(
      'Copy created and enabled.',
    );
  });

  it('copies to the same credential with another name', async () => {
    const res = await adminPost(world.app, session(), `${RULES}/${source.id}/copy`, {
      credential_id: '',
    });
    expect(res.status).toBe(303);
    const copy = await getCredentialAccessRule(env.DB, idFromLocation(locationOf(res)));
    expect(copy?.credential_id).toBe(github);
    expect(copy?.name).not.toBe(source.name);
    expect(await listCredentialAccessRules(env.DB, { credential_id: github })).toHaveLength(2);
  });

  it('sends a copy to a credential with other operations to the prefilled form, writing nothing', async () => {
    const openai = await seedService(world.app.deps, {
      slug: 'openai',
      name: 'OpenAI',
      base_url: 'https://api.openai.com/v1',
    });
    const res = await adminPost(world.app, session(), `${RULES}/${source.id}/copy`, {
      credential_id: openai,
    });
    expect(res.status).toBe(303);
    const target = new URL(locationOf(res), 'https://gw.test');
    expect(target.pathname).toBe(`${RULES}/new`);
    expect(Object.fromEntries(target.searchParams)).toEqual({
      copy: source.id,
      credential: openai,
      notice: 'copy_operations',
    });
    expect(await listCredentialAccessRules(env.DB)).toHaveLength(1);
    expect(await copies()).toEqual([]);
    const page = await (await adminGet(world.app, session(), locationOf(res))).text();
    expect(page).toContain('That credential has other operations');
    expect(page).toContain(`Copied the values of “${source.name}”.`);
    const fields = await formFields(page, 'rule-form');
    expect(fields.token_id).toBe(openai);
    // The jobs are copied; the operations are the target's own.
    expect(fields[`${J}repository`]).toBe(`acme/api (${REPOSITORY_ID})`);
    expect(fields.op).not.toContain('read-repo');
  });

  it('sends the copy of an expired rule to the form to choose its expiry', async () => {
    await env.DB.prepare('UPDATE access_rules SET expires_at = 1000 WHERE id = ?')
      .bind(source.id)
      .run();
    const res = await adminPost(world.app, session(), `${RULES}/${source.id}/copy`, {
      credential_id: '',
    });
    expect(locationOf(res)).toBe(`${RULES}/new?copy=${source.id}&notice=copy_expiry`);
    expect(await copies()).toEqual([]);
    const page = await (await adminGet(world.app, session(), locationOf(res))).text();
    expect(page).toContain('The source has expired');
    expect(checkedValues(page, 'expires')).toEqual(['never']);
  });

  it('refuses a copy to an unknown credential and keeps the dialog open', async () => {
    const res = await adminPost(world.app, session(), `${RULES}/${source.id}/copy`, {
      credential_id: 'svc_01JUNKNOWN0000000000000000',
    });
    expect(res.status).toBe(422);
    const page = await res.text();
    expect(page).toContain('Choose a credential.');
    expect(page).toMatch(/<dialog[^>]*id="dlg-copy-rule"[^>]*open/);
    expect(await copies()).toEqual([]);
  });
});

describe('the form prefilled from ?copy=', () => {
  it('copies every field except the credential and the name, and saves a second rule', async () => {
    const page = await (
      await adminGet(world.app, session(), `${RULES}/new?copy=${source.id}`)
    ).text();
    expect(page).toContain(`Copied the values of “${source.name}”.`);
    expect(inputValue(page, 'name')).toBe('');
    expect(inputValue(page, `${J}environment`)).toBe('production');
    expect(checkedValues(page, `${J}context`)).toEqual(['environment']);
    const fields = await formFields(page, 'rule-form');
    expect(fields.copy).toBe(source.id);
    expect(fields.audience).toBe(source.audience);
    const res = await adminPost(world.app, session(), RULES, {
      ...fields,
      [`${J}environment`]: 'staging',
    });
    expect(res.status).toBe(303);
    const copy = await getCredentialAccessRule(env.DB, idFromLocation(locationOf(res)));
    expect(copy?.conditions).toContainEqual({
      claim: 'environment',
      match: 'exact',
      values: ['staging'],
    });
    expect(copy?.tenant_pin).toEqual(source.tenant_pin);
  });

  it('says when the source no longer exists and copies nothing', async () => {
    const page = await (
      await adminGet(world.app, session(), `${RULES}/new?copy=acr_01JUNKNOWN0000000000000000`)
    ).text();
    expect(page).toContain('That access rule no longer exists; nothing was copied.');
    expect(page).not.toContain('Copied the values of');
    expect((await formFields(page, 'rule-form')).copy).toBeUndefined();
  });
});
