## UI changes

Before creating or editing admin pages, forms, or layout components, read
[Spacing and form composition](packages/ui/README.md#spacing-and-form-composition) and apply its
container and spacing rules. Verify the listed viewport and state checks before reporting visual completion.

Before adding or changing list filters, quick links, active-filter chips, or tray headers, read
[Stable filter layout](packages/ui/README.md#stable-filter-layout). Preserve control positions
across selection and clearing, and run its viewport/state checks before reporting visual completion.

When changing page composition, apply [Content density](packages/ui/README.md#content-density):
keep each column's content flowing independently and check sparse states for gaps before the main content.
