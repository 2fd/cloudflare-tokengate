# @tokengate/docs

Documentation of the design system in [`packages/ui`](../ui/README.md), served under `/docs`. It uses the design system for its own chrome.

It is a library, not a Worker: `createDocsApp()` returns a Hono app that answers `/docs` and every path below it. The gateway serves it in local development only. Production never has it (invariant [I-DEPLOY-2](../../docs/threat-model.md#i-deploy-2)).

- Run: `pnpm dev` (from the repository root), then open <http://localhost:8787/docs>. `pnpm dev` runs `wrangler dev src/dev.ts` in `apps/gateway`. `apps/gateway/src/dev.ts` sends `/docs` and `/docs/*` to this app when the request hostname is `localhost`, `127.0.0.1` or `[::1]`, and every other request to the production entry `apps/gateway/src/index.ts`.
- Deploy: never. `pnpm run deploy` deploys `wrangler.jsonc` `main` (`src/index.ts`), which does not import this package, so `/docs` answers 404 in production. `@tokengate/docs` is a devDependency of the gateway and only `src/dev.ts` imports it.
- Routes: `/docs` (overview), `/docs/foundations/<topic>`, `/docs/components/<group>`, `/docs/components/<group>/<slug>`, `/docs/static/<name>.<hash>.css`. The stylesheets are under `/docs/static/`, not `/static/`, where the gateway serves the admin stylesheets.
- Component pages are generated from `src/registry/<group>.tsx` (one file per group, merged by `src/registry/index.ts`) through the template in `src/pages/component.tsx`. Foundations are `src/foundations/<topic>.tsx`, listed in `src/foundations/index.ts`.
- `src/styles/docs.css` styles the docs chrome only (`dx-` classes). Components never depend on it.
- Headers: `src/security.ts` (CSP without `script-src`, `style-src 'self'`, no framing, `no-store` pages).
- Tests: `pnpm --filter @tokengate/docs test` (Vitest in Node, routes through `app.request()`).
