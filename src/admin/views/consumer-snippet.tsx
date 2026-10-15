// "Connect your jobs": the copy-ready CI configuration of a consumer, with its audience, this
// gateway's origin and the real token slugs of its accesses (A14.2, A14.5). The snippet is plain
// text in a focusable <pre> that selects as a whole (user-select: all), so no script is needed.
import type { CallerProvider } from '../../db/types';

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

/** The snippet text. `slugs` are the token slugs this consumer (or access) can use. */
export function snippetText(
  consumer: Pick<CallerProvider, 'profile' | 'audience'>,
  origin: string,
  slugs: readonly string[],
  environment?: string | null,
): string {
  const [first, ...others] = slugs;
  const slug = first ?? '<token-slug>';
  const more = others.length > 0 ? `  # also: ${others.join(', ')}\n` : '';
  if (consumer.profile === 'github-actions') {
    return `jobs:
  call-api:
    runs-on: ubuntu-latest
${environment ? `    environment: ${yamlScalar(environment)}\n` : ''}    permissions: { id-token: write, contents: read }
    steps:
      - id: tokengate
        uses: 2fd/cloudflare-tokengate/actions/get-token@main   # pin to a full commit SHA in production
        with: { audience: ${yamlScalar(consumer.audience)}, url: ${yamlScalar(origin)} }
      - run: >-
          curl -sS --fail-with-body
          -H "x-tokengate-token: ${GHA_TOKEN}"
          "${GHA_PROXY_BASE}/${slug}/<path>"
${more}`;
  }
  if (consumer.profile === 'gitlab-ci') {
    return `call-api:
${environment ? `  environment: ${yamlScalar(environment)}\n` : ''}  id_tokens:
    TOKENGATE_TOKEN:
      aud: ${yamlScalar(consumer.audience)}
  script:
    - curl -sS --fail-with-body -H "x-tokengate-token: $TOKENGATE_TOKEN" "${origin}/proxy/${slug}/<path>"
${more}`;
  }
  return `# Mint an OIDC token with audience ${consumer.audience}, then:
curl -sS --fail-with-body -H "x-tokengate-token: $OIDC_TOKEN" "${origin}/proxy/${slug}/<path>"
${more.replace(/^ {2}/, '')}`;
}

export function ConsumerSnippet(props: {
  consumer: Pick<CallerProvider, 'profile' | 'audience'>;
  origin: string;
  slugs: readonly string[];
  environment?: string | null;
}) {
  return (
    <>
      <p>
        Audience <code>{props.consumer.audience}</code>. Gateway <code>{props.origin}</code>.
        {props.slugs.length === 0 ? (
          <> Replace &lt;token-slug&gt; once this consumer can use a token.</>
        ) : null}
      </p>
      <pre tabindex={0} class="copyable" aria-label="CI snippet">
        {snippetText(props.consumer, props.origin, props.slugs, props.environment)}
      </pre>
    </>
  );
}
