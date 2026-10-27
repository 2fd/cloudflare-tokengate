// "Connect your jobs": the copy-ready CI configuration of a credential access rule, with its audience, this
// gateway's origin and the slug of its credential (A14.2, A14.5). The snippet is plain
// text in a focusable ui CodeBlock that selects as a whole (user-select: all), so no script is needed.
import { CodeBlock } from '@tokengate/ui';
import type { CredentialAccessRule } from '../../db/types';
import type { Rule } from '../../policy/types';

// GitHub Actions expression syntax, not template literals.
const GHA_PROXY_BASE = '${{ steps.tokengate.outputs.proxy-base }}';
const GHA_TOKEN = '${{ steps.tokengate.outputs.token }}';

/**
 * A value for the copy-ready YAML snippets: plain when it cannot be misread (the default
 * `tokengate:<base32>` audience, https origins), else a double-quoted (JSON) string. Audiences are
 * printable ASCII and may contain YAML indicators such as `,`, `}`, `#`, `*` or a leading `&`.
 */
export function yamlScalar(value: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9._~/:+=@-]*$/.test(value) && !/:(\s|$)/.test(value)
    ? value
    : JSON.stringify(value);
}

/** Path characters that stay literal in the double-quoted URL of the snippet (no $, `, \ or "). */
const SNIPPET_PATH = /^\/[A-Za-z0-9._~\-/:@%+,;=]*$/;

/**
 * The call the snippet makes for a rule: its first literal operation (no wildcard), a GET one
 * first. Null when every path has a wildcard (the snippet keeps `<path>`).
 */
export function snippetCall(rules: readonly Rule[]): { method: string; path: string } | null {
  const literal = rules.filter((rule) => !rule.path.includes('*') && SNIPPET_PATH.test(rule.path));
  const get = literal.find((rule) => rule.methods.includes('GET') || rule.methods.includes('*'));
  const rule = get ?? literal[0];
  if (!rule) return null;
  return { method: get ? 'GET' : (rule.methods[0] ?? 'GET'), path: rule.path };
}

/** The snippet text. `slugs` are the slugs of the credentials the rule can use. */
export function snippetText(
  rule: Pick<CredentialAccessRule, 'profile' | 'audience'>,
  origin: string,
  slugs: readonly string[],
  environment?: string | null,
  call?: { method: string; path: string } | null,
): string {
  const [first, ...others] = slugs;
  const slug = first ?? '<token-slug>';
  const path = call ? call.path : '/<path>';
  const base = `${origin}/proxy/${slug}`;
  const method = call && call.method !== 'GET' ? ` -X ${call.method}` : '';
  const more = others.length > 0 ? `  # also: ${others.join(', ')}\n` : '';
  if (rule.profile === 'github-actions') {
    return `jobs:
  call-api:
    runs-on: ubuntu-latest
${environment ? `    environment: ${yamlScalar(environment)}\n` : ''}    permissions: { id-token: write, contents: read }
    steps:
      - id: tokengate
        uses: 2fd/cloudflare-tokengate/actions/get-token@main   # pin to a full commit SHA in production
        with: { audience: ${yamlScalar(rule.audience)}, url: ${yamlScalar(origin)} }
      - run: >-
          curl -sS --fail-with-body${method}
          -H "x-tokengate-token: ${GHA_TOKEN}"
          "${GHA_PROXY_BASE}/${slug}${path}"
${more}`;
  }
  if (rule.profile === 'gitlab-ci') {
    return `call-api:
${environment ? `  environment: ${yamlScalar(environment)}\n` : ''}  id_tokens:
    TOKENGATE_TOKEN:
      aud: ${yamlScalar(rule.audience)}
  script:
    - curl -sS --fail-with-body${method} -H "x-tokengate-token: $TOKENGATE_TOKEN" "${base}${path}"
${more}`;
  }
  if (rule.profile === 'vercel') {
    // A function or build of the project; @vercel/oidc exchanges its token for this audience.
    const init = call && call.method !== 'GET' ? `method: ${JSON.stringify(call.method)}, ` : '';
    return `import { getVercelOidcToken } from '@vercel/oidc';

const token = await getVercelOidcToken({ audience: ${JSON.stringify(rule.audience)} });
const response = await fetch(${JSON.stringify(`${base}${path}`)}, {
  ${init}headers: { 'x-tokengate-token': token },
});
${more.replace(/^ {2}#/, '//')}`;
  }
  return `# Mint an OIDC token with audience ${rule.audience}, then:
curl -sS --fail-with-body${method} -H "x-tokengate-token: $OIDC_TOKEN" "${base}${path}"
${more.replace(/^ {2}/, '')}`;
}

export function RuleSnippet(props: {
  rule: Pick<CredentialAccessRule, 'profile' | 'audience'>;
  origin: string;
  slugs: readonly string[];
  environment?: string | null;
  /** The access's own call, in place of `<path>`. */
  call?: { method: string; path: string } | null;
}) {
  return (
    <>
      <CodeBlock label="Workflow snippet" caption="Workflow snippet (click to select, then copy)">
        {snippetText(props.rule, props.origin, props.slugs, props.environment, props.call)}
      </CodeBlock>
      <p class="hint">
        Audience <code>{props.rule.audience}</code>. Gateway <code>{props.origin}</code>.
        {props.slugs.length === 0 ? (
          <> Replace &lt;token-slug&gt; once this credential access rule can use a token.</>
        ) : null}
      </p>
    </>
  );
}
