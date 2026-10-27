# tokengate get-token

Composite action that mints a GitHub Actions OIDC token for a
[cloudflare-tokengate](../../README.md) deployment.

```yaml
permissions:
  id-token: write   # required to mint OIDC tokens
  contents: read

steps:
  - id: tokengate
    uses: 2fd/cloudflare-tokengate/actions/get-token@main   # pin to a full commit SHA in production
    with:
      url: ${{ vars.TOKENGATE_URL }}
      audience: ${{ vars.TOKENGATE_AUDIENCE }}

  - name: Post to Slack through the gateway
    env:
      TOKEN: ${{ steps.tokengate.outputs.token }}
      PROXY: ${{ steps.tokengate.outputs.proxy-base }}
    run: |
      curl -sS --fail-with-body "$PROXY/slack/chat.postMessage" \
        -H "x-tokengate-token: $TOKEN" \
        -H 'content-type: application/json' \
        -d '{"channel":"C0123456789","text":"Deployed"}'
```

## Outputs

| Output | Description |
|---|---|
| `token` | OIDC token (masked). GitHub issues tokens valid for about 5 minutes. |
| `url` | Gateway URL without trailing slash. |
| `proxy-base` | `<url>/proxy`; append `/<type-slug>/<path>`. The slug names a credential type, never one credential; the access rules pick the credential. The path is relative to the base URL of the type: for the Slack template (`https://slack.com/api`), `/slack/chat.postMessage` reaches `https://slack.com/api/chat.postMessage`. |

The action also exports `TOKENGATE_URL` and `TOKENGATE_AUDIENCE` to later steps and puts a
`tokengate-token` command on `PATH`. Call it whenever you need a fresh token, for example in
jobs longer than a few minutes. Each call prints the token on stdout and registers it with the
runner's log masker (an `::add-mask::` command on stderr), so `$(tokengate-token)` stays clean and
later log lines show `***` instead of the token. The token is bound to the gateway's audience and
expires within minutes.

Masking only covers the exact value in step logs. Still do not log or store the token: encoded or
partial copies (base64, substrings) are not masked, files and artifacts are never masked, and
masking does not work while `::stop-commands::` is active. Do not redirect the helper's stderr:
`2>/dev/null` drops the mask command, and `2>&1` inside `$(...)` puts it into the captured value.

```bash
curl -H "x-tokengate-token: $(tokengate-token)" "$TOKENGATE_URL/proxy/openai/models"
```

## Reusable workflows

In a reusable workflow, `vars`, `inputs` and inherited secrets come from the calling repository
([GitHub docs](https://docs.github.com/en/actions/reference/workflows-and-actions/variables)).
If a grant pins that workflow with `job_workflow_ref`, write `url` as a literal in the called workflow, not
`${{ vars.TOKENGATE_URL }}`. Otherwise any calling repository can send the token to its own host and replay
it against the gateway. See
[Central reusable workflow](../../docs/callers/github-actions.md#central-reusable-workflow-for-the-organization).

## Troubleshooting

- `No OIDC token available`: add `permissions: id-token: write` to the job. Pull requests from
  forks never receive OIDC tokens.
- `input 'url' must be an https:// URL` or `input 'audience' must be non-empty`: the action refuses
  values with whitespace or line breaks (they would inject lines into `GITHUB_ENV`). Check that
  `vars.TOKENGATE_URL` and `vars.TOKENGATE_AUDIENCE` are set and have no trailing newline.
- A response without an `x-tokengate-request-id` header came from Cloudflare, not from the
  gateway (for example Bot Fight Mode). See
  [docs/operations/cloudflare-zone-settings.md](../../docs/operations/cloudflare-zone-settings.md).
- Gateway errors carry `x-tokengate-error: <code>`; see [docs/errors.md](../../docs/errors.md).
