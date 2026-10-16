// Decorative 16px sidebar icons (`svg.ic`, stroke = currentColor). Inline SVG: no sprite, no
// external file, nothing for the CSP to block.
import type { GroupKey } from './registry';

function Ic(props: { d: string[] }) {
  return (
    <svg class="ic" viewBox="0 0 24 24" aria-hidden="true">
      {props.d.map((d) => (
        <path d={d} />
      ))}
    </svg>
  );
}

export const OverviewIcon = () => <Ic d={['M4 11l8-7 8 7', 'M6 9.5V20h12V9.5', 'M10 20v-5h4v5']} />;
export const FoundationsIcon = () => (
  <Ic
    d={[
      'M12 3a9 9 0 1 0 0 18c1.2 0 2-.8 2-2 0-1.6 1.4-2.6 3-2.6h1.5A2.5 2.5 0 0 0 21 14 9 9 0 0 0 12 3z',
      'M7.5 11.5h.01',
      'M10.5 7.5h.01',
      'M15.5 8.5h.01',
    ]}
  />
);

const GROUP_ICONS: Record<GroupKey, string[]> = {
  base: ['M4 7h16v10H4z', 'M8 12h8'],
  forms: ['M4 5h16v4H4z', 'M4 13h10v4H4z', 'M18 13v4'],
  layout: ['M3 4h18v16H3z', 'M9 4v16', 'M13 9h5'],
  data: ['M3 5h18', 'M3 10h18', 'M3 15h18', 'M3 20h18', 'M9 5v15'],
  viz: ['M4 20V10', 'M10 20V4', 'M16 20v-7', 'M21 20H3'],
};

export function GroupIcon(props: { group: GroupKey }) {
  return <Ic d={GROUP_ICONS[props.group]} />;
}
