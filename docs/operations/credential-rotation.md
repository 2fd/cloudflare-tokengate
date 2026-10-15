# Credential rotation

This page explains how to replace the secret of a service token (an API key or token) without
downtime. It is for token managers, admins and owners.

The gateway reads the secret from D1 on every request; nothing is cached. A new secret is used
from the next request on ([I-AUTHZ-1](../threat-model.md#i-authz-1)). Consumers never hold the
secret, so no workflow changes.

## When to rotate

- On a schedule, or before the expiry date. The gateway helps:
  - The token page shows the secret status ("Expires in N days" within 14 days, "Expired").
  - The Overview and Service tokens › Tokens show a warning 14 days before expiry and an error after
    it, each with a link to the token's **Secret** section.
  - The hourly job writes one `credential.expiring` audit event per token when the secret crosses
    14 days and 3 days before expiry ([observability](../observability.md#audit-log)).
- When the Overview shows "Upstream rejecting (401/403)" for a token: at least 5 and at least 50% of
  forwarded requests got 401/403 in the last 15 minutes. The secret was probably revoked or expired
  at the upstream.
- When the secret may have leaked ([incident response](incident-response.md#a-credential-leaked)).

Rotating a secret is not needed after a [key rotation](key-rotation.md): re-encryption keeps the
same secret.

## Rotate a secret

You need the token manager, admin or owner role.

1. At the upstream, create a new key or token with the same permissions as the current one. Keep the
   current one active.
2. Open **Service tokens** and select the token (or follow the expiry warning, which opens its
   **Secret** section).
3. Note the stored hint under **Secret** (last 4 characters and length, for secrets of 20
   characters or more).
4. Under **Replace secret**, paste the new value. The destination is not part of this form: the
   stored base URL and injection are kept (`POST /admin/tokens/:id/secret`). The hint names the
   host the secret is sent to. If someone changed the destination after you opened the page, the
   form is refused and nothing is sent: check the destination, then paste the secret again.
5. **New secret expires on** is prefilled with the stored expiry when it is more than 14 days away.
   Change it if the new secret expires on another date; leave it empty if it does not expire.
   GitHub tokens have no expiry field: the check reads it from GitHub.
6. For GitHub, **Also replace in github-uploads** is ticked when the other GitHub token holds the
   same secret. Leave it ticked to replace both in one submit; each gets its own audit event.
7. Select **Check and replace secret** (or **Replace secret** when the token has no check).
8. If the token has a check, it runs with the new secret before anything is saved. If it fails,
   nothing is saved and the result is shown. The page keeps the secret for 15 minutes as a sealed
   draft, so you do not paste it again: fix the problem and select **Check again and save**, or
   select **Save without a passing check**.
9. Check that **Set on** shows the current time and that the hint matches the new secret.

The rotate form is shown only while the stored secret opens under the stored destination. When it
does not (or no secret is stored), the page sends you to **Change destination** instead, where you
confirm the host ([I-CRED-2](../threat-model.md#i-cred-2)).

Saving writes one `service.credential.set` audit event per token
([I-AUDIT-1](../threat-model.md#i-audit-1)). The secret never appears in the audit diff, the UI or
the export ([I-CRED-1](../threat-model.md#i-cred-1)).

## Verify

1. If the token has a check, select **Test <name> secret** on the token page. It sends the check to
   the upstream now. It writes a `service.credential.test` audit event before it sends the stored
   secret; if your user or role no longer allows the test, nothing is sent. The result appears on
   the page and in a `service.credential.test_result` log line. When GitHub reports another expiry,
   the test saves it (a `service.update` audit event).
2. On the token page select **Requests through this token**, and set Outcome to "Allowed".
3. Check that new records have the expected upstream status. An upstream 401 or 403 in the Status
   column, with no gateway reason, means the upstream refused the new secret. If "Share of allowed
   requests to record" (Monitoring › Data retention) is below 1, only some allowed requests appear.

## Watch, then revoke the old secret

1. Wait until in-flight requests that started before the change have finished. Streaming responses
   opened with the old secret keep running until they end.
2. Watch the Overview for 15 minutes. "Upstream rejecting (401/403)" must not appear for the token.
3. At the upstream, revoke the old key or token.
4. Watch the Overview again for 15 minutes, and check the upstream's own logs for use of the old
   key. Any use after the change did not come through the gateway.

## Change the destination or injection

The sealed secret is bound to the token id, base URL and injection
([I-CRED-2](../threat-model.md#i-cred-2)). To change the base URL or "How the secret is sent", open
**Change destination** on the token page (`POST /admin/tokens/:id/destination`) and enter the secret
again in the same save. **Replace secret** never takes a destination.

- When the stored secret does not open, or no secret is stored, the form is open from the start,
  the stored destination is not prefilled, its base URL suggestions come only from the token types
  in code, and you type the destination host under **Confirm destination host**. Nothing is sent
  upstream until it matches. A kept draft never counts as the confirmation, and a draft made for
  one base URL or injection does not open for another.
- The new base URL must pass Service tokens › Allowed hosts when it is set
  ([I-SSRF-1](../threat-model.md#i-ssrf-1)). An owner can tick **Also allow <host>** in the same
  form.
- The token's type label follows the destination: a token that no longer points where its template
  points becomes a custom token.

## Upstreams with special rules

- Slack: token rotation (refresh tokens) is not supported; use a non-rotating token
  ([Slack](../upstreams/slack.md)). Step 1 above does not work as written for one Slack app: you get
  the new bot token through the app's OAuth flow after you revoke the old one. Revoking a bot token
  deactivates the bot user and removes its channel memberships
  ([auth.revoke](https://docs.slack.dev/reference/methods/auth.revoke)). Choose one:
  - Short outage: revoke the old token, get the new one, save it, then invite the bot to its
    channels again. Calls fail between the revocation and the save.
  - No outage: create and install a second Slack app, invite its bot to the same channels, and save
    its token. Then revoke the old app's token.
- GitHub: see [GitHub](../upstreams/github.md) for token types and expiry.
- Webhook URLs with `path` Injection: the secret is part of the URL; rotate the webhook at the
  upstream, then paste the whole new webhook URL under **Replace secret**
  ([webhooks](../upstreams/webhooks.md)).

## Related pages

- [incident-response.md](incident-response.md): when a credential leaks.
- [troubleshooting.md](troubleshooting.md): `credential_unavailable` and upstream 401/403.
- [observability.md](../observability.md): banners and the request log.
