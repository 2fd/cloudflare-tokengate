// Internal: the `current` mark of nav links (SideNav, Tabs). Not exported from the barrel.

/**
 * `aria-current` for a `current` prop: `true` and `'page'` mark the current page, `'true'` an
 * ancestor of a deeper page (a token detail under Tokens). Anything else renders no attribute.
 */
export function ariaCurrent(
  current: boolean | 'page' | 'true' | undefined,
): 'page' | 'true' | undefined {
  if (current === true || current === 'page') return 'page';
  if (current === 'true') return 'true';
  return undefined;
}
