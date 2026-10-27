// The lists of the Access Rules page: credential access rules and the global access rules that cap
// them (ADR 0029). One sidebar item holds them; these tabs switch between them in the page header.
import { Tabs } from '@tokengate/ui';
import { paths } from '../paths';

export function AccessRuleTabs(props: {
  current: 'credential' | 'global';
  counts: { credential: number; global: number };
}) {
  return (
    <Tabs
      label="Access rule kinds"
      items={[
        {
          label: 'Credential access rules',
          href: paths.accessRules(),
          count: props.counts.credential,
          current: props.current === 'credential',
        },
        {
          label: 'Global access rules',
          href: paths.globalRules(),
          count: props.counts.global,
          current: props.current === 'global',
        },
      ]}
    />
  );
}
