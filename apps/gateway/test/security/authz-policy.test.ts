// Policy-level regressions from the authorization audit, run against the shipped profiles:
// rule paths (trailing slash, %2F), method-override query parameters, GitLab inherited
// pipeline sources and anchor rules re-checked at request time.
import { describe, expect, it } from 'vitest';
import type { CredentialAccessRule } from '../../src/db/types';
import { PROFILES } from '../../src/identity/profiles';
import type { Claims } from '../../src/identity/types';
import { type EvaluationInput, evaluateIssuerAccessRules } from '../../src/policy/evaluate';
import type { Condition, Rule } from '../../src/policy/types';
import { validateIssuerAccessRule } from '../../src/policy/validate';
import { buildUpstreamUrl, canonicalizePath } from '../../src/proxy/path';
import { setupProxy } from '../helpers/proxy-fixtures';

const github = PROFILES['github-actions'];
const gitlab = PROFILES['gitlab-ci'];
const generic = PROFILES.generic;

const githubAnchor: Condition[] = [
  { claim: 'repository_owner_id', match: 'exact', values: ['1000'] },
  { claim: 'repository_id', match: 'exact', values: ['2000'] },
];
const githubClaims: Claims = {
  repository_owner_id: '1000',
  repository_id: '2000',
  event_name: 'push',
};

/** Evaluates one grant the way the proxy does: canonical path first, then the issuer_access_rules. */
function decide(
  rules: Rule[],
  method: string,
  rawPath: string,
  overrides: Partial<EvaluationInput> = {},
  conditions: Condition[] = githubAnchor,
) {
  const canonical = canonicalizePath(rawPath);
  if (!canonical.ok) throw new Error(`invalid path ${rawPath}`);
  return evaluateIssuerAccessRules([{ id: 'grt_a', conditions, rules }], {
    claims: githubClaims,
    profile: github,
    provider: { anchor_claims: [] },
    method,
    path: canonical.path,
    matchPath: canonical.matchPath,
    revealClaims: new Set(),
    ...overrides,
  }).decision;
}

describe('I-AUTHZ-1: a wildcard never authorizes the parent resource through a trailing slash', () => {
  // GitLab, Rails and Express (non-strict) route `/projects/42/` to `/projects/42`.
  it('`DELETE /projects/42/**` does not allow `DELETE /projects/42/`', () => {
    const rules: Rule[] = [{ methods: ['DELETE'], path: '/projects/42/**' }];
    expect(decide(rules, 'DELETE', '/projects/42/')).toBe('deny');
    expect(decide(rules, 'DELETE', '/projects/42')).toBe('deny');
    expect(decide(rules, 'DELETE', '/projects/42/branches/x')).toBe('allow');
    expect(decide(rules, 'DELETE', '/projects/42/branches/')).toBe('allow');
  });

  it('`GET /v1/users/*` does not allow the collection `/v1/users/`', () => {
    const rules: Rule[] = [{ methods: ['GET'], path: '/v1/users/*' }];
    expect(decide(rules, 'GET', '/v1/users/')).toBe('deny');
    expect(decide(rules, 'GET', '/v1/users/7')).toBe('allow');
  });

  it('a rule ending in a literal "/" still allows the trailing-slash form', () => {
    expect(decide([{ methods: ['GET'], path: '/v1/users/' }], 'GET', '/v1/users/')).toBe('allow');
    expect(decide([{ methods: ['GET'], path: '/v1/*/' }], 'GET', '/v1/users/')).toBe('allow');
  });
});

