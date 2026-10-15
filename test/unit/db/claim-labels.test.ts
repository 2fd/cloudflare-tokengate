import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { labelFor, listClaimLabels, repositoryLabelOptions } from '../../../src/db/claim-labels';
import type { CallerProvider } from '../../../src/db/types';
import { opsDeps, resetControlPlane, seedGithubProvider } from '../admin/ops/helpers';

let a: CallerProvider;
let b: CallerProvider;

async function label(providerId: string, claim: string, value: string, text: string) {
  await env.DB.prepare(
    `INSERT INTO claim_labels (caller_provider_id, claim, value, label, updated_at, updated_by)
     VALUES (?, ?, ?, ?, 1, 'usr_x')`,
  )
    .bind(providerId, claim, value, text)
    .run();
}

beforeEach(async () => {
  await resetControlPlane();
  const deps = opsDeps();
  a = await seedGithubProvider(deps);
  const other = await env.DB.prepare(
    `INSERT INTO caller_providers (id, name, profile, issuer, jwks_uri, audience, allowed_algs,
       max_token_age_seconds, created_at, updated_at)
     VALUES ('cpr_other', 'GitLab', 'gitlab-ci', 'https://gitlab.com', 'https://gitlab.com/oauth/discovery/keys',
       'tokengate:abcdefghijklmnop', '["RS256"]', 900, 1, 1) RETURNING *`,
  ).first<CallerProvider>();
  if (!other) throw new Error('insert failed');
  b = other;
  await label(a.id, 'repository_owner_id', '4242', 'acme');
  await label(a.id, 'repository_id', '987654321', 'acme/api');
  await label(a.id, 'repository_id', '11', 'acme/web');
  await label(b.id, 'project_id', '77', 'group/project');
});

describe('claim labels', () => {
  it('lists the labels of one caller provider, or of all', async () => {
    const own = await listClaimLabels(env.DB, a.id);
    expect(own.map((row) => [row.claim, row.value, row.label])).toEqual([
      ['repository_id', '11', 'acme/web'],
      ['repository_id', '987654321', 'acme/api'],
      ['repository_owner_id', '4242', 'acme'],
    ]);
    expect(own[0]).toMatchObject({ caller_provider_id: a.id, updated_at: 1, updated_by: 'usr_x' });
    expect(await listClaimLabels(env.DB)).toHaveLength(4);
  });

  it('labelFor finds the label of a claim value', async () => {
    const labels = await listClaimLabels(env.DB, a.id);
    expect(labelFor(labels, 'repository_id', '987654321')).toBe('acme/api');
    expect(labelFor(labels, 'repository_owner_id', '987654321')).toBeNull();
    expect(labelFor(labels, 'repository_id', '1')).toBeNull();
  });

  it('repository options are repositories and projects as "name (ID)", by name', async () => {
    expect((await repositoryLabelOptions(env.DB)).map((option) => option.text)).toEqual([
      'acme/api (987654321)',
      'acme/web (11)',
      'group/project (77)',
    ]);
    expect((await repositoryLabelOptions(env.DB, b.id)).map((option) => option.text)).toEqual([
      'group/project (77)',
    ]);
  });
});
