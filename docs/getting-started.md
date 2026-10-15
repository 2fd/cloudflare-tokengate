# Getting started

This page takes a platform engineer from an empty Cloudflare account to a GitHub Actions job that calls an upstream API through tokengate. Read [concepts.md](concepts.md) first if the terms are new.

## Choose a path

- **Manual deploy.** Follow steps 1 to 16.
- **Deploy button.** The button replaces steps 1 to 6. Read [Deploy button](#deploy-button) first, then continue at step 7.

The proxy works on the `*.workers.dev` hostname right after step 5. The admin UI does not: `/admin` never answers on workers.dev, and sign-in goes through Cloudflare Access on a custom domain (steps 7 to 9).

## Prerequisites

- A Cloudflare account. Workers Paid is the supported plan. The Free plan has lower limits; if you evaluate on it, see [Workers Free plan](#workers-free-plan).
- Node.js 22.18 or later. `pnpm keyring` (used for key rotation) needs TypeScript type stripping, which Node.js has from 22.18.
- pnpm. The version is pinned in the `packageManager` field of `package.json`.
- `git` and `openssl`.
- A domain whose zone is in the same Cloudflare account, for the admin UI hostname, for example `tokengate.example.com`.
- Cloudflare Zero Trust set up for the account, with a login method for your team (for example your company identity provider, or one-time PIN). Admin sign-in uses Cloudflare Access.
- A company vault (password manager or secrets manager) for the key-encryption key.
- A GitHub repository where you can add a workflow, and the [`gh` CLI](https://cli.github.com/) for the commands below.

## 1. Clone the repository

```sh
git clone https://github.com/2fd/cloudflare-tokengate.git
cd cloudflare-tokengate
```

## 2. Install dependencies

```sh
pnpm install
```

## 3. Sign in to Cloudflare

```sh
pnpm wrangler login
```

## 4. Create the two D1 databases

tokengate uses two databases (see [architecture.md](architecture.md)):

| Binding | Database name | Contents |
|---|---|---|
| `DB` | `tokengate` | Users, caller providers, services, grants, settings, audit log |
| `TELEMETRY_DB` | `tokengate-telemetry` | Request log and hourly rollups |

1. Choose a location hint near your CI runners: `weur`, `eeur`, `apac`, `oc`, `wnam` or `enam`.
2. Create the control-plane database:

   ```sh
   pnpm wrangler d1 create tokengate --location wnam
   ```

3. Create the telemetry database:

   ```sh
   pnpm wrangler d1 create tokengate-telemetry --location wnam
   ```

4. If Wrangler asks "Would you like Wrangler to add it on your behalf?", answer no. `wrangler.jsonc` already binds both databases by name, and Wrangler finds them by name when it deploys.

If your data must stay in a jurisdiction, use `--jurisdiction eu` (or `us`, `fedramp`) instead of `--location`.

## 5. Deploy

```sh
pnpm run deploy
```

This command applies the migrations in `migrations/` to `DB` and the migrations in `migrations-telemetry/` to `TELEMETRY_DB`, then deploys the Worker. Answer yes when Wrangler asks to apply the migrations.

Note the URL that Wrangler prints, for example `https://tokengate.<your-subdomain>.workers.dev`. Use it until step 7 gives the Worker its custom domain.

Check that the Worker answers:

```sh
curl -sS https://tokengate.<your-subdomain>.workers.dev/healthz
curl -sS https://tokengate.<your-subdomain>.workers.dev/readyz
```

`/healthz` returns `{"ok":true}`. `/readyz` returns `503` with `"keyring":false` until you finish step 6.

## 6. Generate and store the key-encryption key

The key-encryption key (KEK) encrypts every stored credential. Cloudflare secrets are write-only: you cannot read the KEK back. If you lose it, you lose every stored credential.

1. Generate 32 random bytes outside Cloudflare:

   ```sh
   openssl rand -base64 32
   ```

2. Store the value in your company vault.
3. Set it as a Worker secret. Paste the value at the prompt:

   ```sh
   pnpm wrangler secret put TOKENGATE_KEK
   ```

4. Check readiness again. `/readyz` now returns `"ok":true`. Each isolate caches the answer for 10 seconds, so retry once if it still shows `"keyring":false`.

To rotate the KEK later, see [operations/key-rotation.md](operations/key-rotation.md).

## 7. Attach a custom domain

1. Add the domain's zone to your Cloudflare account, if it is not there yet.
2. Open Workers & Pages > tokengate > Settings > Domains & Routes and add a custom domain, for example `tokengate.example.com`.

The rest of this page calls `https://tokengate.example.com` `<gateway>`. Check that `curl -sS <gateway>/healthz` returns `{"ok":true}`.

## 8. Create the Access application

The Access application puts the admin UI behind your Zero Trust login. It must cover `/admin` only. CI jobs call `/proxy` without an Access session, so `/proxy` must stay outside Access.

1. In Zero Trust, open Access controls > Applications and add a self-hosted application.
2. Add two public hostnames on your custom domain: path `admin` and path `admin/*`. A path with `/*` does not cover its parent path, so you need both ([application paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/)).
3. Add an Allow policy with only your own email address for now. The first person through Access becomes the owner, and everyone after joins as a viewer by default, so widen the policy (for example to your company's email domain) only after step 10.
4. Save the application. Copy its "Application Audience (AUD) Tag".
5. Note your team name: the `<team>` in `<team>.cloudflareaccess.com`, shown in the Zero Trust settings.

The gateway does not trust Access blindly. It verifies the Access token on every `/admin` request, so a request that reaches the Worker without a valid token gets `401`. The Access policy decides who can see the admin UI: the first person to sign in becomes the owner (step 10), and everyone after that joins with the join defaults (by default an active viewer). Viewers see every page, but no page shows a secret.

More about the zone and Access: [operations/cloudflare-zone-settings.md](operations/cloudflare-zone-settings.md).

## 9. Set the operator variables

Set operator variables in the Cloudflare dashboard, not in `wrangler.jsonc`. `wrangler.jsonc` sets `"keep_vars": true` and declares no variables, so deploys keep the values that you set in the dashboard ([I-DEPLOY-1](threat-model.md#i-deploy-1)).

1. Open Workers & Pages > tokengate > Settings > Variables and Secrets.
2. Add these variables as plain text:

   | Variable | Value | Why |
   |---|---|---|
   | `AUTH_ACCESS_TEAM_DOMAIN` | Your team name from step 8 | The gateway checks the Access token against this team's keys. |
   | `AUTH_ACCESS_AUD` | The AUD tag from step 8 | The Access token must be for this application. |

3. If `AUTH_ACCESS_DEVELOPMENT` is listed (the Deploy button sets it), delete it. With it and the Access variables both set, no login works.
4. Save and deploy the change.

> **Warning:** Set these variables before you add services (step 13), and store their exact values in your vault next to the KEK. The KEK is bound to `AUTH_ACCESS_TEAM_DOMAIN`, `AUTH_ACCESS_AUD` and `AUTH_ACCESS_DEVELOPMENT` ([I-CRED-3](threat-model.md#i-cred-3)). A later change to any of them, even from `acme` to `acme.cloudflareaccess.com`, makes every stored credential impossible to decrypt ([configuration](configuration.md#login-binding)).

If a variable is half-configured or malformed, Access login stays off. `/admin` then shows the setup page, which names the variable ([I-CFG-1](threat-model.md#i-cfg-1)). Every variable, its format and its failure behavior are in [configuration.md](configuration.md).

## 10. Sign in as the first owner

1. Open `<gateway>/admin`. Access asks you to sign in.
2. Sign in. The Access policy from step 8 lets in only you, so you are the first person to sign in.
3. The gateway creates your user with the role `owner` and opens the Dashboard.

The bootstrap creates at most one owner, once ([I-BOOT-1](threat-model.md#i-boot-1)). The Audit log shows a `user.bootstrap` event. The same sign-in stores its hostname as the only admin host: from now on, `/admin` answers `404` on every other hostname ([I-DEPLOY-1](threat-model.md#i-deploy-1)). To add hostnames, use Settings > "Admin hosts", and put each one behind your Access application ([configuration](configuration.md#admin-hosts)).

The gateway keeps no session of its own. "Sign out" ends the Access session for the hostname.

## 11. Open the admin UI to your team and add a second owner

1. Settings > System status shows "First owner: done: an owner exists".
2. Optional: in Users > "New users", choose the role (any role except owner) and status (active, pending or suspended) that people get on their first sign-in. With "Pending", each new person waits in "Waiting for approval" until you click "Approve" or "Reject".
3. Widen the Access policy to the people who may reach the admin UI.
4. Ask a second person to open `<gateway>/admin`. They join as an active viewer (or as pending, then you approve them). In Users > "All users", set their role to "Owner" and click "Save". If the only owner loses access, recovery needs a manual database edit ([operations/break-glass.md](operations/break-glass.md)).

To give someone a role before their first sign-in, open Users and use "Invite a user". The gateway sends no email: send `<gateway>/admin` to the person yourself. They must open it with the invited email address within 7 days. The gateway links a login to an invited user only through the email address in the Access token ([I-LINK-1](threat-model.md#i-link-1)).

## 12. Add a service consumer

A caller provider tells the gateway which CI tokens to trust.

1. Open Caller providers and click "Add a caller provider".
2. Choose "GitHub Actions".
3. In "Name", enter a label such as `GitHub Actions (acme)`.
4. Keep the default "Issuer", `https://token.actions.githubusercontent.com`.
5. Keep the generated "Audience". It starts with `tokengate:` and is random, so tokens minted for other services are never accepted here.
6. Find the numeric ID of your GitHub organization:

   ```sh
   gh api orgs/ACME --jq .id
   ```

   For a personal account, use `gh api users/USERNAME --jq .id`.

7. Enter the ID in "Allowed organization IDs". This is the tenant pin. It is required, because anyone on GitHub can get a token from this issuer ([I-TEN-1](threat-model.md#i-ten-1)).
8. Click "Create caller provider".
9. Copy the "Audience" value from the caller provider page. The section "Use it from CI" shows a workflow snippet with your values.

GitLab CI and other issuers are covered in [callers/gitlab-ci.md](callers/gitlab-ci.md) and [callers/generic-oidc.md](callers/generic-oidc.md).

## 13. Add a service token

A service is one upstream API plus the credential the gateway attaches. This example uses the GitHub REST API.

1. In GitHub, create a fine-grained personal access token that can access only your test repository. The default read-only "Metadata" permission is enough for this example.
2. In the admin UI, open Services and click "Add a service".
3. Under "Start from a template", click "GitHub REST API".
4. Keep the "Slug" `github`. Callers use it in the URL: `<gateway>/proxy/github/...`. You cannot change it later.
5. Paste the token in "Credential (optional)".
6. Click "Create service".

The template includes a credential check (`GET /rate_limit`). If it passes, the page shows "Service created; the credential check against the upstream passed."

The credential is encrypted before it is stored. The UI shows only its length and last 4 characters ([I-CRED-1](threat-model.md#i-cred-1)). More templates and their settings are in [upstreams/github.md](upstreams/github.md) and the other [upstreams](upstreams/) pages.

## 14. Make the first call

1. Use a test repository owned by the organization whose ID you entered in step 12. Set two Actions variables on it. Replace `OWNER/REPO` with the test repository. You run these commands in the gateway clone, so `--repo` is required.

   ```sh
   gh variable set TOKENGATE_URL --repo OWNER/REPO --body "<gateway>"
   gh variable set TOKENGATE_AUDIENCE --repo OWNER/REPO --body "<audience from step 12>"
   ```

2. Add `.github/workflows/tokengate-smoke.yml` on the default branch:

   ```yaml
   name: tokengate smoke test
   on: workflow_dispatch
   permissions:
     id-token: write
     contents: read
   jobs:
     call:
       runs-on: ubuntu-latest
       steps:
         - id: tokengate
           uses: 2fd/cloudflare-tokengate/actions/get-token@main   # pin to a full commit SHA in production
           with:
             url: ${{ vars.TOKENGATE_URL }}
             audience: ${{ vars.TOKENGATE_AUDIENCE }}
         - name: Read this repository through the gateway
           env:
             TOKEN: ${{ steps.tokengate.outputs.token }}
             PROXY: ${{ steps.tokengate.outputs.proxy-base }}
           run: |
             curl -sS --fail-with-body "$PROXY/github/repos/$GITHUB_REPOSITORY" \
               -H "x-tokengate-token: $TOKEN" \
               -H "accept: application/vnd.github+json"
   ```

3. Run the workflow:

   ```sh
   gh workflow run tokengate-smoke.yml --repo OWNER/REPO
   gh run watch --repo OWNER/REPO
   ```

The step fails with HTTP 403. The body contains `"code":"no_matching_grant"` and the `request_id`. This is expected: access is denied by default ([I-AUTHZ-1](threat-model.md#i-authz-1)). The response headers carry `x-tokengate-error` and `x-tokengate-request-id`. All error codes are in [errors.md](errors.md).

## 15. Give access from the denied request

1. In the admin UI, open Requests. You can also use "Recent denials" on the Dashboard.
2. Open the denied request. Its reason is `no_matching_grant`.
3. Click "Create grant from this request". The grant form opens, prefilled with this caller's exact values:

   ```text
   repository_owner_id exact 1234567
   repository_id exact 7654321
   ref exact refs/heads/main
   event_name exact workflow_dispatch
   ```

   The rule is the exact call: `GET /repos/acme/demo`.

4. Review the conditions and the rule. Widen only what you need. [policies.md](policies.md) explains the syntax.
5. Click "Create grant".
6. The form comes back with a warning: the grant matches on `ref` without `ref_protected exact true`.
   - If `main` is a protected branch, add the line `ref_protected exact true` to "Conditions" and click "Create grant" again.
   - Otherwise, check "I have read the warnings above and want to save this grant anyway" and click "Create grant" again.

Only requests with a verified token that were denied with `no_matching_grant` or `event_not_trusted` offer this button ([I-LOG-2](threat-model.md#i-log-2)). The button requires the role `access_manager`, `admin` or `owner`.

## 16. Call again

```sh
gh workflow run tokengate-smoke.yml --repo OWNER/REPO
gh run watch --repo OWNER/REPO
```

The step prints the repository JSON from the GitHub API. The job never saw the GitHub token: the gateway removed the caller token and added the credential ([I-TOK-1](threat-model.md#i-tok-1), [I-INJ-1](threat-model.md#i-inj-1)).

The Requests page shows the call as allowed, with the grant that matched, unless "Share of allowed requests to record" is `0`. The "Get started" checklist on the Dashboard disappears once a caller provider, a service, a grant and a verified call exist.

## Production on a custom domain

The steps above already put the admin UI on a custom domain. Before real use:

1. Check the zone's bot and firewall settings. GitHub-hosted runners connect from datacenter IP addresses:
   - If Bot Fight Mode is on, it blocks CI callers, and no rule can skip it for one path. Turn it off for the zone. On a Pro or higher plan, you can use Super Bot Fight Mode with a skip rule for `/proxy/*` instead.
   - If WAF managed rules block API traffic, add a skip rule for `/proxy/*`.
   - A response without an `x-tokengate-request-id` header came from Cloudflare, not from the gateway.

   Details are in [operations/cloudflare-zone-settings.md](operations/cloudflare-zone-settings.md).
2. If CI jobs still use the workers.dev URL, change `TOKENGATE_URL` in your CI variables to `<gateway>`.
3. Optional: turn off the workers.dev hostname. Set `"workers_dev": false` in your clone's `wrangler.jsonc` and run `pnpm run deploy`.
4. Optional: in Settings > "Upstream hosts", list the exact hosts your services use. Empty allows any public https host ([configuration](configuration.md#upstream-host-allowlist)).
5. Pin `actions/get-token` to a commit SHA in every workflow.
6. Monitor `<gateway>/readyz` and read [observability.md](observability.md). Optional bindings (request log queue, R2 archive, rate limiter) are in [configuration.md](configuration.md).
7. Plan backups and key custody: [operations/backup-restore.md](operations/backup-restore.md) and [operations/key-rotation.md](operations/key-rotation.md).

## Deploy button

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/2fd/cloudflare-tokengate)

1. Generate the KEK and store it in your vault first (step 6, items 1 and 2).
2. Click the button. Cloudflare copies this repository into a new repository in your GitHub or GitLab account, creates the two D1 databases and sets up Workers Builds.
3. The form asks for the two secrets that `.dev.vars.example` sets:
   - `TOKENGATE_KEK`: paste your KEK. Do not use the development key from `.dev.vars.example`: it is public.
   - `AUTH_ACCESS_DEVELOPMENT`: the local development login. It signs in no request to your Worker. Enter any email address; you delete this secret in [step 9](#9-set-the-operator-variables).
4. Check that the Workers Builds deploy command runs the `deploy` script: `pnpm run deploy`. Cloudflare pre-fills it from `package.json`. If the field shows a plain `wrangler deploy`, change it: that command does not apply the database migrations.
5. After the first deploy, continue at [step 7](#7-attach-a-custom-domain). The Access variables are not part of the button form: `wrangler.jsonc` declares none.

A deploy that keeps the `.dev.vars.example` values fails closed ([I-DEPLOY-1](threat-model.md#i-deploy-1)). The development login signs in only requests to `localhost`, so `/admin` shows the setup page and nobody can sign in. When you set the Access variables, the Worker refuses the development key (`dev_placeholder_key`), and the setup page stays until you delete `AUTH_ACCESS_DEVELOPMENT`.

Caveats:

- The new repository is a copy, not a fork. GitHub does not offer upstream updates for it. Pull new releases yourself: [operations/upgrades.md](operations/upgrades.md).
- Deploys from your copy keep the variables that you set in the dashboard. Set each variable in one place only.

## Workers Free plan

The Free plan has a daily limit on D1 row writes and reads. If you evaluate on it:

1. In Settings, set "Share of allowed requests to record" to `0`. Denied and error requests are still recorded.
2. Keep "Maximum request log rows" above the table size your traffic can reach. A cap below that size makes every hourly run read up to the cap, which exceeds the Free read allowance. See [configuration.md](configuration.md#request_log_max_rows).

The optional R2 archive needs Workers Paid. The optional request log queue has a small daily operation allowance on Free (see [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/)). See [configuration.md](configuration.md).

## Next steps

- Write grants for real workloads: [policies.md](policies.md).
- Call more APIs from CI: [callers/github-actions.md](callers/github-actions.md) and the [upstreams](upstreams/) pages.
- Operate the deployment: [operations/troubleshooting.md](operations/troubleshooting.md), [operations/incident-response.md](operations/incident-response.md).
