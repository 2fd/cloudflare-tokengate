// Policy-level regressions from the authorization audit, run against the shipped profiles:
// rule paths (trailing slash, %2F), method-override query parameters, GitLab inherited
// pipeline sources and anchor rules re-checked at request time.
import { describe, expect, it } from 'vitest';
import { PROFILES } from '../../src/identity/profiles';
import type { Claims } from '../../src/identity/types';
import { credentialRuleDecision } from '../../src/policy/access-rules';
import type { PolicyCredentialRule } from '../../src/policy/limits';
import type { Condition, Rule } from '../../src/policy/types';
import { validateCredentialAccessRule } from '../../src/policy/validate-rules';
import { buildUpstreamUrl, canonicalizePath } from '../../src/proxy/path';
import { setupProxy } from '../helpers/proxy-fixtures';
import { credentialRule, facts } from '../unit/policy/access-rule-fixtures';

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

/** Decides one credential access rule the way the proxy does: canonical path first, then its own policy. */
function decide(
  rules: Rule[],
  method: string,
  rawPath: string,
  conditions: Condition[] = githubAnchor,
): 'allow' | 'deny' {
  const canonical = canonicalizePath(rawPath);
  if (!canonical.ok) throw new Error(`invalid path ${rawPath}`);
  const own = credentialRuleDecision(
    credentialRule({ conditions, rules }),
    github,
    facts(githubClaims, { method, path: canonical.path, matchPath: canonical.matchPath }),
  );
  return own.result === 'matched' ? 'allow' : 'deny';
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
  const evaluate = (pipelineSource: string, ruleConditions: Condition[]) =>
    credentialRuleDecision(
      gitlabRule({ conditions: ruleConditions, rules }),
      gitlab,
      facts(
        { namespace_id: 10, project_id: 42, pipeline_source: pipelineSource },
        { method: 'POST', path: '/deploy', matchPath: '/deploy' },
      ),
    );

  // A merge request pipeline (including a fork MR run in the parent project) can start a child
  // pipeline whose jobs report `parent_pipeline` with the parent project's IDs.
  it.each(['parent_pipeline', 'pipeline', 'merge_request_event'])(
    'pipeline_source=%s is denied without an opt-in',
    (source) => {
      expect(evaluate(source, conditions)).toMatchObject({ result: 'event_not_trusted' });
    },
  );

  it('an exact opt-in admits it, with a warning unless ref_protected=true is required', () => {
    const optIn: Condition[] = [
      ...conditions,
      { claim: 'pipeline_source', match: 'exact', values: ['parent_pipeline'] },
    ];
    expect(evaluate('parent_pipeline', optIn).result).toBe('matched');

    const validate = (ruleConditions: Condition[]) => {
      const {
        id: _id,
        issuer_key: _key,
        ...input
      } = gitlabRule({ conditions: ruleConditions, rules });
      return validateCredentialAccessRule({ ...input, name: 'GitLab' }, gitlab, null, {
        injection: { kind: 'bearer' },
        rules: [],
      });
    };
    const warned = validate(optIn);
    expect(warned.errors).toEqual([]);
    expect(warned.warnings.join('\n')).toContain('ref_protected exact true');
    expect(warned.warnings.join('\n')).toContain('"parent_pipeline" pipelines can be started');

    const protectedOnly: Condition[] = [
      ...optIn,
      { claim: 'ref_protected', match: 'exact', values: ['true'] },
    ];
    expect(validate(protectedOnly).warnings.join('\n')).not.toContain('pipelines can be started');
  });
});

describe('I-AUTHZ-2: an access rule that no longer satisfies the anchor rules does not authorize', () => {
  // Generic anchor rules come from the access rule's own anchor_claims; a row can be changed after
  // its conditions were saved against the old list.
  const evaluate = (anchorClaims: string[]) =>
    credentialRuleDecision(
      credentialRule({
        profile: 'generic',
        tenant_pin: [],
        anchor_claims: anchorClaims,
        conditions: [{ claim: 'email', match: 'exact', values: ['a@x.com'] }],
        rules: [{ methods: ['GET'], path: '/**' }],
      }),
      generic,
      facts(
        { sub: 's', email: 'a@x.com', oid: 'o-1' },
        { method: 'GET', path: '/x', matchPath: '/x' },
      ),
    );

  it('allows while email is an anchor claim, denies once anchor_claims is changed to oid', () => {
    expect(evaluate(['email']).result).toBe('matched');
    expect(evaluate(['oid']).result).toBe('invalid_rule');
  });

  it('a GitHub access rule stored without repository_id or job_workflow_ref is skipped', () => {
    const ownerOnly: Condition[] = [githubAnchor[0] as Condition];
    expect(decide([{ methods: ['GET'], path: '/**' }], 'GET', '/x', ownerOnly)).toBe('deny');
  });
});

function gitlabRule(overrides: Partial<PolicyCredentialRule> = {}): PolicyCredentialRule {
  return credentialRule({
    id: 'acr_01JTESTGITLAB0000000000000',
    profile: 'gitlab-ci',
    issuer: 'https://gitlab.com',
    issuer_key: 'https://gitlab.com',
    jwks_uri: 'https://gitlab.com/oauth/discovery/keys',
    tenant_pin: [{ claim: 'namespace_id', match: 'exact', values: ['10'] }],
    ...overrides,
  });
}

describe('I-AUTHZ-1: path and method rules end to end through the proxy', () => {
  const errorOf = (response: Response) => response.headers.get('x-tokengate-error');

  it('DELETE /projects/42/ is refused by `DELETE /projects/42/**` and never reaches upstream', async () => {
    const fx = await setupProxy({
      rule: { rules: [{ methods: ['DELETE'], path: '/projects/42/**' }] },
    });
    const parent = await fx.call('/projects/42/', { method: 'DELETE' });
    expect(parent.status).toBe(403);
    expect(errorOf(parent)).toBe('no_matching_rule');
    expect(fx.upstreamCalls).toHaveLength(0);
    expect((await fx.call('/projects/42/branches/x', { method: 'DELETE' })).status).toBe(200);
  });

  it('a %2F identifier cannot satisfy `*`-then-literal rules', async () => {
    const fx = await setupProxy({
      rule: { rules: [{ methods: ['DELETE'], path: '/projects/*/pipelines/*' }] },
    });
    const response = await fx.call('/projects/grp%2Fpipelines%2Fx', { method: 'DELETE' });
    expect(response.status).toBe(403);
    expect(fx.upstreamCalls).toHaveLength(0);
  });

  it('POST with ?_method=DELETE is refused with 400 path_invalid before any upstream call', async () => {
    const fx = await setupProxy({ rule: { rules: [{ methods: ['POST'], path: '/items/*' }] } });
    const response = await fx.call('/items/1?_method=DELETE', { method: 'POST', body: '{}' });
    expect(response.status).toBe(400);
    expect(errorOf(response)).toBe('path_invalid');
    expect(fx.upstreamCalls).toHaveLength(0);
    expect((await fx.call('/items/1?q=1', { method: 'POST', body: '{}' })).status).toBe(200);
  });
});
