# 22. Admin UI on design system D

This ADR explains how the admin pages are built from the design system package `@tokengate/ui` (design D): the shell, the order of the sections, where the configuration export went, and how the stylesheet is served. It is for contributors who change admin pages and for reviewers of the admin UI. It amends the section order and the export placement of [ADR 0019](0019-admin-information-architecture.md) and the stylesheet line of [ADR 0007](0007-server-rendered-admin-ui-without-client-javascript.md).

Date: 2026-10-17

## Status

Accepted

## Context

The admin UI had a top bar with the four sections, a row of section tabs under it, a health strip, and a footer with the version and the configuration export. One stylesheet, `apps/gateway/public/static/app.css`, styled bare elements (`button`, `table`, `h1`) and was served by Workers Assets. Reviewers rejected the look: every block looked the same, infrastructure problems sat above the page title, the header blocks did not line up, and buttons were weak.

Design D (sidebar navigation, centered content, one primary button per page) was approved. Its components are in `packages/ui` (`@tokengate/ui`), with one stylesheet, `ui.css`, that uses its own class names and tokens. The docs app (`packages/docs`) shows every component.

`app.css` and `ui.css` define tokens with the same names and style the same elements, so one page cannot link both without the old rules restyling the new components.

## Decision

- **The shell is the ui `AppShell`.** Every signed-in page renders `AppShell` (`apps/gateway/src/admin/views/layout.tsx`): the instance block with the request host, the health line, the `SideNav` of the four sections, and the `AccountMenu` at the bottom of the sidebar. The health strip (error-level problems only, not announced as an alert) is at the top of `main`. The content is one centered `Page`: the page's own `PageHeader` (the only `h1`), then the `ErrorSummary`, then the notice, then the body (`PageProps.header`, `apps/gateway/src/admin/render.tsx`).
- **Section order is Monitoring, Service tokens, Service consumers, Users.** This replaces the order of ADR 0019 (Users second). The product's core is in the middle; Users is an owner task. The URLs do not change.
- **The section pages move into the sidebar.** The open section shows its pages as sidebar items (`aria-current="page"` on the page, `"true"` on a deeper page such as a token under Tokens). There is no row of section tabs. Page-header tabs are only for the views of one object or one list.
- **The configuration export is in the account menu.** "Export configuration" is a `MenuItem` that posts `POST /admin/export` with `_csrf` (I-CSRF-1), shown only to holders of `config:export`. The menu also holds Docs (the section's docs page) and Sign out (the Access logout link, when the login has one). There is no footer. The menu never opens a dialog.
- **The Worker serves the stylesheets.** `ui.css` and the admin's page-local `pages.css` are bundled as text (wrangler `rules`, Text) and served by a Worker route at `/static/<name>.<hash>.css` with `cache-control: immutable`, and at the stable `/static/<name>.css` with revalidation (`apps/gateway/src/http/static.ts`, `@tokengate/ui/css`). The security headers apply to them, and they are never under `/admin`. `app.css`, `apps/gateway/public/`, the `assets` block of `wrangler.jsonc` and the `ASSETS` binding are removed.
- **One switch for every page.** The shell links only `ui.css` and `pages.css`. Every section is built on `@tokengate/ui`: no page keeps the old markup, and the transitional page props (the old breadcrumbs and the header slot for the find form) are removed. A page without its own `header` gets a `PageHeader` with its title only.
- **Shared adapters stay small.** `apps/gateway/src/admin/views/components.tsx` keeps an adapter only where the admin adds behavior: the field id convention (`f-a-b`), conditional validation (A7.6), secret inputs (A7.8), the status vocabulary, who to ask (`AskSomeone`), confirm dialogs that always send `confirm=1`, and the not-found texts. Pages use `@tokengate/ui` directly for everything else. `pages.css` has one block per section; a section edits only its own block and uses ui tokens only.

## Consequences

- Every page has the same sidebar, and only the open section and the current item change. Section links, counts and the decision pill are in one place.
- The health line names errors, warnings or notes from the same alert catalogue as the Overview, so every page, the 403 and 404 pages included, loads the alert data: one D1 batch of eight statements, the count of people who need a decision, the first pending people, and one telemetry query. The shell also reads the sidebar counts and the people AskSomeone names. The keyring and schema status are cached per isolate. The Overview passes its own copy to the shell.
- When the alert data does not load (for example, `DB` is behind on a migration that one of its queries needs), the page still renders: the strip shows what needs no table (keyring, schema status, configuration errors), and the health line says "Health not checked" or counts those problems.
- Workers Assets is no longer used. [ADR 0003](0003-cloudflare-workers-and-two-d1-databases.md) lists it as a dependency; its note points here.
- Tests check markup and behavior, not looks. Visual changes are checked with screenshots in light, dark and at 390px against the approved design.
- Operators who used the footer export find it in the account menu. The 404 hint for `/admin/settings` says so.
- A stylesheet change is a deploy: the hashed URL changes with the content, so browsers load the new file at once and cache it for a year.
- The CSP is unchanged: `style-src 'self'` covers the Worker's `/static` route.

## Note (2026-10-17)

[ADR 0024](0024-secret-reveal-over-ecdh.md) amends two parts of this decision. `/static` also serves one script, `reveal.client.js`, at an exact hashed URL with an immutable cache; every other `/static/*.js` path is a 404. The CSP is no longer the same on every page: the token detail page of a person with reveal on that token adds an exact `script-src` and `connect-src`. `packages/ui` stays free of JavaScript. [ADR 0023](0023-teams-replace-roles.md) adds the Teams page to the Users section, and the account menu shows the person's teams instead of a role.
