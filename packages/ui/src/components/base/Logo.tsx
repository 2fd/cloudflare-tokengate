import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';
import { iconShapes } from './Icon';

/**
 * The brands with a logo tile, and what the tile shows: the brand letters, or an icon of the set
 * (OIDC is a key). Each brand has a `.lg-<brand>` class with its color in ui.css: the only
 * hard-coded colors of the system. The tile is a logotype next to the service name, never the only
 * place the name appears.
 */
export const LOGO_BRANDS = {
  slack: { name: 'Slack', letters: 'S' },
  openai: { name: 'OpenAI', letters: 'O' },
  anthropic: { name: 'Anthropic', letters: 'A' },
  github: { name: 'GitHub', letters: 'GH' },
  discord: { name: 'Discord', letters: 'D' },
  gitlab: { name: 'GitLab', letters: 'GL' },
  buildkite: { name: 'Buildkite', letters: 'BK' },
  oidc: { name: 'OIDC', icon: 'token' },
  custom: { name: 'Custom', letters: '</>' },
} as const satisfies Record<string, { name: string; letters?: string; icon?: 'token' }>;

export type LogoBrand = keyof typeof LOGO_BRANDS;

/** Tile sizes: `xs` 18, `sm` 24, `md` 32 (default), `lg` 40. */
export type LogoSize = 'xs' | 'sm' | 'md' | 'lg';

/** The tile content of a brand: its letters, or the icon of the set (internal: Logo, LogoStack). */
export function logoContent(brand: LogoBrand): Child {
  const entry: { letters?: string; icon?: 'token' } = LOGO_BRANDS[brand];
  return entry.icon ? <svg viewBox="0 0 24 24">{iconShapes(entry.icon)}</svg> : entry.letters;
}

export interface LogoProps {
  /** Which brand tile. */
  brand: LogoBrand;
  /** Tile size; default `md` (32px). */
  size?: LogoSize;
  /** Dimmed and grayscale (`.dis`): the token or consumer is disabled. Say so in words nearby. */
  disabled?: boolean;
  /**
   * Accessible name, only when the tile stands alone for the brand. Without it (the usual case,
   * the name is next to the tile) the tile is decorative: `aria-hidden="true"`.
   */
  label?: string;
  /** Replaces the brand letters (`custom` tiles of a named upstream: "AC" for Acme CRM). */
  children?: Child;
  class?: string;
}

/**
 * A brand logo tile (`.logo.lg-<brand>`): the letters of the service in its brand color, or the
 * key icon for OIDC. Decorative by default: the service name is always next to it.
 */
export function Logo({
  brand,
  size = 'md',
  disabled,
  label,
  children,
  class: className,
}: LogoProps) {
  return (
    <span
      class={cx('logo', size !== 'md' && size, `lg-${brand}`, disabled && 'dis', className)}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': 'true' })}
    >
      {children ?? logoContent(brand)}
    </span>
  );
}
