// Status vocabulary: one label, tone and glyph per state, shared by every section so a state reads
// the same on every page. The label always carries the meaning; the tone (colour) and the glyph
// (hidden from assistive technology) only repeat it (WCAG 1.4.1).

export type Tone = 'ok' | 'warn' | 'bad' | 'pending' | 'muted';

export type StatusKey =
  | 'active'
  | 'disabled'
  | 'expired'
  | 'expiring'
  | 'no_credential'
  | 'credential_unreadable'
  | 'upstream_rejecting'
  | 'outside_hosts'
  | 'inactive'
  | 'global_blocked'
  | 'global_limited'
  | 'global_within'
  | 'unused'
  | 'risk_accepted'
  | 'not_confirmed'
  | 'pending'
  | 'invited'
  | 'invite_expired'
  | 'suspended'
  | 'allowed'
  | 'denied'
  | 'error'
  | 'done'
  | 'todo';

/** Reasons a credential access rule cannot work although it is enabled (`inactive`), exact texts. */
export type InactiveReason =
  | 'credential disabled'
  | 'credential has no secret'
  | 'credential unreadable';

interface StatusInfo {
  tone: Tone;
  /** Hidden from assistive technology; empty for none. */
  glyph: string;
  /**
   * The visible label. `detail` is the variable part: the day count of `expiring` and `invited`,
   * the reason of `inactive`, `sampled` for `unused` under a sample rate below 1.
   */
  label: (detail?: string) => string;
}

const fixed = (text: string) => () => text;

function days(detail: string | undefined): string {
  return detail === '1' ? '1 day' : `${detail ?? '?'} days`;
}

export const STATUS: Readonly<Record<StatusKey, StatusInfo>> = {
  active: { tone: 'ok', glyph: '✓', label: fixed('Active') },
  disabled: { tone: 'muted', glyph: '⏸', label: fixed('Disabled') },
  expired: { tone: 'bad', glyph: '✕', label: fixed('Expired') },
  expiring: { tone: 'warn', glyph: '⌛', label: (detail) => `Expires in ${days(detail)}` },
  no_credential: { tone: 'bad', glyph: '–', label: fixed('No credential') },
  credential_unreadable: { tone: 'bad', glyph: '✕', label: fixed('Credential unreadable') },
  upstream_rejecting: { tone: 'bad', glyph: '✕', label: fixed('Upstream rejecting (401/403)') },
  outside_hosts: { tone: 'bad', glyph: '✕', label: fixed('Not an allowed host') },
  inactive: {
    tone: 'warn',
    glyph: '⚠',
    label: (detail) => (detail ? `Inactive: ${detail}` : 'Inactive'),
  },
  global_blocked: { tone: 'bad', glyph: '✕', label: fixed('Blocked by global access rules') },
  global_limited: { tone: 'warn', glyph: '◐', label: fixed('Limited by global access rules') },
  global_within: { tone: 'ok', glyph: '✓', label: fixed('Within global access rules') },
  unused: {
    tone: 'muted',
    glyph: '',
    label: (detail) => (detail === 'sampled' ? 'No sampled use in 30+ days' : 'Unused 30+ days'),
  },
  risk_accepted: { tone: 'warn', glyph: '⚠', label: fixed('Risk accepted') },
  not_confirmed: { tone: 'bad', glyph: '', label: fixed('not confirmed') },
  pending: { tone: 'pending', glyph: '◐', label: fixed('Pending approval') },
  invited: {
    tone: 'pending',
    glyph: '◐',
    label: (detail) => (detail ? `Invited, expires in ${days(detail)}` : 'Invited'),
  },
  invite_expired: { tone: 'warn', glyph: '✕', label: fixed('Invitation expired') },
  suspended: { tone: 'bad', glyph: '‖', label: fixed('Suspended') },
  allowed: { tone: 'ok', glyph: '✓', label: fixed('Allowed') },
  denied: { tone: 'bad', glyph: '✕', label: fixed('Denied') },
  error: { tone: 'warn', glyph: '!', label: fixed('Error') },
  done: { tone: 'ok', glyph: '✓', label: fixed('Done') },
  todo: { tone: 'muted', glyph: '', label: fixed('To do') },
};

export function statusLabel(status: StatusKey, detail?: string): string {
  return STATUS[status].label(detail);
}

/** The ui tone of an admin tone (`@tokengate/ui` has no `muted`: its gray tone is `off`). */
export function uiTone(tone: Tone): 'ok' | 'warn' | 'bad' | 'pending' | 'off' {
  return tone === 'muted' ? 'off' : tone;
}
