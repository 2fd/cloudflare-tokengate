# Cloudflare zone settings

This page lists the Cloudflare settings outside `wrangler.jsonc` that affect the gateway: hostnames,
bot protection, WAF rules, rate limiting and Cloudflare Access. It is for platform engineers who run
the gateway on a custom domain.

On `*.workers.dev`, none of your zone settings apply: Cloudflare owns that zone. Everything below
applies to a custom domain in your own zone.

## Hostnames

| Setting | Where | Recommended |
|---|---|---|
| Custom domain | Workers & Pages > tokengate > Settings > Domains & Routes, or `routes` in your clone's `apps/gateway/wrangler.jsonc` | One hostname for the gateway, for example `tokengate.example.com` |
| Access application | Cloudflare One | Covers every hostname of the Worker. `/admin` answers on every hostname that routes to the Worker, except `workers.dev` ([I-DEPLOY-1](../threat-model.md#i-deploy-1)) |
| `workers_dev` | `apps/gateway/wrangler.jsonc` | `false` once the custom domain works |
| `preview_urls` | `apps/gateway/wrangler.jsonc` | `false` (already set; `apps/gateway/scripts/check-config.sh` enforces it) |

To declare the custom domain in `apps/gateway/wrangler.jsonc` instead of the dashboard:

```jsonc
"routes": [{ "pattern": "tokengate.example.com", "custom_domain": true }],
"workers_dev": false
```

Then run `pnpm run deploy`.

Why turn off `workers_dev`: with it on, `/proxy/` also answers on the workers.dev hostname, where your
zone's rate limiting and WAF rules do not run. The admin host rule always closes `/admin` there
(`apps/gateway/src/config.ts`, `adminHostAllowed`). So the admin UI is never available on workers.dev.

## Bot Fight Mode

GitHub-hosted runners and most CI runners connect from datacenter IP addresses. Bot protection can
challenge them. A challenged CI call gets an HTML page or a 403 without the `x-tokengate-request-id`
header.

- **Bot Fight Mode (Free plan)** cannot be skipped for a path: it does not run on the Ruleset Engine,
  so Skip rules and Page Rules have no effect
  ([Bot Fight Mode](https://developers.cloudflare.com/bots/get-started/bot-fight-mode/)). Turn it off
  for the zone that serves the gateway: Security > Settings, filter by "Bot traffic", turn "Bot fight
  mode" off. If you need it for other hostnames, serve the gateway from a different zone.
- **Super Bot Fight Mode (Pro and above)** runs after WAF custom rules and can be skipped. Create a
  custom rule with the Skip action that skips Super Bot Fight Mode
  ([Super Bot Fight Mode](https://developers.cloudflare.com/bots/get-started/super-bot-fight-mode/)):

  ```txt
  (http.host eq "tokengate.example.com" and starts_with(http.request.uri.path, "/proxy/"))
  ```

The gateway authenticates every `/proxy/` request with the caller's workload identity token. Bot
detection adds nothing there.

## WAF managed rules

Managed rules inspect request bodies. API payloads such as prompts, source code or chat messages can
trigger false positives. If a managed rule blocks CI calls, add a custom rule with the Skip action
for the same expression as above and skip the managed rules that fire
([Skip action](https://developers.cloudflare.com/waf/custom-rules/skip/)). Keep managed rules on for
`/admin`.

Check Security > Analytics > Events to see which rule acted on a request.

## Rate limiting

The Worker does not throttle anonymous traffic. It caps only how many pre-trust request records it
stores (10 per minute per isolate). Use rate limiting rules for:

| Expression | Counting | Purpose |
|---|---|---|
| `starts_with(http.request.uri.path, "/proxy/")` | Per IP, well above your CI peak per runner address | Anonymous floods that cost Worker requests and D1 reads |

- Below Enterprise, rate limiting rule expressions cannot use request headers, so a rule cannot tell
  token-less requests apart. The Free plan allows only the path field and a 10-second counting
  period ([rate limiting rules](https://developers.cloudflare.com/waf/rate-limiting-rules/)). Choose
  the `/proxy/` threshold so a busy runner never reaches it.
- For a ceiling per grant, which counts only authorized callers, use the `PROXY_RATE_LIMITER`
  binding ([configuration](../configuration.md#proxy_rate_limiter)).

## Cloudflare Access

Cloudflare Access is the only login for the admin UI (`AUTH_ACCESS_TEAM_DOMAIN`, `AUTH_ACCESS_AUD`).
Scope the Access application to `/admin` only. Callers on `/proxy/` authenticate with their own
tokens and cannot pass an Access login. `/healthz` and `/readyz` must stay reachable for monitors.

1. In Cloudflare One, create a self-hosted Access application.
2. Add two destinations on the gateway hostname: path `admin` and path `admin/*`. A path with `/*`
   does not cover its parent path, so you need both
   ([application paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/)).
3. Add a policy that allows your administrators.
4. Copy the application's Audience (AUD) tag into `AUTH_ACCESS_AUD` and your team name into
   `AUTH_ACCESS_TEAM_DOMAIN`
   ([configuration](../configuration.md#cloudflare-access-login-auth_access_)).
5. Open `https://tokengate.example.com/admin` in a private window. Access must ask you to sign in.
6. Open `https://tokengate.example.com/readyz`. It must answer without an Access login.

Each hostname that you add later as a route or custom domain needs the same two destinations in this
application: `/admin` answers on it as soon as it routes to the Worker
([configuration](../configuration.md#admin-hostnames)).

The gateway keeps no admin sessions. On every `/admin` request it verifies the
`Cf-Access-Jwt-Assertion` header itself (`apps/gateway/src/admin/auth/access.ts`): signature, issuer, audience
and expiry. A request without a valid header gets `401` and "Cloudflare Access did not present a
valid user identity for this request." This also covers a path that the Access application does not
match: the request reaches the Worker without the header and is refused. Access credentials carry
no email and are refused. The gateway still applies its own users and roles after Access
(`apps/gateway/src/admin/auth/middleware.tsx`).

Sign-in, sign-out and session length belong to Access:

- "Sign out" in the admin UI opens `/cdn-cgi/access/logout`, which ends the Access session for the
  hostname.
- The application's session duration decides how long a user stays signed in.
- To end a user's Access session at once, revoke it in Cloudflare One: on the user's page, or for
  every user with the application's "revoke existing tokens" action
  ([session management](https://developers.cloudflare.com/cloudflare-one/identity/users/session-management/)).
  Disabling the user in the admin UI refuses their next request even while the Access session lives.

## HTTPS

- Turn on "Always Use HTTPS" for the gateway hostname. The gateway sends HSTS only on https
  responses outside `/proxy/` (`apps/gateway/src/http/security.ts`).
- Callers must use `https://` URLs. The get-token action rejects other URLs
  ([get-token action](../../actions/get-token/README.md)).

## Same-zone upstreams

`global_fetch_strictly_public` is on, so a service whose base URL is in your own zone is fetched
through Cloudflare's edge. Your Access, WAF and rate limiting rules apply to those requests, with the
gateway as the client ([I-SSRF-1](../threat-model.md#i-ssrf-1)). Every upstream request also carries
a `CF-Worker` header that names your zone ([known limitations](../threat-model.md#platform)).

## Related pages

- [getting-started.md](../getting-started.md#production-on-a-custom-domain): moving to a custom domain.
- [troubleshooting.md](troubleshooting.md#the-response-has-no-x-tokengate-request-id): responses that
  come from Cloudflare, not the gateway.
- [configuration.md](../configuration.md): admin hostnames, Access variables and bindings.
