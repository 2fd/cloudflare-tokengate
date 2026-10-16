# @tokengate/ui

Design system D for tokengate: one stylesheet and server-rendered Hono JSX components. There is no client JavaScript: the apps' CSP has no `script-src` and only `style-src 'self'`.

The documentation is the `apps/docs` Worker: `pnpm docs:dev`, then open <http://localhost:8790/docs>.

## Layout

```text
packages/ui/
  src/
    index.ts                  Re-exports the five group barrels and lib/. Do not edit.
    css.ts                    @tokengate/ui/css: uiCss (text, hash, href), cssAsset(), serveCss().
    text-modules.d.ts         Declares `*.css` imports as strings (this package's typecheck).
    styles/ui.css             The stylesheet. Product only; served at /static/ui.<hash>.css.
    lib/                      cx(), idList(), contentHash(), BaseProps, Tone.
    components/<group>/       One file per component: <Name>.tsx. One barrel: index.ts.
  test/<group>/               Vitest (Node) tests per group, e.g. test/base/badge.test.tsx.
  test/styles/css.test.ts     Stylesheet: serving, product-only content, token contrast.
  vite-css-text.ts            Vitest plugin: `import x from './a.css'` is a string, as in wrangler.
```

Package entry points:

| Import | What |
|---|---|
| `@tokengate/ui` | Every component and the `lib/` helpers. |
| `@tokengate/ui/<group>` | One group barrel (`base`, `forms`, `layout`, `data`, `viz`). |
| `@tokengate/ui/css` | `uiCss`, `cssAsset`, `serveCss`. The only entry that imports the CSS text. |
| `@tokengate/ui/vite-css-text` | `cssAsText()`, for an app's `vitest.config.ts`. |

## Groups

Each group owns its folder, its barrel, its tests, its docs registry file and its CSS sections. Agents and contributors who work on one group touch nothing else, so groups merge without conflicts.

| Group | Components | `ui.css` sections |
|---|---|---|
| `base` | Button, ButtonRow, Badge, StatusDot (`.st`), RiskTag, Chip, Logo, LogoStack, IdChip, Slug, Mask, Avatar, Callout, Notice, AskSomeone, CodeBlock, Kbd, LinkAction (`.linkish`) | 4, 5, 8 (except `.empty`, `.oneline`), the `pre.code` / `.code-cap` lines of 9 |
| `forms` | Field, Input, Select, Textarea, FieldInline, RadioCards, RowPicker, Picks, CheckPresets, Check, FixedBar, Inherit, SubBox, More, RiskAcceptance, SubmitRow, Stepper, TypeCatalog, LinkCards (`.tcards`), live form (`.lform`, summary rail), Filters, Search, AddFilter, ActiveFilters, QuickLinks, Dialog | 9, 10, 12, 13 |
| `layout` | AppShell, SideNav, HealthLine, AccountMenu, HealthStrip, Page, PageHeader, Breadcrumbs, Identity (`.ident`), Tabs, Segmented, RelationLine, Tray, Panel, DangerZone, Disclosure, DetailLayout, FormLayout, Rail, Grid, Checklist (Get started) | 2, 3, 6, 16 |
| `data` | Table (+ cell helpers: Entity, Num, Actions, Pager), EmptyState, ZeroState, KeyValue, RailKeyValue, Feed, Secret, DiffTable | 7, 11, `.empty` / `.oneline` in 8 |
| `viz` | Kpis, Chart, Reasons bar, Legend, Pipeline, NeedsAttention, Trace, NextStep, ArrowRow, ConnectionsMap, Matrix | 14, 15 |

The component names are a starting list from the design reference; a group may merge or split them. Sections 0 (tokens), 1 (base), 17 (responsive) and 18 (forced colors) have no owner: put a component's responsive rules in a `@media` block at the end of the component's own section instead of in 17, and change tokens only with a contrast check (the token contrast test must stay green).

Minimal versions already exist, made for the docs chrome: `base/Badge`, `base/CodeBlock`, `layout/AppShell`, `layout/SideNav`, `layout/Page`, `layout/PageHeader`, `layout/Breadcrumbs`, `layout/Tray`, `layout/Panel`. Their owners complete them (for example AppShell's health line and account menu, PageHeader's identity row) and keep their current props working: the docs chrome uses them.

## Component conventions

