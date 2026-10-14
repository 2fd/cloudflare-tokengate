# Security policy

This page explains how to report a vulnerability in cloudflare-tokengate and how to harden your own
deployment. It is for security researchers and for the platform engineers who run the gateway.

cloudflare-tokengate is self-hosted. Each company runs its own copy on its own Cloudflare account.
The maintainers do not operate any deployment and cannot see your data or patch your copy for you.

## Supported versions

The project is pre-1.0. Only the latest release and the `main` branch get security fixes. Fixes
are not backported. To get a fix, pull the release into your clone and deploy it
([upgrades](docs/operations/upgrades.md)).

| Version | Supported |
|---|---|
| Latest 0.x release and `main` | Yes |
| Older releases | No |

## Report a vulnerability

Do not open a public issue, discussion or pull request for a vulnerability.

1. Open a private report through
   [GitHub Security Advisories](https://github.com/2fd/cloudflare-tokengate/security/advisories/new).
2. If you cannot use GitHub, open a public issue that asks for a private contact. Put no details in
   that issue.

### What to include

- The affected version or commit.
- The invariant you think breaks, by ID from the [threat model](docs/threat-model.md) (for example
  [I-CRED-2](docs/threat-model.md#i-cred-2)), if you know it.
- Exact steps to reproduce: configuration (caller provider profile, injection kind, grant
  Conditions and rules), requests and observed responses. A failing test is the best form.
- The impact: what an attacker gains and which actor in the threat model they must be.
- Whether the issue needs a non-default setting or a Cloudflare zone setting.

Never send real credentials, caller tokens or keyring values. Use placeholders such as
`<your-kek>` or `xoxb-REDACTED`.

### What to expect

These are targets. The project has volunteer maintainers.

| Step | Target |
|---|---|
| Acknowledge the report | 3 business days |
| Confirm or reject, with a severity | 10 business days |
| Fix released for a confirmed high or critical issue | 30 days |
| Fix released for other confirmed issues | 90 days |

The maintainers keep you informed in the advisory. If a target slips, they say so there.

### Disclosure

- Coordinated disclosure. The maintainers publish a GitHub Security Advisory when the fix is
  released, and request a CVE when it applies.
- Please wait for the advisory, or 90 days after your report, before you publish details. If the
  issue is actively exploited, the maintainers may publish earlier, with mitigations.
- Reporters are credited in the advisory unless they ask not to be.
- The [CHANGELOG](CHANGELOG.md) lists security fixes under "Security".

## Scope

In scope:

- Code in this repository: `src/`, `migrations/`, `migrations-telemetry/`, `actions/get-token/`,
  `scripts/` and the committed `wrangler.jsonc`.
- Any way to break an invariant in the [threat model](docs/threat-model.md), or to go past a bound
  that a documented limitation states.
- Documentation that leads an operator who follows it to an insecure deployment.

Out of scope:

- Behavior listed under [Known limitations](docs/threat-model.md#known-limitations), within the
  stated bounds.
- Attacks that need Worker deploy rights or the keyring. These actors have full trust.
- Attacks that need D1 write access, unless they open or repoint a credential ([I-CRED-2](docs/threat-model.md#i-cred-2)).
- Vulnerabilities in the Cloudflare platform. Report them to
  [Cloudflare](https://www.cloudflare.com/disclosure/).
- Vulnerabilities in upstream APIs, identity providers or third-party dependencies. Report them to
  their owners. Tell us too if this project needs a mitigation.
- Modified builds, and deployments configured against the docs.
- Denial of service through traffic volume alone. Use Cloudflare WAF rate limiting
  ([zone settings](docs/operations/cloudflare-zone-settings.md)).

## Hardening checklist for operators

Work through this list for every production deployment. Each item links to the page with the
steps.

1. Generate the keyring key outside Cloudflare and store a copy in your company vault. Losing it
   loses every stored credential ([key rotation](docs/operations/key-rotation.md)). Never use the
   development key from `.dev.vars.example`.
2. Set `AUTH_ACCESS_TEAM_DOMAIN` and `AUTH_ACCESS_AUD` before you add services, and keep their exact
   values with the key. The key is bound to them: a later change makes every stored credential
   impossible to decrypt ([I-CRED-3](docs/threat-model.md#i-cred-3)).
3. Serve the gateway on a custom domain and sign in there first. That hostname becomes the only admin
   host: `/admin` then answers only on the hosts in Settings > "Admin hosts", and never on `workers.dev`
   ([I-DEPLOY-1](docs/threat-model.md#i-deploy-1)) ([configuration](docs/configuration.md#admin-hosts)).
4. In Settings > "Upstream hosts", list the upstream hosts you use. Empty allows any public https
   host ([I-SSRF-1](docs/threat-model.md#i-ssrf-1)) ([configuration](docs/configuration.md#upstream-host-allowlist)).
5. Set operator variables in the Cloudflare dashboard, not as `""` placeholders in `wrangler.jsonc`.
   If you edit `wrangler.jsonc`, run `bash scripts/check-config.sh` before you deploy
   ([configuration](docs/configuration.md)).
6. Until the first owner signs in, the first person through Access becomes owner: limit the Access
   policy to yourself until then. Everyone the policy lets in later
   joins with the join defaults (by default an active viewer); set them to "Pending" in Users to
   approve each new person yourself ([getting started](docs/getting-started.md)).
7. Keep at least two owners, so one lost login does not lock you out. Keep the
   [break-glass](docs/operations/break-glass.md) procedure where your on-call team can find it.
8. Restrict who can deploy the Worker, set its secrets or write to its D1 databases in your
   Cloudflare account. These permissions bypass the admin UI and the audit log
   ([threat model](docs/threat-model.md#actors)).
9. Put a Cloudflare WAF rate-limiting rule on `/admin/*` and `/proxy/*`. Bot Fight Mode can block CI
   callers and cannot be skipped per path: disable it on the gateway zone, or use Super Bot Fight
   Mode with a skip rule for `/proxy/`. Protect `/admin` with a Cloudflare Access application,
   which is the only admin login, and never set `AUTH_ACCESS_DEVELOPMENT` in production
   ([zone settings](docs/operations/cloudflare-zone-settings.md)).
10. Give every caller provider a tenant pin. The gateway requires one on shared issuers, also for
    the `generic` profile ([I-TEN-1](docs/threat-model.md#i-ten-1)) ([policies](docs/policies.md)).
11. Write narrow grants: exact numeric IDs, `ref_protected exact true` on ref and environment
    Conditions, no "pwn request" events, only `POST /` on webhook services with `path` Injection.
    Do not acknowledge a save-time warning you do not understand ([policies](docs/policies.md)).
12. Never grant an endpoint that returns the credential in its response body. Response bodies are
    not redacted ([threat model](docs/threat-model.md#credentials-and-responses)).
13. Send `audit.event` log lines to your SIEM and monitor `/readyz`
    ([observability](docs/observability.md)).
14. Rehearse [incident response](docs/operations/incident-response.md) and
    [credential rotation](docs/operations/credential-rotation.md) before you need them.
15. Watch this repository's security advisories and apply releases promptly
    ([upgrades](docs/operations/upgrades.md)).
