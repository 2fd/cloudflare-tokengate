import type { Child } from 'hono/jsx';

/** Props every component accepts: extra classes on its root element, and its content. */
export interface BaseProps {
  /** Extra classes on the root element, after the component's own. Never a replacement. */
  class?: string;
  children?: Child;
}

/**
 * The status tones of the system (README "Status words"). `info` is a neutral note; `pending` is
 * waiting on someone (Pending approval, Invited).
 */
export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'pending' | 'off';
