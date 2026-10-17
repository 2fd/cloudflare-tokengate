// The HTML of a JSX node, synchronously: the docs components and examples never await, so a
// node's toString() is its markup. Used to inspect an example before it is drawn (its headings,
// whether it is a live form).
import type { Child } from 'hono/jsx';

export function htmlOf(node: Child): string {
  const html = (node as { toString(): string }).toString();
  if (html === '[object Promise]') throw new Error('async node in a docs example');
  return html;
}
