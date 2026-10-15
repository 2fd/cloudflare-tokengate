# 19. Admin information architecture and URL scheme

This ADR explains how the admin UI is divided into sections, which URLs the pages have, why old URLs get a 404 page and not a redirect, and how pages build links to each other. It is for contributors who add admin pages and for operators who have bookmarks to the old pages. It extends the RBAC table of [I-RBAC-1](../threat-model.md#i-rbac-1).

Date: 2026-10-14

## Status

Accepted

## Context

The admin UI had one flat navigation with eight entries: Dashboard, Services, Caller providers, Grants, Requests, Audit log, Users and Settings. Settings held unrelated things: retention and sampling, the upstream host allowlist, the admin hosts, the encryption keys and re-encryption, the system status and the configuration export. A token manager who needed the allowlist and an owner who needed the admin hosts went to the same page and read past everything else.

The URL names were the internal names (`services`, `caller-providers`, `grants`), not the names people use for the things: a service token, a service consumer, consumer access. Each page also wrote the URLs of the other pages by hand, so a rename touched every page.

`test/security/rbac-routes.test.ts` requires the RBAC table and the registered routes to be a bijection, and every allowed GET to answer 200. A redirect route would have to be in the table and would answer 3xx.

## Decision

- **Four sections,** each with its own pages:

  | Section | Root | Pages |
  |---|---|---|
  | Monitoring | `/admin` | Overview, Requests (`/admin/requests`), Audit log (`/admin/audit`), Data retention (`/admin/retention`) |
  | Users | `/admin/users` | People, Sign-in (`/admin/users/sign-in`) |
  | Service tokens | `/admin/tokens` | Tokens, Allowed hosts (`/admin/tokens/hosts`), Encryption keys (`/admin/tokens/keys`) |
  | Service consumers | `/admin/consumers` | Consumers, Consumer access (`/admin/access`) |

  The configuration export (`POST /admin/export`) is a form in the page footer, for holders of `config:export`.
- **Settings is removed.** Retention, sampling and the row cap go to Data retention. The upstream host allowlist goes to Allowed hosts. The keyring, the key check values and re-encryption go to Encryption keys. The admin hosts and the login provider status go to Sign-in. The system status goes to the Overview (`#health`). The "first owner" row is dropped.
- **URL names follow the UI names:** `/admin/services` becomes `/admin/tokens`, `/admin/caller-providers` becomes `/admin/consumers`, and `/admin/grants` becomes `/admin/access`. Query parameters follow too: `token` for a service id, `consumer` for a caller provider id, `type` for a consumer profile.
- **No redirects.** The project is before 1.0, so old URLs are not kept. An unlisted GET or HEAD under `/admin` gets a 404 "Page not found" page. It links to the four sections and, when the path starts with an old prefix, shows a static hint that names the new page. The hint comes from a constant table and the path is never echoed. An unlisted request with any other method stays 403. The 404 page is rendered by the admin middleware after sign-in and user resolution, so no handler runs (fail closed).
- **One link contract.** `src/admin/paths.ts` builds every admin URL. Query values are encoded with `URLSearchParams`, empty values are left out, and the fragment comes last. A section never writes another section's URL by hand.
- **`_return`.** A row action that is posted from more than one page carries a hidden `_return` from a closed set per route (for example `list` or `detail`). `returnPath` maps it to a fixed path. It is never a URL, and an unknown value falls back to the route's default, so it cannot be an open redirect.
- **Registration order.** The admin middleware takes the permission of the first matched route. Static segments are registered before `:id`: Sign-in before Users, and Allowed hosts and Encryption keys before Tokens. `test/integration/admin-route-order.test.ts` pins the order.

## Consequences

- Bookmarks and documentation links to the old URLs answer 404, with a hint to the new page. Operators update their bookmarks once.
- A page that moves changes one builder in `paths.ts`; the links and redirects that use it follow.
- A static segment registered after its `:id` sibling would take the `:id` route's permission, for example `tokens:write` for an allowlist change that needs `settings:write`. The route-order test catches that.
- The RBAC table stays a bijection with the registered routes, and each section owns one block of it.
- The 404 page shows the signed-in shell, so a person who follows an old link stays in the console.
