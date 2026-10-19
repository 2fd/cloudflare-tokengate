# Incident response

This page says what to do when a repository, a workflow, a credential, an admin account or a key is
compromised. It is for owners, admins and the security team.

Containment comes first. Policy is read from D1 on every request, so disabling something takes
effect on the next request ([I-AUTHZ-1](../threat-model.md#i-authz-1)). A response that is already
streaming keeps running until it ends ([known limitations](../threat-model.md#availability-and-traffic)).

## Containment options

| Action | Where | Effect on the next request | Scope |
|---|---|---|---|
| Disable a grant | Issuer access rules > the issuer access rule > "Disable" | Callers that matched only this grant get `403 no_matching_rule` | One grant |
| Disable a service | Services > the service > "Disable service" | Every caller gets `404 service_not_found` | All callers of one service |
| Disable a credential access rule | Credential access rules > the credential access rule > "Disable" | Every token from that issuer gets `401 issuer_unknown` | All callers of one issuer |
| Suspend a user | Users > status "Suspended" > "Save" | Every admin request of the user is refused, even with a valid Access session | One admin user |
| Hold new users | Users > "New users" > status "Pending" | People who sign in for the first time wait for approval instead of getting in | Every new user |
| Revoke Access sessions | Cloudflare One > the Access application or the user | The user must sign in to Access again ([zone settings](cloudflare-zone-settings.md#cloudflare-access)) | One user, or every user of the application |

Each action in the admin UI writes an audit event ([I-AUDIT-1](../threat-model.md#i-audit-1)). Access
session revocation is logged by Cloudflare, not by the gateway. Disabling or suspending
keeps the configuration, so "Enable" or "Active" restores it. Deleting is not needed for containment and removes context
you may need for the investigation.

## A repository or workflow is compromised

Examples: a malicious commit on a protected branch, a stolen maintainer account, a workflow that runs
untrusted code with `id-token: write`.

1. Find the issuer_access_rules that admit the repository: open Issuer access rules and check the conditions on `repository`,
   `repository_id` or `project_path`. Also check issuer_access_rules anchored on `repository_owner_id` or
   `namespace_id` with broad conditions, and issuer_access_rules on a reusable workflow (`job_workflow_ref`).
2. Disable each of those issuer_access_rules.
3. If you cannot narrow it down quickly, disable the affected credentials instead.
4. If the attacker can mint tokens for the whole organization, disable the credential access rule.
5. [Investigate the request log](#investigate-the-request-log) for the repository.
6. Decide whether the credentials of the reached credentials leaked. A caller never receives the
   Credential from the gateway ([I-CRED-1](../threat-model.md#i-cred-1)), but it can receive it from
   an upstream response body, and it can use the upstream API to create new keys
   ([known limitations](../threat-model.md#credentials-and-responses)). If either is possible with
   the grant's rules, rotate the credential ([credential rotation](credential-rotation.md)) and check
   the upstream for keys or tokens created during the incident.
7. Fix the repository: revoke the stolen account, remove the malicious commit, check branch
   protection and environment rules.
8. Enable the issuer_access_rules again, narrowed if needed ([policies](../policies.md)).

A caller token stays valid until it expires or reaches the credential access rule's maximum token age
(default 600 s). Disabling the grant stops it on the next request; nothing needs to change at the issuer.

## A Credential leaked

Examples: the key appears in a log, a paste or a commit; an upstream response returned it to a caller.

1. Rotate the credential at once ([credential rotation](credential-rotation.md)): create a new key,
   save it on the service, then revoke the old key at the upstream. Revoking the old key is the step
   that contains the leak; the gateway cannot stop use of a credential outside it.
2. Check the upstream's own logs for use of the old key from addresses other than Cloudflare.
3. [Investigate the request log](#investigate-the-request-log) for the service, to see which callers
   reached endpoints that return the credential.
4. Narrow the issuer_access_rules of that service so they no longer reach those endpoints. For `path` Injection
   (webhooks), allow only `POST /`.

## An admin account is compromised

1. In Users, set the account's status to "Suspended" and click "Save". The gateway checks the Access JWT and re-reads the
   user on every admin request, so the next request of the account is refused
   ([I-SESS-1](../threat-model.md#i-sess-1)). If it is the last active owner, invite a second owner
   first, or use [break-glass](break-glass.md).
2. In Audit log, set Actor to the account's email and review every event since the suspected start.
3. Undo unwanted changes: Issuer access rules, credential access rules (a new issuer the attacker controls is the typical
   path), credentials and users.
   If you restore `DB` to undo the attacker's changes instead, the restore can undo step 1: the account
   is active again. After the restore, suspend the account again
   ([checks after a restore](backup-restore.md#checks-after-a-restore)).
4. Look for `config.export` events: the export holds no credentials, but it maps your configuration.
5. An admin can use credentials through issuer_access_rules but cannot extract them from the gateway
   ([known limitations](../threat-model.md#credentials-and-responses)). If the attacker created a
   credential access rule and a grant, treat every credential that grant reached as used, and check the
   upstream for keys created during the incident.
6. Remove the attacker's access to Access: fix the account at the identity provider, narrow the Access
   policy, and revoke the account's Access sessions in Cloudflare One
   ([zone settings](cloudflare-zone-settings.md#cloudflare-access)).

To sign every admin out at once, see [break-glass](break-glass.md#sign-every-admin-out).

## The KEK or keyring leaked

A key alone does not expose credentials; together with a copy of the `credentials` table it does.
Follow [key rotation: if a key leaked](key-rotation.md#if-a-key-leaked): rotate the key, then rotate
every upstream credential sealed with it.

## A service destination was changed outside the admin UI

Signs: proxied requests fail with `credential_unavailable` and reason `credential_binding_mismatch`,
`sealed_malformed` or `keyring_missing_key`, and the service page shows the red banner "changed
outside the admin UI" or "cannot be confirmed". The credential is encrypted together with the
service's base URL and injection ([I-CRED-2](../threat-model.md#i-cred-2)). If the stored credential
no longer opens and the encryption key did not change, someone with D1 write access probably edited
the service row. A D1 writer cannot read the credential, but can point the service at its own host
and wait for an admin to enter the credential again.

1. Do not resubmit the stored values. The page marks the stored base URL and injection "not
   confirmed" and the credential status "does not open". The credential form is empty on purpose, and
   saving needs the destination host typed under "Confirm destination host". The check runs before
   the gateway sends anything to the upstream.
2. Check the base URL and injection against an out-of-band source: the provider's API documentation,
   the service template, or your configuration as code. The audit log, a recent configuration export
   and the stored row are not reliable references, because a D1 writer can change them too.
3. Enter the checked base URL, injection and destination host, then the credential.
4. Treat it as a [compromised Cloudflare account](#the-cloudflare-account-is-compromised): find out who
   can write to D1, and compare the rest of the configuration with a known-good copy.

Set the upstream host allowlist in Settings ([configuration](../configuration.md#upstream-host-allowlist)). With it, a
changed base URL can point only at a listed host, and the proxy refuses any other host with
`base_url_invalid`.

## The Cloudflare account is compromised

Anyone who can deploy the Worker or write to D1 has full control: they can read secrets at runtime
and change policy without audit events ([threat model](../threat-model.md#actors)).

1. Secure the Cloudflare account: remove unknown members and API tokens, rotate your own tokens.
2. Check the Worker's deployments: `pnpm wrangler deployments list`.
3. Rotate the keyring ([key rotation](key-rotation.md)) and every upstream credential.
4. Compare the configuration with a known-good [configuration export](backup-restore.md#configuration-export).

## Investigate the request log

Each request record has the caller's repository, `jti`, allowlisted claims, the grant that allowed
it, and the policy trace for denials ([observability](../observability.md#request-log)).

- Allowed records may be sampled ("Share of allowed requests to record"). Denied and error records
  are kept, except pre-trust records over budget.
- Records older than the request log retention (default 14 days) are gone from D1. If the
  [R2 archive](../observability.md#optional-r2-archive) is on, query it with DuckDB for older records.

### In the admin UI

1. Open Admin > Requests.
2. Enter the repository (`owner/name`) in "Repository" and select "Apply filters". This filter uses
   an index and searches the whole log.
3. Open a record to see its claims (`run_id`, `sha`, `actor`, `ref`, `event_name` for GitHub
   Actions), the grant and the policy trace.

### With SQL

The UI has no filter for `jti` or `run_id`. Query D1 directly. These queries read every row, which
costs D1 reads but does not change data. Times are milliseconds since the epoch.

By repository, in a time window:

```sh
pnpm wrangler d1 execute TELEMETRY_DB --remote --command "
  SELECT id, datetime(ts / 1000, 'unixepoch') AS time, outcome, reason, status, upstream_status,
         method, service_slug, path, credential_access_rule_id, jti, json_extract(caller_claims, '$.run_id') AS run_id
  FROM request_log
  WHERE caller_repository = 'octo-org/app'
    AND ts >= unixepoch('2026-10-12T00:00:00Z') * 1000
  ORDER BY id DESC LIMIT 500"
```

By workflow run (GitHub Actions `run_id`; GitLab: `pipeline_id` or `job_id`):

```sh
pnpm wrangler d1 execute TELEMETRY_DB --remote --command "
  SELECT id, datetime(ts / 1000, 'unixepoch') AS time, outcome, method, service_slug, path, status,
         json_extract(caller_claims, '$.actor') AS actor, json_extract(caller_claims, '$.sha') AS sha
  FROM request_log
  WHERE json_extract(caller_claims, '$.run_id') = '1234567890'
  ORDER BY id"
```

By token (`jti`):

```sh
pnpm wrangler d1 execute TELEMETRY_DB --remote --command "
  SELECT id, datetime(ts / 1000, 'unixepoch') AS time, outcome, method, service_slug, path, status
  FROM request_log WHERE jti = '<jti>' ORDER BY id"
```

What a service was used for, per repository and grant:

```sh
pnpm wrangler d1 execute TELEMETRY_DB --remote --command "
  SELECT caller_repository, credential_access_rule_id, method, outcome, SUM(weight) AS requests
  FROM request_log
  WHERE service_slug = 'slack' AND ts >= unixepoch('2026-10-12T00:00:00Z') * 1000
  GROUP BY 1, 2, 3, 4 ORDER BY requests DESC"
```

Use `SUM(weight)`, not `COUNT(*)`, to estimate request counts when allowed requests are sampled.

### Admin changes

Admin > Audit log filters by Target type, Target ID and Actor. For SQL:

```sh
pnpm wrangler d1 execute DB --remote --command "
  SELECT id, datetime(ts / 1000, 'unixepoch') AS time, actor_email, action, target_type, target_id, summary
  FROM audit_log WHERE ts >= unixepoch('2026-10-12T00:00:00Z') * 1000 ORDER BY id"
```

If you export `audit.event` log lines to a SIEM, search there for events older than the Workers Logs
retention ([observability](../observability.md#auditevent-log-lines-for-a-siem)).

## After the incident

1. Keep a [configuration export](backup-restore.md#configuration-export) and the query results with
   the incident record.
2. Review issuer_access_rules for the gap that allowed the incident ([policies](../policies.md)).
3. Consider `PROXY_RATE_LIMITER` to cap what one grant can do
   ([configuration](../configuration.md#proxy_rate_limiter)).
4. Report suspected gateway vulnerabilities privately ([SECURITY.md](../../SECURITY.md)).
