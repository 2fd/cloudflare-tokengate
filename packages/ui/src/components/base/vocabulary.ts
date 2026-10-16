// The status vocabulary (README "Status words"): one entry per meaning, with its tone, glyph and
// default word. Badge and Status read it, so a status says the same thing everywhere.
import type { Tone } from '../../lib/props';

export interface StatusWord {
  tone: Tone;
  glyph: string;
  word: string;
}

export const STATUS_VOCABULARY = {
  active: { tone: 'ok', glyph: '✓', word: 'Active' },
  expiring: { tone: 'warn', glyph: '⌛', word: 'Expires soon' },
  expired: { tone: 'bad', glyph: '✕', word: 'Expired' },
  'risk-accepted': { tone: 'warn', glyph: '⚠', word: 'Risk accepted' },
  pending: { tone: 'info', glyph: '◐', word: 'Pending approval' },
  disabled: { tone: 'off', glyph: '⏸', word: 'Disabled' },
  'no-secret': { tone: 'bad', glyph: '–', word: 'No secret' },
} as const satisfies Record<string, StatusWord>;

/** A meaning from the status vocabulary. */
export type StatusKind = keyof typeof STATUS_VOCABULARY;
