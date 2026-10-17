# @tokengate/ui

Design system D for tokengate: one stylesheet and server-rendered Hono JSX components. There is no client JavaScript: the apps' CSP has no `script-src` and only `style-src 'self'`.

The documentation is [`packages/docs`](../docs/README.md) (`@tokengate/docs`). The gateway serves it in local development only: `pnpm dev`, then open <http://localhost:8787/docs>. Deploys never include it.

## Layout

```text
packages/ui/
  src/
    index.ts                  Re-exports the five group barrels and lib/. Do not edit.
    css.ts                    @tokengate/ui/css: uiCss (text, hash, href), cssAsset(), serveCss().
    text-modules.d.ts         Declares `*.css` imports as strings (this package's typecheck).
    styles/ui.css             The stylesheet. Product only; served at /static/ui.<hash>.css.
    lib/                      cx(), idList(), contentHash(), HeadingOffset, BaseProps, Tone, HiddenFields;
                              internal: heading levels, hidden fields, screen-reader text.
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
| `base` | Button, ButtonRow, LinkAction (`.linkish`), Badge, Status (`.st`), Dot, RiskTag, Chip, Chips, Logo, LogoStack, Icon, IdChip, Slug, Mono, Kbd, Mask, Avatar, Callout, Notice, AskSomeone, CodeBlock | 4, 5, 8 (except `.empty`, `.oneline`), the `pre.code` / `.code-cap` lines of 9 |
| `forms` | Field, FieldSet, FieldError, FieldGrid, Input, Textarea, Select, Checkbox, FieldInline, RadioCards, ActionCards, RowPicker, Or, Picks, CheckPresets, SelectedCount, Reveal, SubBox, More, Stepper, FormStep, the live form (LiveForm, LiveSummary, SummaryRow, SummaryWire, SummaryFoot, LivePhrase, RiskSwitch), RiskAcceptance, FixedBar, Inherit, SubmitRow, ActionForm, ErrorSummary, TypeCatalog, TypeCard, CatalogGroup, LinkCards (`.tcards`) | 9, 10 |
| `layout` | AppShell, SideNav, HealthLine, HealthStrip, AccountMenu, Menu, MenuItem, MenuSeparator, RowMenu, MenuHeader, Page, Grid, Column, Stack, PageHeader, Breadcrumbs, Identity (`.ident`), RelationLine, TabRow, Tabs, Segmented, Tray, Panel, DetailLayout, DangerZone, DangerRow, Disclosure, Dialog, ConfirmDialog, DialogTrigger, DialogClose | 2, 3, 6, 13 |
| `data` | Table, Row, RowHeader, Cell, GroupRow, Entity, CountLink, Result, Filters, FilterSearch, AddFilter, ActiveFilters, QuickLinks, Pager, EmptyState, ZeroState, KeyValue, RailKeyValue, RailFoot, Secret, Feed, FeedItem, FeedDay, DiffTable, Time | 7, 11, 12, `.empty` / `.oneline` in 8 |
| `viz` | NeedsAttention, Pipeline, Kpis, Delta, Chart, ChartPatterns, Legend, Sparkline, ReasonBar, ConnectionsMap, WhoCanUse, Matrix, Checklist, ChecklistProgress, Trace, NextStep, ArrowRow | 14, 15, 16 |

Export names are unique across groups: the root barrel re-exports every group with `export *`, so a name two groups export fails the typecheck. Sections 0 (tokens), 1 (base), 17 (responsive) and 18 (forced colors) have no owner: put a component's responsive rules in a `@media` block at the end of the component's own section instead of in 17, and change tokens only with a contrast check (the token contrast test must stay green). Some base components draw with classes that live in other groups' sections (`.avatar` in 2, `.idchip` and `.slug` in 3, `.mask` in 11): change those rules together with the base owner.

Two overlaps are deliberate: `Disclosure variant="more"` (layout) and `More` (forms) render the same `details.more`; use `More` inside forms and `Disclosure` elsewhere. Pages that show a `Chart` or a `ReasonBar` render `ChartPatterns` once, from their layout (the docs layout does).

## Component conventions

- **Function components with typed props.** `export function Name(props: NameProps)` and `export interface NameProps`. Export both from the group barrel: `export { Name, type NameProps } from './Name';`.
- **One file per component** in `src/components/<group>/<Name>.tsx` (PascalCase, the export name). Small parts that only make sense with it (`SideNavItem` types, a `Tab` of `Tabs`) stay in the same file.
- **Children and class passthrough.** Content goes in `children` (`Child` from `hono/jsx`) or in named slot props (`actions`, `footer`, `description`). Every component takes `class?: string` and appends it to its own classes on the root element with `cx()`: it never replaces them.
- **Markup is ui.css markup.** The reference is the docs (`pnpm dev`, <http://localhost:8787/docs>): every component in every state, with its JSX, its props and the classes it renders. It replaces the design files of design D, which are not in this repository. A visual change is a change to `ui.css`, never a per-call style.
- **One name per idea, across the package.** Prop names mean the same thing in every component:
  - `headingLevel` (2 | 3 | 4): the level of the component's heading. Containers (Tray, TypeCatalog, DangerZone, Dialog) shift the headings inside them one level under their title, and `HeadingOffset` shifts a whole block (the docs examples). The page H1 belongs to `PageHeader` alone.
  - `srPrefix` / `srSuffix`: visually hidden text read before / after the visible label. The component adds the separating space (none before punctuation).
  - `hidden` (`HiddenFields`, name → value): the hidden inputs of every component that renders its own `<form>`. Pass the `_csrf` token here: the gateway refuses an unsafe request without it.
  - `logo` (`LogoSpec`: a brand, or `{ brand, text?, disabled? }`): every component draws the tile at its own size. `logoSlot` (a node) exists only where a custom node is needed: an `Avatar`, a decorative `LivePhrase`.
  - `glyph` is a string (`✓`, `⌛`); `icon` is an `IconName` of the one icon set.
- **Compose, do not copy.** A component that shows another one's markup renders that component (Secret renders Mask, NextStep renders Chip, ConfirmDialog renders Button), so a fix reaches every use.
- **No inline styles, no client JS.** No `style=`, no `<style>`, no `<script>`, no `on*=` attributes, no `dangerouslySetInnerHTML` (an oxlint error). Interaction uses links, forms, `<details>`, `<dialog>` with `commandfor`/`command`, `popover`, `:has()`.
- **Accessible by default.** The component wires ids and ARIA from its props: a field takes `id` and derives `${id}-hint` and `${id}-error`, then lists only the rendered ones in `aria-describedby` (`idList()`); a tray takes `id` and labels the section with its heading (`${id}-h`); the current item gets `aria-current`. Required accessible names are required props (`CodeBlock.label`). Glyphs are `aria-hidden` and the word stays.
- **Status words.** See [Status words](#status-words).
- **Escaping.** Hono JSX escapes text. Pass user data as text, never as markup.
- **Synchronous.** Components do not fetch or await: pages pass data in.
- **Tests.** `test/<group>/<name>.test.tsx`, Vitest in Node: render with `render()` from `test/render.ts` and assert on the HTML (classes, ids, ARIA, escaping, every variant).

## Status words

Tones are `Tone` (`ok`, `warn`, `bad`, `info`, `off`). Status always has a word: `Badge` and `Status` take a `status` from the vocabulary (`src/components/base/vocabulary.ts`: active, expiring, expired, risk-accepted, pending, disabled, no-secret), whose word is the default, or the word as children; their types require one of the two. Color and glyph only add to the word.

## Page-local patterns

Most of design D is in `ui.css` with a component. A few patterns are used by one page of the admin only; they stay with that page until a second page needs them, then they move into `ui.css` with a component and a docs page:

| Page | Page-local classes |
|---|---|
| Shell | `#nf-sections .tcards` (the not-found page's four sections as a 2 × 2 grid) |
| Monitoring | `.flink` (filter link in a cell), `.find` (Find a request in a page header, a tray header or a panel), `.tray-h > details.disc` (a disclosure as the whole tray header), `#denials .tbl th .arrow` (Top denied callers), `.tbl.log` (one-line request rows), `.notes` (empty install) |
| Tokens | `.rot-row` (secret · expiry · submit in one row), `#tokens > .tray-h > .filters` |
| Consumers | `.con-stack` / `.con-fields` (fields 24px apart), `.con-types`, `.con-preset`, `.con-confirm`, `.con-list`, `.con-tenant`, `ul.operations`, `.tbl th .arrow` (arrow rows on a two-line grid), the give-access gating and review (`.ga-*`), `.nw`, `.d-block` |
| Users | `.cmap.u-rmap` (the role map: the connections map vocabulary at a 48px pitch), `.trace.u-c3`, `.u-now`, `.u-can` (the yes / no list), `.gain` / `.lose`, `.u-compare`, `.u-person`, `.u-hosts`, `.u-pad`, the `#invite` tray opened by its fragment |

