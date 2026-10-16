// Decorative sidebar icons for the docs chrome, drawn from the design system's own icon set
// (`Icon` from @tokengate/ui), so the docs and the product share one set of shapes.
import { Icon, type IconName } from '@tokengate/ui';
import type { GroupKey } from './registry';

export const OverviewIcon = () => <Icon name="home" />;
export const FoundationsIcon = () => <Icon name="palette" />;

const GROUP_ICONS: Record<GroupKey, IconName> = {
  base: 'component',
  forms: 'form',
  layout: 'layout',
  data: 'table',
  viz: 'chart',
};

export function GroupIcon(props: { group: GroupKey }) {
  return <Icon name={GROUP_ICONS[props.group]} />;
}
