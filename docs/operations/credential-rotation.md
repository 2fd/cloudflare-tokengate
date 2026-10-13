# Credential rotation

This page explains how to replace a service's upstream credential (an API key or token) without
downtime. It is for admins and owners who manage services.

The gateway reads the credential from D1 on every request; nothing is cached. A new credential is used
from the next request on ([I-AUTHZ-1](../threat-model.md#i-authz-1)). Callers never hold the
Credential, so no workflow changes.

## When to rotate

- On a schedule, or before the expiry date. The gateway helps:
  - The service page shows the credential status ("expires ..." within 14 days, "expired").
  - The dashboard shows a warning banner 14 days before expiry and an error banner after it.
  - The hourly job writes one `credential.expiring` audit event per service when the credential
    crosses 14 days and 3 days before expiry ([observability](../observability.md#audit-log)).
- When the dashboard shows "Upstream rejected the credential of service ...": at least 5 and at least
  50% of forwarded requests got 401/403 in the last 15 minutes. The credential was probably revoked
  or expired at the upstream.
- When the credential may have leaked ([incident response](incident-response.md#a-credential-leaked)).

Rotating a credential is not needed after a [key rotation](key-rotation.md): re-encryption keeps the
same credential.

## Rotate a credential

You need the admin or owner role.

1. At the upstream, create a new key or token with the same permissions as the current one. Keep the
   current one active.
2. Open Admin > Services and select the service.
3. Note the current "Credential" status and its hint (last 4 characters and length, for
   Credentials of 20 characters or more).
4. Under "Change credential or destination", leave the base URL and "How the credential is sent"
   unchanged.
5. Paste the new value into "Credential".
6. If the new credential expires, set "Credential expires on (optional, UTC)". Leave it empty if it
   does not expire.
7. Select "Save credential".
8. If the service has a credential check, the check runs with the new credential before anything is
   saved. If the check fails, nothing is saved and the result is shown. Fix the credential, or select
   "Save the credential even though the check failed" and save again.
9. Check that "Last set" shows the current time and that the hint matches the new credential.

Saving writes one `service.credential.set` audit event ([I-AUDIT-1](../threat-model.md#i-audit-1)).
The credential never appears in the audit diff, the UI or the export
([I-CRED-1](../threat-model.md#i-cred-1)).

For a GitHub token with a credential check, the gateway reads the expiry from the
`github-authentication-token-expiration` response header when you leave the expiry field empty.

## Verify

1. If the service has a credential check, select "Test credential" on the service page. It sends
   the check to the upstream now. It writes a `service.credential.test` audit event before it sends
   the stored credential; if your session or role no longer allows the test, nothing is sent. The
   result appears on the page and in a `service.credential.test_result` log line.
2. Open Admin > Requests, set service to this service and Outcome to "Allowed", and select "Apply
   filters".
3. Check that new records have the expected upstream status. An upstream 401 or 403 in the Status
   column, with no gateway reason, means the upstream refused the new credential. If "Share of
   allowed requests to record" is below 1, only some allowed requests appear.

## Watch, then revoke the old credential

1. Wait until in-flight requests that started before the change have finished. Streaming responses
   opened with the old credential keep running until they end.
2. Watch the dashboard for 15 minutes. The "Upstream rejected the credential" banner must not appear.
3. At the upstream, revoke the old key or token.
4. Watch the dashboard again for 15 minutes, and check the upstream's own logs for use of the old key.
   Any use after the change did not come through the gateway.

## Change the destination or injection

The sealed credential is bound to the service id, base URL and injection
([I-CRED-2](../threat-model.md#i-cred-2)). To change the base URL or "How the credential is sent",
use the same "Change credential or destination" form and enter the credential again in the same save.
The new base URL must pass `ALLOWED_UPSTREAM_HOSTS` when that variable is set
([I-SSRF-1](../threat-model.md#i-ssrf-1)).

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
- Webhook URLs with `path` Injection: the credential is part of the URL; rotate the webhook at the
  upstream, then enter the new secret part ([webhooks](../upstreams/webhooks.md)).

## Related pages

- [incident-response.md](incident-response.md): when a credential leaks.
- [troubleshooting.md](troubleshooting.md): `credential_unavailable` and upstream 401/403.
- [observability.md](../observability.md): banners and the request log.