describe('I-AUTHZ-1: a rule must match %2F both as a separator and as data', () => {
  // GitLab reads `grp%2Fpipelines%2Fx` as one project `:id`; GitHub contents reads it as "/".
  it('`DELETE /projects/*/pipelines/*` does not allow a project delete through %2F', () => {
    const rules: Rule[] = [{ methods: ['DELETE'], path: '/projects/*/pipelines/*' }];
    expect(decide(rules, 'DELETE', '/projects/grp%2Fpipelines%2Fx')).toBe('deny');
    expect(decide(rules, 'DELETE', '/projects/7/pipelines/9')).toBe('allow');
  });

  it('`**` keeps allowing %2F paths under it (GitHub contents API)', () => {
    const rules: Rule[] = [{ methods: ['GET'], path: '/repos/o/r/contents/**' }];
    expect(decide(rules, 'GET', '/repos/o/r/contents/dir%2Ffile')).toBe('allow');
  });

  it('`*` does not reach into a subdirectory through %2F', () => {
    const rules: Rule[] = [{ methods: ['GET'], path: '/repos/o/r/contents/*' }];
    expect(decide(rules, 'GET', '/repos/o/r/contents/dir%2Ffile')).toBe('deny');
  });
});

describe('I-AUTHZ-1: method-override query parameters are refused', () => {
  const build = (search: string) =>
    buildUpstreamUrl({
      baseUrl: 'https://api.example.com',
      path: '/items/1',
      search,
      injection: { kind: 'bearer' },
      secret: 's',
    }).ok;

  it.each([
    '?_method=DELETE',
    '?_Method=DELETE',
    '?%5Fmethod=DELETE',
    '?a=1;_method=DELETE',
    '?.method=DELETE',
    '?_method[]=DELETE',
    // PHP cuts names at NUL: `$_GET['_method']`.
    '?_method%00x=DELETE',
    '?X-HTTP-Method-Override=DELETE',
    '?x-http-method=PUT',
    '?x-method-override=PATCH',
  ])('%s', (search) => {
    expect(build(search)).toBe(false);
  });

  it('ordinary queries are still forwarded', () => {
    expect(build('?method=x&q=_method')).toBe(true);
  });
});

describe('I-AUTHZ-3: GitLab child and downstream pipelines need an explicit opt-in', () => {
  const conditions: Condition[] = [
    { claim: 'namespace_id', match: 'exact', values: ['10'] },
    { claim: 'project_id', match: 'exact', values: ['42'] },
  ];
  const rules: Rule[] = [{ methods: ['POST'], path: '/deploy' }];
  const evaluate = (pipelineSource: string, grantConditions: Condition[]) =>
    evaluateIssuerAccessRules([{ id: 'grt_a', conditions: grantConditions, rules }], {
      claims: { namespace_id: 10, project_id: 42, pipeline_source: pipelineSource },
      profile: gitlab,
      provider: { anchor_claims: [] },
      method: 'POST',
      path: '/deploy',
      matchPath: '/deploy',
      revealClaims: new Set(),
    });

  // A merge request pipeline (including a fork MR run in the parent project) can start a child
  // pipeline whose jobs report `parent_pipeline` with the parent project's IDs.
  it.each(['parent_pipeline', 'pipeline', 'merge_request_event'])(
    'pipeline_source=%s is denied without an opt-in',
    (source) => {
      expect(evaluate(source, conditions)).toMatchObject({
        decision: 'deny',
        code: 'event_not_trusted',
      });
    },
  );

  it('an exact opt-in admits it, with a warning unless ref_protected=true is required', () => {
    const optIn: Condition[] = [
      ...conditions,
      { claim: 'pipeline_source', match: 'exact', values: ['parent_pipeline'] },
    ];
    expect(evaluate('parent_pipeline', optIn).decision).toBe('allow');

    const provider = gitlabProvider();
    const warned = validateIssuerAccessRule({ conditions: optIn, rules }, gitlab, provider);
    expect(warned.errors).toEqual([]);
    expect(warned.warnings.join('\n')).toContain('ref_protected exact true');
    expect(warned.warnings.join('\n')).toContain('"parent_pipeline" pipelines can be started');

    const protectedOnly: Condition[] = [
      ...optIn,
      { claim: 'ref_protected', match: 'exact', values: ['true'] },
    ];
    const quiet = validateIssuerAccessRule({ conditions: protectedOnly, rules }, gitlab, provider);
    expect(quiet.warnings.join('\n')).not.toContain('pipelines can be started');
  });
});

