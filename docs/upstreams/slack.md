# Slack Web API

This page shows admins how to set up a Slack Web API service and shows workflow authors how to call it through the gateway.
For Slack incoming webhooks, see [webhooks.md](webhooks.md).

## Service template

In the admin UI, open **Services**, select **Add a service** and choose the **Slack Web API** template (`src/admin/service-templates.ts`).

| Field | Template value |
|---|---|
| Slug | `slack` |
| Base URL | `https://slack.com/api` |
| How the credential is sent | Bearer token (`Authorization: Bearer <credential>`) |
| Extra headers callers may send | none |
| Timeout (milliseconds) | `30000` |
| Credential check | `POST /auth.test`, expect `200` and `"ok": true` |
| Suggested grant rule | `POST /chat.postMessage` |
| Host for the upstream host allowlist | `slack.com` (`*.slack.com` does not match it) |

If the upstream host allowlist in Settings is set, add the host to it before you create the service ([configuration](../configuration.md#upstream-host-allowlist)). Otherwise saving the service fails.

Use a bot token (`xoxb-REDACTED`). The credential check calls `auth.test`, because Slack answers a bad token with HTTP 200 and `"ok": false`.

## Call it

The examples read the caller token in one of two ways. `$(tokengate-token)` works only in GitHub Actions jobs that ran the [get-token action](../callers/github-actions.md#2-mint-the-token-with-the-composite-action).
`TOKENGATE_TOKEN` is a variable that holds a caller token. In GitHub Actions, set it from `steps.<id>.outputs.token`. In GitLab CI, name the `id_tokens` entry `TOKENGATE_TOKEN`.

Paths after `/proxy/slack` are Slack method names: `/proxy/slack/chat.postMessage` reaches `https://slack.com/api/chat.postMessage`.

### curl

```bash
curl -sS --fail-with-body "$TOKENGATE_URL/proxy/slack/chat.postMessage" \
  -H "x-tokengate-token: $(tokengate-token)" \
  -H 'content-type: application/json; charset=utf-8' \
  -d '{"channel":"C0123456789","text":"Deployed"}'
```

### Node.js (`@slack/web-api`)

Pass the caller token as the SDK token. The SDK sends it as `Authorization: Bearer`, which the gateway reads as the caller token and never forwards ([I-TOK-1](../threat-model.md#i-tok-1)).

```js
import { WebClient } from '@slack/web-api';

const slack = new WebClient(process.env.TOKENGATE_TOKEN, {
  slackApiUrl: `${process.env.TOKENGATE_URL}/proxy/slack/`,
});
await slack.chat.postMessage({ channel: 'C0123456789', text: 'Deployed' });
```

### Python (`slack_sdk`)

```python
import os
from slack_sdk import WebClient

slack = WebClient(
    token=os.environ["TOKENGATE_TOKEN"],
    base_url=f"{os.environ['TOKENGATE_URL']}/proxy/slack/",
)
slack.chat_postMessage(channel="C0123456789", text="Deployed")
```

Keep the trailing `/` in the base URL: both SDKs append the method name to it.

## Caller token header

| Client | Header |
|---|---|
| curl | `x-tokengate-token` |
| Slack SDKs | `Authorization: Bearer` (the SDK token) |

The gateway removes the caller's `Authorization` header and sets its own with the service credential ([I-INJ-1](../threat-model.md#i-inj-1)).

## Starter rules

Rules are relative to the base URL. Each Slack method is one path, so grant only the methods the job needs:

```text
POST /chat.postMessage
POST /chat.update
POST /reactions.add
```

Every grant also needs conditions. See [policies.md](../policies.md#examples) for examples, such as protected `main` pushes and the `production` environment.

## Gotchas

- **Token in the body.** Slack also accepts a `token` field in form bodies. The gateway does not read request bodies, so it cannot remove one. A caller who sends `token=…` in the body may make Slack use that token instead of the service credential. This does not expose the service credential. Do not put the caller token in the body: the gateway does not look there and answers `token_missing`.
- **Token rotation is not supported.** With Slack token rotation, bot tokens expire after 12 hours and need a refresh token. The gateway stores a static credential and never refreshes it. Use an app without token rotation. Slack does not let you turn rotation off once it is on.
- **Rate limits.** Slack's own `429` responses pass through with their `Retry-After` header and `x-tokengate-source: upstream`. A gateway `429` carries `x-tokengate-source: gateway` and `x-tokengate-error: rate_limited`.
- **Response bodies are not filtered.** Methods that return URLs or tokens in the body (for example OAuth methods) return them to the caller unchanged. Do not grant such methods. See [known limitations](../threat-model.md#credentials-and-responses); [I-RESP-1](../threat-model.md#i-resp-1) covers headers only.
- **Long jobs.** GitHub caller tokens expire after about 5 minutes. Create a new client with a fresh token for each group of calls. See [github-actions.md](../callers/github-actions.md#long-jobs).
- **Credential rotation.** To replace the bot token, see [credential-rotation.md](../operations/credential-rotation.md).

Slack Web API reference: <https://docs.slack.dev/apis/web-api/>.
