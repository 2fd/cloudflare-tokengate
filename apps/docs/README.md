# @tokengate/docs

The `tokengate-docs` Worker: documentation of the design system in [`packages/ui`](../../packages/ui/README.md), served under `/docs`. It uses the design system for its own chrome.

- Run: `pnpm docs:dev` (from the repository root), then open <http://localhost:8790/docs>. Deploy: `pnpm docs:deploy`.
- Routes: `/docs` (overview), `/docs/foundations/<topic>`, `/docs/components/<group>`, `/docs/components/<group>/<slug>`, `/static/<name>.<hash>.css`. `/` redirects to `/docs`.
- Component pages are generated from `src/registry/<group>.tsx` (one file per group, merged by `src/registry/index.ts`) through the template in `src/pages/component.tsx`. Foundations are `src/foundations/<topic>.tsx`, listed in `src/foundations/index.ts`.
- `src/styles/docs.css` styles the docs chrome only (`dx-` classes). Components never depend on it.
- Headers: `src/security.ts` (CSP without `script-src`, `style-src 'self'`, no framing).
