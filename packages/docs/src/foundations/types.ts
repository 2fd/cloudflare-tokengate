import type { Child } from 'hono/jsx';

export interface Foundation {
  /** URL segment: /docs/foundations/<slug>. */
  slug: string;
  /** Nav label and H1. */
  title: string;
  /** One sentence under the H1. */
  summary: string;
  /** The page body: trays under the header. */
  render: () => Child;
}
