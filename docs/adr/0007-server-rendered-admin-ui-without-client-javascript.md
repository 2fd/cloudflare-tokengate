# 7. Server-rendered admin UI without client JavaScript

This ADR explains why the admin UI is server-rendered HTML with no JavaScript in the browser. It is for security reviewers and contributors.

Date: 2026-10-13

## Status

Accepted

## Context

The admin UI controls which callers may use which credentials. Script injection (XSS) in the admin UI would let an attacker act as an admin: create a grant for their own repository, then use the credential. A single-page application adds a client bundle, a build pipeline, more dependencies and a JSON API that must be protected separately.

The UI is a set of lists and forms used by a few people. It does not need client-side interactivity.

## Decision

- Pages are rendered on the server with Hono JSX (`src/admin/routes/*`, `src/admin/views/*`).
- Every change is a plain HTML form `POST`. A successful change answers with a redirect (POST-redirect-GET). The configuration export (`POST /admin/export`) answers with a file download.
- The Content-Security-Policy is `default-src 'none'; style-src 'self'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'` (`src/http/security.ts`). It has no `script-src`, so the browser runs no script.
- JSX escapes all interpolated text. Biome's `noDangerouslySetInnerHtml` rule is an error (`biome.json`).
- One stylesheet, `public/static/app.css`, is served by Workers Assets.

## Consequences

- An injected `<script>` does not run, even if escaping fails somewhere. Clickjacking is blocked by `frame-ancestors 'none'`.
- Every form carries a `_csrf` token, and the server checks fetch metadata or `Origin` ([I-CSRF-1](../threat-model.md#i-csrf-1)).
- The UI has no live updates, client-side validation or dynamic form rows. Complex inputs use text formats, for example conditions and rules one per line (`src/admin/grant-text.ts`).
- Pages are tested through plain HTTP requests in integration tests, without a browser.
- There is no JSON admin API. Configuration as code is future work ([roadmap.md](../roadmap.md)).