describe('I-AUTHZ-2: a grant that no longer satisfies the anchor rules does not authorize', () => {
  // Generic anchor rules come from the credential access rule; an admin can change anchor_claims after
  // issuer_access_rules were saved against the old list.
  const emailIssuerAccessRule = {
    id: 'grt_email',
    conditions: [{ claim: 'email', match: 'exact', values: ['a@x.com'] }] as Condition[],
    rules: [{ methods: ['GET'], path: '/**' }] as Rule[],
  };
  const evaluate = (anchorClaims: string[]) =>
    evaluateIssuerAccessRules([emailIssuerAccessRule], {
      claims: { sub: 's', email: 'a@x.com', oid: 'o-1' },
      profile: generic,
      provider: { anchor_claims: anchorClaims },
      method: 'GET',
      path: '/x',
      matchPath: '/x',
      revealClaims: new Set(),
    });

  it('allows while email is an anchor claim, denies once anchor_claims is changed to oid', () => {
    expect(evaluate(['email']).decision).toBe('allow');
    const after = evaluate(['oid']);
    expect(after).toMatchObject({ decision: 'deny', code: 'no_matching_grant' });
    expect(after.trace[0]?.result).toBe('invalid_grant');
  });

  it('a GitHub grant stored without repository_id or job_workflow_ref is skipped', () => {
    const ownerOnly: Condition[] = [githubAnchor[0] as Condition];
    expect(decide([{ methods: ['GET'], path: '/**' }], 'GET', '/x', {}, ownerOnly)).toBe('deny');
  });
});

function gitlabProvider(): CredentialAccessRule {
  return {
    credential_id: 'svc_test',
    conditions: [],
    id: 'cpr_01JTESTGITLAB0000000000000',
    name: 'GitLab',
    profile: 'gitlab-ci',
    issuer: 'https://gitlab.com',
    jwks_uri: 'https://gitlab.com/oauth/discovery/keys',
    audience: 'tokengate:01JTESTAUDIENCE00000000000',
    allowed_algs: ['RS256'],
    max_token_age_seconds: 600,
    tenant_pin: [{ claim: 'namespace_id', match: 'exact', values: ['10'] }],
    anchor_claims: [],
    enabled: true,
    created_at: 0,
    updated_at: 0,
  };
}

describe('I-AUTHZ-1: path and method rules end to end through the proxy', () => {
  const errorOf = (response: Response) => response.headers.get('x-tokengate-error');

  it('DELETE /projects/42/ is refused by `DELETE /projects/42/**` and never reaches upstream', async () => {
    const fx = await setupProxy({
      grant: { rules: [{ methods: ['DELETE'], path: '/projects/42/**' }] },
    });
    const parent = await fx.call('/projects/42/', { method: 'DELETE' });
    expect(parent.status).toBe(403);
    expect(errorOf(parent)).toBe('no_matching_grant');
    expect(fx.upstreamCalls).toHaveLength(0);
    expect((await fx.call('/projects/42/branches/x', { method: 'DELETE' })).status).toBe(200);
  });

  it('a %2F identifier cannot satisfy `*`-then-literal rules', async () => {
    const fx = await setupProxy({
      grant: { rules: [{ methods: ['DELETE'], path: '/projects/*/pipelines/*' }] },
    });
    const response = await fx.call('/projects/grp%2Fpipelines%2Fx', { method: 'DELETE' });
    expect(response.status).toBe(403);
    expect(fx.upstreamCalls).toHaveLength(0);
  });

  it('POST with ?_method=DELETE is refused with 400 path_invalid before any upstream call', async () => {
    const fx = await setupProxy({ grant: { rules: [{ methods: ['POST'], path: '/items/*' }] } });
    const response = await fx.call('/items/1?_method=DELETE', { method: 'POST', body: '{}' });
    expect(response.status).toBe(400);
    expect(errorOf(response)).toBe('path_invalid');
    expect(fx.upstreamCalls).toHaveLength(0);
    expect((await fx.call('/items/1?q=1', { method: 'POST', body: '{}' })).status).toBe(200);
  });
});
