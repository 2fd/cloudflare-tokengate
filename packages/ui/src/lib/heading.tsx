// Heading levels. Every component that renders a heading takes `headingLevel` (2 | 3 | 4) with a
// default for its usual place, and shifts it by the offset of the context around it. A Tray, a
// TypeCatalog or a DangerZone sets that offset for its children, so a heading inside them is one
// level deeper than their title without the page passing levels down by hand. Docs and other
// hosts that draw a whole page inside their own outline wrap it in `HeadingOffset`.
import { createContext, useContext, type Child } from 'hono/jsx';

/** The levels a component heading takes. The page H1 belongs to the page header alone. */
export type HeadingLevel = 2 | 3 | 4;

const HeadingOffsetContext = createContext(0);

/** The rendered level of a heading: its own level plus the offset around it, at most h6. */
export function useHeadingLevel(level: number): number {
  return Math.min(6, Math.max(1, level + useContext(HeadingOffsetContext)));
}

/**
 * Renders `children` with their headings `by` levels deeper (internal to containers such as Tray:
 * a tray whose title is an h3 passes `by` 1, so the h3s inside it become h4s).
 */
export function HeadingScope(props: { by: number; children?: Child }) {
  const outer = useContext(HeadingOffsetContext);
  return (
    <HeadingOffsetContext.Provider value={outer + props.by}>
      {props.children}
    </HeadingOffsetContext.Provider>
  );
}

export interface HeadingOffsetProps {
  /**
   * How many levels deeper every heading inside renders: 3 puts a `PageHeader` H1 at h4 and its
   * trays at h5, for a page drawn under an h3 (a docs example). Default 0 changes nothing.
   */
  by: number;
  children?: Child;
}

/**
 * Shifts every component heading inside it by `by` levels (clamped to h1–h6). For a host that
 * draws product markup inside its own outline: the docs render each example in one, so an
 * example page header is not a second h1. Product pages never need it.
 */
export function HeadingOffset(props: HeadingOffsetProps) {
  return <HeadingScope by={props.by}>{props.children}</HeadingScope>;
}

export interface HProps {
  /** The rendered level (from `useHeadingLevel`), clamped to 1–6. */
  level: number;
  id?: string;
  class?: string;
  children?: Child;
}

/** A heading of a computed level: `h1` … `h6` (internal to the components). */
export function H({ level, children, ...attrs }: HProps) {
  switch (Math.min(6, Math.max(1, level))) {
    case 1:
      return <h1 {...attrs}>{children}</h1>;
    case 2:
      return <h2 {...attrs}>{children}</h2>;
    case 3:
      return <h3 {...attrs}>{children}</h3>;
    case 4:
      return <h4 {...attrs}>{children}</h4>;
    case 5:
      return <h5 {...attrs}>{children}</h5>;
    default:
      return <h6 {...attrs}>{children}</h6>;
  }
}
