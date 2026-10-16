# Anthropic API

This page shows admins how to set up an Anthropic service and shows workflow authors how to point the Anthropic SDKs at the gateway.

## Service template

In the admin UI, open **Service tokens**, select **Add a token** and open the **Anthropic API** card. Paste the API key and select **Check and save Anthropic**. Everything in the table comes from the template (`apps/gateway/src/admin/service-templates.ts`); the form does not ask for it. Name and slug are optional: when empty, the gateway uses `Anthropic` and the slug below, or the next free one (`anthropic-2`).

| Field | Template value |
|---|---|
| Slug | `anthropic` |
| Base URL | `https://api.anthropic.com` (no `/v1`: the SDKs add it) |
| How the secret is sent | Custom header `x-api-key`, no prefix |
| Extra headers consumers may send | `anthropic-version`, `anthropic-beta` |
| Timeout (milliseconds) | `600000` |
| Secret check | `GET /v1/models` with `anthropic-version: 2023-06-01`, expect `200` |
| Suggested grant rule | `POST /v1/messages` |
| Host for the upstream host allowlist | `api.anthropic.com` |

If **Service tokens › Allowed hosts** is set and does not include `api.anthropic.com`, the card says so before you type anything. An owner ticks **Also allow api.anthropic.com in Allowed hosts** in the same form; anyone else asks an owner ([configuration](../configuration.md#upstream-host-allowlist)).

Reference: <https://docs.anthropic.com/en/api/overview>.

## Base URL for SDKs

The Anthropic SDKs add `/v1` to every path themselves (`/v1/messages`), so the template's base URL has no `/v1`.
Callers set the SDK base URL to `<gateway>/proxy/anthropic`, and grant rules include the `/v1` prefix, for example `POST /v1/messages`.

## Call it

The examples read the caller token in one of two ways. `$(tokengate-token)` works only in GitHub Actions jobs that ran the [get-token action](../callers/github-actions.md#2-mint-the-token-with-the-composite-action).
`TOKENGATE_TOKEN` is a variable that holds a caller token. In GitHub Actions, set it from `steps.<id>.outputs.token`. In GitLab CI, name the `id_tokens` entry `TOKENGATE_TOKEN`.

### curl

```bash
curl -sS --fail-with-body "$TOKENGATE_URL/proxy/anthropic/v1/messages" \
  -H "x-tokengate-token: $(tokengate-token)" \
  -H 'anthropic-version: 2023-06-01' \
  -H 'content-type: application/json' \
  -d '{"model":"claude-sonnet-5-5","max_tokens":256,"messages":[{"role":"user","content":"Hello"}]}'
```

### Node.js (`@anthropic-ai/sdk`)

```js
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({
  apiKey: process.env.TOKENGATE_TOKEN,
  baseURL: `${process.env.TOKENGATE_URL}/proxy/anthropic`,
});
const message = await anthropic.messages.create({
  model: 'claude-sonnet-5-5',
  max_tokens: 256,
  messages: [{ role: 'user', content: 'Hello' }],
});
```

### Python (`anthropic`)

```python
import os
from anthropic import Anthropic

client = Anthropic(
    api_key=os.environ["TOKENGATE_TOKEN"],
    base_url=f"{os.environ['TOKENGATE_URL']}/proxy/anthropic",
)
message = client.messages.create(
    model="claude-sonnet-5-5",
    max_tokens=256,
    messages=[{"role": "user", "content": "Hello"}],
)
```

Both SDKs also read `ANTHROPIC_BASE_URL` and `ANTHROPIC_API_KEY` from the environment.

## Caller token header

The SDKs send the API key in `x-api-key`. That is this service's injection header, so the gateway accepts the caller token there when no `x-tokengate-token` or `Authorization: Bearer` header is present (`apps/gateway/src/proxy/caller-token.ts`).
The gateway never forwards the caller's `x-api-key`; it sets its own with the service credential ([I-TOK-1](../threat-model.md#i-tok-1), [I-INJ-1](../threat-model.md#i-inj-1)).

| Client | Header |
|---|---|
| curl | `x-tokengate-token` |
| SDK with `apiKey` / `api_key` = caller token | `x-api-key` |
| SDK with `authToken` / `auth_token` = caller token | `Authorization: Bearer` |

Accepting the caller token in `x-api-key` lets an unauthenticated client learn that a service uses header injection. See [known limitations](../threat-model.md#callers-and-tokens).

## Starter rules

With the SDK setup (base URL `https://api.anthropic.com`):

```text
POST /v1/messages
POST /v1/messages/count_tokens
```

With the template base URL, drop the `/v1` prefix. Every grant also needs conditions. See [policies.md](../policies.md).

## Gotchas

- **`anthropic-version` is required.** The SDKs send it. With curl, set it yourself. The gateway forwards it because the template lists it.
- **Beta features** use `anthropic-beta`, which the template also forwards. Other non-standard headers are dropped unless you add them to **Extra headers callers may send (optional)**.
- **Streaming.** Responses stream through unchanged. **Timeout (milliseconds)** limits only the wait for response headers.
- **Response bodies are not filtered.** Whatever the API returns reaches the caller ([threat-model.md](../threat-model.md#credentials-and-responses)).
- **Long jobs.** GitHub caller tokens expire after about 5 minutes. Create a new client with a fresh token for each group of calls. See [github-actions.md](../callers/github-actions.md#long-jobs).
- **Credential rotation.** See [credential-rotation.md](../operations/credential-rotation.md).
