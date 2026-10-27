# Webhooks (Slack, Discord) and other URL-path credentials

This page shows admins how to store webhook URLs as credentials and shows workflow authors how to post to them through the gateway.

A webhook URL contains its own secret. The gateway stores that part as the secret and adds it to the URL path (**Part of the URL path** injection).
The caller posts to `/proxy/<slug>` and never sees the webhook URL.

## Service templates

In the admin UI, open **Credentials**, select **Add a token** and open the **Slack incoming webhook** or **Discord webhook** card. Paste the whole webhook URL and select **Save Slack webhook** (or **Save Discord webhook**). Everything in the table comes from the template (`apps/gateway/src/admin/service-templates.ts`).

| Field | **Slack incoming webhook** | **Discord webhook** |
|---|---|---|
| Slug | `slack-webhook` | `discord-webhook` |
| Base URL | `https://hooks.slack.com/services` | `https://discord.com/api/webhooks` |
| How the secret is sent | Part of the URL path | Part of the URL path |
| Path before the secret | empty | empty |
| Timeout (milliseconds) | `30000` | `30000` |
| Secret check | none | none |
| Suggested grant rule | `POST /` | `POST /` |
| Host for the upstream host allowlist | `hooks.slack.com` | `discord.com` |

If **Settings › Allowed hosts** is set and does not include the host, the card says so before you type anything. An owner ticks **Also allow** in the same form; anyone else asks an owner ([configuration](../configuration.md#upstream-host-allowlist)).

### Secret value

Paste the whole webhook URL. The gateway keeps only the part after the base URL as the secret (the bare part is accepted too):

| Webhook URL | Stored secret |
|---|---|
| `https://hooks.slack.com/services/T0000/B0000/XXXXXXXXXXXXXXXXXXXXXXXX` | `T0000/B0000/XXXXXXXXXXXXXXXXXXXXXXXX` |
| `https://discord.com/api/webhooks/123456789012345678/REDACTED-token` | `123456789012345678/REDACTED-token` |

The secret may have several `/`-separated segments. Each segment may only contain `A-Z a-z 0-9 - . _ ~ ! $ & ' ( ) * + , = : @`, and `.` or `..` segments are refused (`apps/gateway/src/policy/validate.ts`, `apps/gateway/src/proxy/path.ts`).

There is no secret check for webhooks: Slack has no read-only webhook call, and Discord's `GET` returns the token in its body.

## Call it

`$(tokengate-token)` works only in GitHub Actions jobs that ran the [get-token action](../callers/github-actions.md#2-mint-the-token-with-the-composite-action). In GitLab CI, use the `id_tokens` variable instead.

Post to the service root. `/proxy/slack-webhook` and `/proxy/slack-webhook/` both reach the full webhook URL, without a trailing `/`.

### Slack

```bash
curl -sS --fail-with-body -X POST "$TOKENGATE_URL/proxy/slack-webhook" \
  -H "x-tokengate-token: $(tokengate-token)" \
  -H 'content-type: application/json' \
  -d '{"text":"Deployed"}'
```

### Discord

```bash
curl -sS --fail-with-body -X POST "$TOKENGATE_URL/proxy/discord-webhook?wait=true" \
  -H "x-tokengate-token: $(tokengate-token)" \
  -H 'content-type: application/json' \
  -d '{"content":"Deployed"}'
```

Query strings pass through to the upstream.

Use one service per webhook URL. Each webhook posts to one channel, so the service slug selects the channel, for example `slack-webhook-releases`.

## Caller token header

Send the caller token in `x-tokengate-token` or `Authorization: Bearer`. Webhook tokens have no injection header, so there is no third option.
The gateway never forwards the caller token ([I-TOK-1](../threat-model.md#i-tok-1)).

## IssuerAccessRule only `POST /`

Upstream response bodies reach the caller unchanged. Discord answers `GET` and `PATCH` on the webhook URL with the webhook object, including its `token`.
A caller with such a grant could read the token and use it outside the gateway, even after the grant is revoked.

- Give consumers only `POST /` on webhook tokens.
- The grant form warns when a grant for a URL-path service allows any other method, including `*`.
- The service form shows the same warning when you select **Part of the URL path**.

Response headers are different: the gateway drops any upstream response header that contains the credential, or any segment of it with 16 or more characters, and lists it in `x-tokengate-redacted` ([I-RESP-1](../threat-model.md#i-resp-1)).
Redirects that point under the webhook URL are rewritten to the gateway URL without the credential ([I-REDIR-1](../threat-model.md#i-redir-1)).

## Other URL-path credentials

Some APIs put the credential in the path after a fixed text, for example Telegram's `https://api.telegram.org/bot<token>/sendMessage`.
Create the service without a template:

| Field | Value |
|---|---|
| Base URL | `https://api.telegram.org` |
| How the secret is sent | Part of the URL path |
| Path prefix (URL path only, optional) | `/bot` |
| Credential | the bot token |

The gateway appends the credential to the prefix, so `/proxy/<slug>/sendMessage` reaches `https://api.telegram.org/bot<token>/sendMessage`.
IssuerAccessRule only the methods the job needs, for example `POST /sendMessage`.

## Gotchas

- **Rotating a webhook URL** means a new credential: create the new webhook, paste it under **Replace secret** on the token page, then delete the old webhook. See [credential-rotation.md](../operations/credential-rotation.md).
- **Slack app tokens** are not webhooks. For `chat.postMessage` and other Web API methods, see [slack.md](slack.md).
- **Long jobs.** GitHub caller tokens expire after about 5 minutes. Mint a fresh one for each post. See [github-actions.md](../callers/github-actions.md#long-jobs).
