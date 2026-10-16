// Renders a Hono JSX node to its HTML string (components here are synchronous).
import type { Child } from 'hono/jsx';

export function render(node: Child): string {
  const html = String(node);
  if (html === '[object Promise]') throw new Error('async component: await it instead');
  return html;
}