- **Function components with typed props.** `export function Name(props: NameProps)` and `export interface NameProps`. Export both from the group barrel: `export { Name, type NameProps } from './Name';`.
- **One file per component** in `src/components/<group>/<Name>.tsx` (PascalCase, the export name). Small parts that only make sense with it (`SideNavItem` types, a `Tab` of `Tabs`) stay in the same file.
- **Children and class passthrough.** Content goes in `children` (`Child` from `hono/jsx`) or in named slot props (`actions`, `footer`, `description`). Every component takes `class?: string` and appends it to its own classes on the root element with `cx()`: it never replaces them.
- **Markup is ui.css markup.** Render exactly the classes and structure of the design reference (`d-system.md`, class reference, and `d-components.html`, every component in every state; both come with the design, outside this repository). A visual change is a change to `ui.css`, never a per-call style.
- **No inline styles, no client JS.** No `style=`, no `<style>`, no `<script>`, no `on*=` attributes, no `dangerouslySetInnerHTML` (an oxlint error). Interaction uses links, forms, `<details>`, `<dialog>` with `commandfor`/`command`, `popover`, `:has()`.
- **Accessible by default.** The component wires ids and ARIA from its props: a field takes `id` and derives `${id}-hint` and `${id}-error`, then lists only the rendered ones in `aria-describedby` (`idList()`); a tray takes `id` and labels the section with its heading (`${id}-h`); the current item gets `aria-current`. Required accessible names are required props (`CodeBlock.label`). Glyphs are `aria-hidden` and the word stays.
- **Status words.** Tones are `Tone` (`ok`, `warn`, `bad`, `info`, `off`). The word is always a prop or child; color and glyph only add to it.
- **Escaping.** Hono JSX escapes text. Pass user data as text, never as markup.
- **Synchronous.** Components do not fetch or await: pages pass data in.
- **Tests.** `test/<group>/<name>.test.tsx`, Vitest in Node: render with `render()` from `test/render.ts` and assert on the HTML (classes, ids, ARIA, escaping, every variant).

## Serving the stylesheet

Workers cannot read files at runtime, so the CSS is imported as a string and served from a route. Same-origin, so it works with `style-src 'self'`.

1. In the app's `wrangler.jsonc`: `"rules": [{ "type": "Text", "globs": ["**/*.css"], "fallthrough": true }]`, then `pnpm types` (it declares `*.css` modules for the app).
2. A route (Hono):

   ```ts
   import { serveCss, uiCss } from '@tokengate/ui/css';

   app.get('/static/:file', (c) =>
     serveCss([uiCss], c.req.path, c.req.header('if-none-match')) ?? c.notFound(),
   );
   ```

   `uiCss.href` (`/static/ui.<hash>.css`) is served with `cache-control: public, max-age=31536000, immutable`, `uiCss.stablePath` (`/static/ui.css`) with revalidation and an ETag, both as `text/css; charset=utf-8` with `nosniff`. Another stylesheet is `cssAsset('docs', text)`.
3. In the document head: `<link rel="stylesheet" href={uiCss.href} />`.
4. In the app's `vitest.config.ts`: `plugins: [cssAsText()]` from `@tokengate/ui/vite-css-text`.

The gateway already has the rule. Its static assets answer `/static/*` before the Worker (`run_worker_first` excludes it), so when the gateway adopts this package, either drop `!/static/*` for the UI stylesheet or serve it under another prefix.

## Add a component (group owners)

1. Create `src/components/<group>/<Name>.tsx` with `NameProps` and `Name`, following the conventions above.
2. Export both from `src/components/<group>/index.ts`.
3. If the component needs CSS that is missing or wrong, change `src/styles/ui.css` in your group's sections only.
4. Add `test/<group>/<name>.test.tsx`: every variant and state, ids and ARIA, class passthrough.
5. Add its docs page: one `ComponentDoc` entry in `apps/docs/src/registry/<group>.tsx` (type in `apps/docs/src/registry/types.ts`). Fill every field: `slug` (kebab-case), `name` (the export), `related` (other exports on the same page), `summary`, `usage.when` / `usage.whenNot`, `examples` (every variant and state; each has `render`, the matching `code` string and a `layout` of `row`, `stack` or `frame`), `props` (one table per export, main first, then `related` in order), `accessibility`, `do`, `dont`, `classes`. Ids inside examples must be unique on the page; a full shell uses `landmarks={false}`.
6. Run `pnpm check`. The docs registry test fails when an exported component has no docs page, when a documented name is not exported by the group barrel, or when a template section is empty. The route test renders every page and rejects scripts, inline styles and a second `<main>`.
7. Look at the page in `pnpm docs:dev` in light, dark and at 390px.

The nav, the group page and the route come from the registry: there is nothing else to register.
