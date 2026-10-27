## Access rules are the only permission store

`access_rules` is the only place a workload's permission lives, now and in the future. A rule
targets one thing: a credential (Slack, OpenAI, any upstream) or a future target.
The same policy code decides it, and the global access rules of its issuer cap it
([ADR 0029](docs/adr/0029-access-rules-are-the-only-permission-store.md)).

- Do not add a separate rules table, a per-feature policy repository or a JSON policy column.
  To support a new target, add a target column to `access_rules`; the first new target also adds
  the stored `kind` column.
- Do not put a rule editor on a target's page. Rules are created and edited on the access rule
  pages. A target's page lists its rules and links to `/admin/credential-access-rules/new` with the
  target preset.

## UI changes

Before creating or editing admin pages, forms, or layout components, read
[Spacing and form composition](packages/ui/README.md#spacing-and-form-composition) and apply its
container and spacing rules. Verify the listed viewport and state checks before reporting visual completion.

Before adding or changing list filters, quick links, active-filter chips, or tray headers, read
[Stable filter layout](packages/ui/README.md#stable-filter-layout). Preserve control positions
across selection and clearing, and run its viewport/state checks before reporting visual completion.

When changing page composition, apply [Content density](packages/ui/README.md#content-density):
keep each column's content flowing independently and check sparse states for gaps before the main content.
