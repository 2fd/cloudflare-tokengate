// Links to the project documentation. Every docs link in the admin UI is built from DOCS_BASE, so
// the target is a real page and not a repository-relative path that only makes sense in a clone.

export const DOCS_BASE = 'https://github.com/2fd/cloudflare-tokengate/blob/main/docs/';

/** `path` is relative to docs/, for example `concepts.md#grant` or `operations/upgrades.md`. */
export function docsUrl(path: string): string {
  return `${DOCS_BASE}${path.replace(/^\/+/, '')}`;
}
