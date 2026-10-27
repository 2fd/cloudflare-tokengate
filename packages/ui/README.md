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

Tones are `Tone` (`ok`, `warn`, `bad`, `info`, `pending`, `off`): `info` is a neutral note, `pending` is waiting on someone (Pending approval, Invited). Status always has a word: `Badge` and `Status` take a `status` from the vocabulary (`src/components/base/vocabulary.ts`: active, expiring, expired, risk-accepted, pending, disabled, no-secret), whose word is the default, or the word as children; their types require one of the two. Color and glyph only add to the word.

## Page-local patterns

Most of design D is in `ui.css` with a component. A few patterns are used by one page of the admin only; they stay with that page until a second page needs them, then they move into `ui.css` with a component and a docs page:

| Page | Page-local classes |
|---|---|
| Shell | `#nf-sections .tcards` (the not-found page's three sections in one row) |
| Monitoring | `.flink` (filter link in a cell), `.find` (Find a request in a page header, a tray header or a panel), `.tray-h > details.disc` (a disclosure as the whole tray header), `#denials .tbl th .arrow` (Top denied callers), `.tbl.log` (one-line request rows), `.notes` (empty install) |
| Tokens | `.rot-row` (secret · expiry · submit in one row), `#tokens > .tray-h > .filters` |
| Consumers | `.con-stack` / `.con-fields` (fields 24px apart), `.con-confirm`, `.con-list`, `.con-tenant`, `ul.operations`, `.tbl th .arrow` (arrow rows on a two-line grid), the give-access gating and review (`.ga-*`), `.nw`, `.d-block` |
| Users | `.u-role-guide` (optional role reference), `.cmap.u-rmap` (the role map: the connections map vocabulary at a 48px pitch), `.trace.u-c3`, `.u-now`, `.u-can` (the yes / no list), `.gain` / `.lose`, `.u-compare`, `.u-person`, `.u-hosts`, `.u-pad`, the `#invite` tray opened by its fragment |

The mechanism: the app keeps them in its own stylesheet (for example `apps/gateway/src/admin/pages.css`), served like `ui.css` with `cssAsset('pages', text)` and linked after it. That stylesheet uses the tokens only (no hard-coded colors, the same `light-dark()` pairs), never restyles a `ui.css` class outside its own page's markup, and keeps the WCAG rules of the system (contrast, forced colors). Promoted already: the grid columns (`Grid`, `Column`), the row menu (`RowMenu`), decision items (`NeedsAttention` `who`), action cards (`ActionCards`), logo radio cards (`RadioCard.logo`), group rows (`GroupRow`), the 7th and 8th live-form fields (`LiveSlot` 1–8), the who-can-use map (`WhoCanUse`), the sparkline (`Sparkline`), compact KPIs (`Kpis columns={2}`), the plan summary (`LiveSummary variant="plan"`), `FieldGrid`, `RailFoot`, `Stack` and the one-button POST form (`ActionForm`).

## Spacing and form composition

Read this section before creating or changing an admin page, form, or layout component.
Use the existing spacing tokens and containers; each container owns spacing at its level.

| Boundary | Required composition | Spacing |
|---|---|---|
| Page blocks | Direct children of `Page`, or `Stack` | `--sp-7` (32px) |
| Related compact blocks | `Stack gap="sm"` | `--sp-4` (16px) |
| Panel edge to form/prose | `Panel variant="pad"` | `--sp-5` (20px) padding |
| Fields in a simple form | `class="fields"` on the form or a field wrapper | `--sp-6` (24px) gap |
| Label, hint, control, error | `Field` / `.field` | `--sp-2` (8px) gap |
| Checkbox and its label | `Checkbox` | `--sp-3` (12px) column gap |
| Adjacent action buttons | `ButtonRow` | `--sp-2` (8px) gap, wraps on small screens |

`Panel` without a variant is a surface with **no padding**. Choose `variant="pad"` for forms
and prose; choose `variant="flush"` for edge-to-edge content such as tables.

`form-layout` is the **page-level form plus summary rail grid**. At 80rem it creates two
columns. Its direct children are the form column and the rail, not individual fields.
A simple settings form uses `.fields` and a width capped at `var(--w-form)` (40rem), keeping
one column at every viewport size. Put the width rule in the page's stylesheet if needed.

Compose a settings panel like this:

```tsx
<Panel variant="pad">
  <form class="fields" method="post">
    {/* Hidden inputs, then Field/Checkbox components. */}
    <Field>{/* control */}</Field>
    <Checkbox name="enabled">Enabled</Checkbox>
    <ButtonRow>
      <Button type="submit" variant="primary">Save</Button>
    </ButtonRow>
  </form>
</Panel>
```

The field stack supplies separation before the action row; `ButtonRow` keeps the button at
its natural width. Scope page-specific CSS to that page, use `--sp-*` tokens, and let one
container own each gap to avoid accumulating child margins and parent gaps.

Before marking a layout change complete, inspect desktop and 390px widths in light and dark:
content clears every panel edge, fields stay in the intended columns, controls and hints fit
without horizontal overflow, and actions have their own space. Check error and disabled states.
If browser verification is unavailable, state that limitation; passing markup tests does not
verify visual spacing.

### Content density

Keep the working content near the page header. When adjacent blocks have different heights,
put each column's continuation in its own `Stack` or use `DetailLayout`. A short notice next to
a tall diagram must not create a shared grid row that pushes a full-width list below the diagram.
Use `Grid` rows for genuinely parallel content, such as related settings cards.

Keep optional explanations in a labelled `Disclosure` after the working content. Keep warnings,
required inputs, errors and primary actions visible. Give compact forms a panel width matching
the form plus its padding; retain the existing field spacing and readable line lengths.
Empty installs may leave unused space after their content; do not stretch panels or add filler
to occupy the viewport. Inspect both sparse and populated states before changing shared spacing.

Layout review (October 2026):

| Pages | Composition and decision |
|---|---|
| Members | Notices followed immediately by full-width Accounts; the role map is an optional disclosure below the list, available with or without pending decisions. |
| Request detail | One continuous main stack and one summary/related rail, replacing two synchronized grid rows. |
| Overview, fresh and populated | Main-column content continues independently of the explanatory or activity rail; health checks no longer wait for the taller neighboring panel. |
| Retention | Request settings beside a stack of summary/audit settings on desktop; one column below the grid breakpoint. |
| Appearance | The branding panel fits the form width plus padding. |
| Requests and Audit lists | Sequential controls and result panels; empty results retain their explanation and action without a fixed-height placeholder. |
| Credentials, credential access rules, issuer access rules lists | Full-width lists/maps; keep usable table width and compact empty-state actions. |
| Allowed hosts and Encryption keys | Policy/list first; the key tools already use a parallel grid with no subsequent content forced below a tall rail. |
| Person, credential and access-rule details | Existing `DetailLayout` columns already flow independently. |
| New credential, new credential access rule, new issuer access rule | Keep the catalog/form and bounded summary rail; required fields remain visible. |
| FAQ | One bounded panel; its anchors stay reachable from the Members login provider tray. |
| Not-found, missing-record and export-error pages | Compact messages/actions; export success is a download, not a layout. |

The October review exercised 16 locally available views at 1440px and 390px in light and dark
(64 combinations), with no document-level horizontal overflow. Also checked the open role guide,
owner/zero-result filters, invitation, invalid request/audit filters and retention dialog in all
four viewport/theme combinations. The local install had no
credentials, access rules or request records: their populated detail layouts were reviewed in
source and integration tests, not visually. The existing person detail was checked in the browser.

Verify desktop and 390px, light and dark, plus open disclosures, sparse/empty results and
error/disabled states where available. Check actual `innerWidth` after browser navigation:
some embedded browsers reset viewport emulation. Record which populated detail states could
only be inspected in source/tests because the local database has no corresponding records.

## Stable filter layout

Read this section before changing list filters, quick links, active chips, or tray headers.
Filter selection changes values and results while retaining the controls' alignment and order.
Quick links keep the same font weight in selected and unselected states to preserve their widths.

- Put list controls in `Tray.bar` (`Filters` / `QuickLinks`); align them to the start edge.
  The shared stylesheet owns this alignment. `Tray.actions` stays at the end with its auto margin;
  showing a clear action must not redistribute the controls across the header.
- Render `ActiveFilters` after the controls. In a tray header it occupies a full row below
  controls and actions. Outside a tray, place it after all filter controls, including quick links.
  The result area may move down as chips wrap; the controls above must keep their position.
- Keep menus available after selection so users can replace a value in place. Preserve other
  query parameters when switching a quick filter. Base option counts and visibility on the
  unfiltered collection, not the current result set.
- Keep a tray title's visibility consistent while its filter bar is present. Put dynamic query
  summaries in the page description; a selection must not insert a heading above the controls.
- `Filters.end` is an explicit compact trailing layout, not a selected-state toggle. Prefer the
  start-aligned default for list filters. Use spacing tokens and natural wrapping, not offsets.

### Filter audit (October 2026)

| Surface | Finding and normalized behavior |
|---|---|
| Accounts | Conditional Clear filters changed flex space distribution; quick links now stay at the start. Search visibility uses the full account collection. |
| Tokens | Active chips shared the controls' flex row; they now take a separate trailing row. Status counts use the scoped collection. |
| Access | Selected credential menus and attention links disappeared; controls now remain available, attention links retain other query parameters, and chips follow them. |
| Requests | Active chips preceded the toolbar and selection revealed its title; chips now follow controls and a stable title remains visible in both states. |
| Audit | Active chips preceded the toolbar; they now follow its controls, which use the start-aligned default. |

Before reporting visual completion, compare unfiltered, selected, multiple-chip, cleared,
zero-result and invalid-input states at desktop and 390px, in light and dark themes. Check
open menus and keyboard focus, and disabled controls where supported. Compare control positions
at the same viewport: clearing or adding a chip must not shift preceding controls. Only viewport
width and the controls' own content should determine wrapping. Record any unavailable checks.

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
