import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  idWithLabelText,
  labelFor,
  listClaimLabels,
  parseIdWithLabel,
  parseIdWithLabelList,
  repositoryLabelOptions,
  resolveIdWithLabel,
} from '../../../src/db/claim-labels';
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

describe('the ID input format: name (ID)', () => {
  it.each([
    ['acme/api (987654321)', { id: '987654321', label: 'acme/api' }],
    ['  acme/api(987654321) ', { id: '987654321', label: 'acme/api' }],
    ['acme/api #987654321', { id: '987654321', label: 'acme/api' }],
    ['987654321', { id: '987654321', label: null }],
    ['#987654321', { id: '987654321', label: null }],
    // Above 2^53: the digits are kept exactly, never through Number.
    ['big/repo (12345678901234567890)', { id: '12345678901234567890', label: 'big/repo' }],
  ])('parses %j', (raw, expected) => {
    expect(parseIdWithLabel(raw)).toEqual(expected);
  });

  it.each(['', 'acme/api', 'acme/api (12a)', '(123)', 'acme (123456789012345678901)', '12 34'])(
    'refuses %j',
    (raw) => {
      expect(parseIdWithLabel(raw)).toBeNull();
    },
  );

  // Workers freeze timers during synchronous code, so the guard is the test timeout: a quadratic
  // parse of 256 KiB of spaces takes tens of seconds, the linear one milliseconds.
  it('parses a long field in linear time (no regex backtracking on long space runs)', () => {
    const spaces = ' '.repeat(256 * 1024);
    expect(parseIdWithLabel(`a${spaces}b`)).toBeNull();
    expect(parseIdWithLabel(`a${spaces}(123)`)).toEqual({ id: '123', label: 'a' });
    expect(parseIdWithLabel(`a${spaces}#123`)).toEqual({ id: '123', label: 'a' });
    expect(parseIdWithLabel('('.repeat(256 * 1024))).toBeNull();
  });

  it('parses lists and refuses a list with one bad entry', () => {
    expect(parseIdWithLabelList('acme (1234567), acme-labs (7654321),')).toEqual([
      { id: '1234567', label: 'acme' },
      { id: '7654321', label: 'acme-labs' },
    ]);
    expect(parseIdWithLabelList('acme (1234567), acme-labs')).toBeNull();
  });

  it('accepts a bare ID only when the consumer already has a label for it', () => {
    const labels = [
      {
        caller_provider_id: 'cpr_x',
        claim: 'repository_id' as const,
        value: '42',
        label: 'acme/api',
        updated_at: 1,
        updated_by: null,
      },
    ];
    expect(resolveIdWithLabel({ id: '42', label: null }, labels, 'repository_id')).toEqual({
      id: '42',
      label: 'acme/api',
    });
    expect(resolveIdWithLabel({ id: '43', label: null }, labels, 'repository_id')).toBeNull();
    expect(resolveIdWithLabel({ id: '42', label: null }, labels, 'project_id')).toBeNull();
    expect(resolveIdWithLabel({ id: '42', label: 'acme/new' }, labels, 'repository_id')).toEqual({
      id: '42',
      label: 'acme/new',
    });
    expect(idWithLabelText('42', 'acme/api')).toBe('acme/api (42)');
    expect(idWithLabelText('42', null)).toBe('42');
  });
});