The mechanism: the app keeps them in its own stylesheet (for example `apps/gateway/src/admin/pages.css`), served like `ui.css` with `cssAsset('pages', text)` and linked after it. That stylesheet uses the tokens only (no hard-coded colors, the same `light-dark()` pairs), never restyles a `ui.css` class outside its own page's markup, and keeps the WCAG rules of the system (contrast, forced colors). Promoted already: the grid columns (`Grid`, `Column`), the row menu (`RowMenu`), decision items (`NeedsAttention` `who`), action cards (`ActionCards`), logo radio cards (`RadioCard.logo`), group rows (`GroupRow`), the 7th and 8th live-form fields (`LiveSlot` 1–8), the who-can-use map (`WhoCanUse`), the sparkline (`Sparkline`), compact KPIs (`Kpis columns={2}`), the plan summary (`LiveSummary variant="plan"`), `FieldGrid`, `RailFoot`, `Stack` and the one-button POST form (`ActionForm`).

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
5. Add its docs page: one `ComponentDoc` entry in `packages/docs/src/registry/<group>.tsx` (type in `packages/docs/src/registry/types.ts`). Fill every field: `slug` (kebab-case), `name` (the export), `related` (other exports on the same page), `summary`, `usage.when` / `usage.whenNot`, `examples` (every variant and state; each has `render`, the matching `code` string and a `layout` of `row`, `stack` or `frame`), `props` (one table per export, main first, then `related` in order), `accessibility`, `do`, `dont`, `classes`. Ids inside examples must be unique on the page; a full shell uses `landmarks={false}`.
6. Run `pnpm check`. The docs registry test fails when an exported component has no docs page, when a documented name is not exported by the group barrel, or when a template section is empty. The props test fails when a props table does not list exactly the props the component declares (read from this package's source). The route and outline tests render every page and reject scripts, inline styles, a second `<main>` or `<h1>`, a skipped heading level, two landmarks with one name, a reference to a missing id and a table without a name.
7. Look at the page in `pnpm dev` (<http://localhost:8787/docs>) in light, dark and at 390px.

The nav, the group page and the route come from the registry: there is nothing else to register.
