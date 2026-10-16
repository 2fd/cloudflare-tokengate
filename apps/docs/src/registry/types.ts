// The shape of one component docs page. Every page under /docs/components/<group>/<slug> and every
// nav entry is generated from these records (src/registry/index.ts merges the group files).
import type { Child } from 'hono/jsx';

export type GroupKey = 'base' | 'forms' | 'layout' | 'data' | 'viz';

export interface ComponentDoc {
  /** URL segment, kebab-case and unique in the group: /docs/components/<group>/<slug>. */
  slug: string;
  /** The main export of @tokengate/ui documented here, exactly as exported ("PageHeader"). */
  name: string;
  /** Other exports documented on the same page (parts, variants, helpers), exactly as exported. */
  related?: readonly string[];
  /** One sentence: what it is. Shown under the title and on the group page. */
  summary: string;
  /** When to use it, and when to use something else instead (name the other component). */
  usage: { when: readonly Child[]; whenNot?: readonly Child[] };
  /** Live examples: every variant and every state, each rendered from the real component. */
  examples: readonly ComponentExample[];
  /** One props table per documented export (main first, then `related` ones). */
  props: readonly PropsTable[];
  /** What the component wires for assistive tech, and what the caller must still provide. */
  accessibility: readonly Child[];
  /** Usage rules, shown side by side. */
  do: readonly Child[];
  dont: readonly Child[];
  /** The ui.css classes it renders, for markup written by hand. */
  classes: readonly string[];
}

export interface ComponentExample {
  /** Variant or state name ("Warn tone", "Disabled"). Heading of the example. */
  title: string;
  description?: Child;
  /** Renders the example with the real component. Ids must be unique on the page. */
  render: () => Child;
  /** The JSX a developer types for this example; shown escaped under it. Keep it in sync. */
  code: string;
  /**
   * Canvas layout: `row` (default) wraps items in a row; `stack` puts them in a column; `frame` is
   * a full-width page-background frame for shells, page headers and anything that needs `.main`.
   */
  layout?: 'row' | 'stack' | 'frame';
}

export interface PropsTable {
  /** Export the props belong to ("Tray"). */
  component: string;
  props: readonly PropDoc[];
}

export interface PropDoc {
  name: string;
  /** TypeScript type as written in the props interface. */
  type: string;
  required?: boolean;
  /** Default value as code (`'neutral'`), when there is one. */
  default?: string;
  description: Child;
}

export interface GroupInfo {
  key: GroupKey;
  label: string;
  /** One sentence for the group page and the overview. */
  description: string;
}
