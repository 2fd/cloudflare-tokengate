import { cx } from '../../lib/cx';

/**
 * The icon set: 24×24 outline paths, drawn with `stroke: currentColor` (no fills), so an icon takes
 * the color of its text in both schemes and in forced colors. Each entry is the inner markup of the
 * `<svg>`: paths, circles and rects. Inline SVG, no sprite: nothing for the CSP to block.
 */
const ICONS = {
  /** The shield mark of tokengate (instance block, "tokengate checks the call"). */
  gate: [
    ['path', { d: 'M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z' }],
    ['circle', { cx: '12', cy: '11', r: '2' }],
  ],
  /** Sidebar: Monitoring. */
  monitoring: [['path', { d: 'M3 12h4l3-7 4 14 3-7h4' }]],
  /** Sidebar: Credentials; the OIDC logo tile. */
  token: [
    ['circle', { cx: '8', cy: '15', r: '4' }],
    ['path', { d: 'M11 12l9-9M16 7l3 3' }],
  ],
  /** Sidebar: Credential access rules; the empty issuer access rules state. */
  consumer: [
    ['rect', { x: '3', y: '3', width: '7', height: '7', rx: '1.5' }],
    ['rect', { x: '14', y: '14', width: '7', height: '7', rx: '1.5' }],
    ['path', { d: 'M10 6.5h4a3 3 0 0 1 3 3V14' }],
  ],
  /** Sidebar: Users. */
  users: [
    ['circle', { cx: '9', cy: '8', r: '3.5' }],
    [
      'path',
      {
        d: 'M2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5M16 4.5a3.5 3.5 0 0 1 0 7M18 14.6c1.8.7 3 2.6 3.5 5.4',
      },
    ],
  ],
  /** One person: empty people list, a user without an avatar. */
  user: [
    ['circle', { cx: '9', cy: '8', r: '3.5' }],
    ['path', { d: 'M2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5' }],
  ],
  /** Search fields and "Find a request". */
  search: [
    ['circle', { cx: '11', cy: '11', r: '6' }],
    ['path', { d: 'M20 20l-4.5-4.5' }],
  ],
  /** "Continue" links and the arrow between a consumer and a token. */
  'arrow-right': [['path', { d: 'M5 12h14M13 6l6 6-6 6' }]],
  /** System actors (hourly jobs) in the activity feed. */
  system: [
    ['circle', { cx: '12', cy: '12', r: '3' }],
    [
      'path',
      {
        d: 'M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1',
      },
    ],
  ],
  /** Docs: Overview. */
  home: [['path', { d: 'M4 11l8-7 8 7M6 9.5V20h12V9.5M10 20v-5h4v5' }]],
  /** Docs: Foundations. */
  palette: [
    [
      'path',
      {
        d: 'M12 3a9 9 0 1 0 0 18c1.2 0 2-.8 2-2 0-1.6 1.4-2.6 3-2.6h1.5A2.5 2.5 0 0 0 21 14 9 9 0 0 0 12 3z',
      },
    ],
    ['path', { d: 'M7.5 11.5h.01M10.5 7.5h.01M15.5 8.5h.01' }],
  ],
  /** Docs: Base components. */
  component: [['path', { d: 'M4 7h16v10H4zM8 12h8' }]],
  /** Docs: Forms. */
  form: [['path', { d: 'M4 5h16v4H4zM4 13h10v4H4zM18 13v4' }]],
  /** Docs: Layout. */
  layout: [['path', { d: 'M3 4h18v16H3zM9 4v16M13 9h5' }]],
  /** Docs: Data; tables. */
  table: [['path', { d: 'M3 5h18M3 10h18M3 15h18M3 20h18M9 5v15' }]],
  /** Docs: Visualization; charts. */
  chart: [['path', { d: 'M4 20V10M10 20V4M16 20v-7M21 20H3' }]],
  /** Sidebar: FAQ. */
  help: [
    ['circle', { cx: '12', cy: '12', r: '9' }],
    ['path', { d: 'M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17h.01' }],
  ],
} as const satisfies Record<string, ReadonlyArray<readonly [string, Record<string, string>]>>;

export type IconName = keyof typeof ICONS;

/** Every icon name, in set order (docs, tests). */
export const ICON_NAMES = Object.keys(ICONS) as IconName[];

/** The SVG children of an icon (internal: `Icon`, the OIDC logo tile). */
export function iconShapes(name: IconName) {
  return ICONS[name].map(([tag, attrs]) => {
    const Tag = tag;
    return <Tag {...attrs} />;
  });
}

export interface IconProps {
  /** Which icon of the set. */
  name: IconName;
  /**
   * Accessible name, only for an icon that stands for a word that is not next to it. Without it
   * (the default and the usual case) the icon is decorative: `aria-hidden="true"`.
   */
  label?: string;
  /** Extra classes after `ic`. */
  class?: string;
}

/**
 * A 16px outline icon (`svg.ic`, stroke 1.6, `currentColor`). Decorative by default: the word
 * next to it carries the meaning. The system never has icon-only buttons.
 */
export function Icon({ name, label, class: className }: IconProps) {
  return (
    <svg
      class={cx('ic', className)}
      viewBox="0 0 24 24"
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': 'true' })}
    >
      {iconShapes(name)}
    </svg>
  );
}
