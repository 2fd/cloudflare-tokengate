// The docs registry: the five group files merged in nav order. Routes, the sidebar and the group
// pages are generated from here, so adding a component page never touches this file.
import { base } from './base';
import { data } from './data';
import { forms } from './forms';
import { layout } from './layout';
import type { ComponentDoc, GroupInfo, GroupKey } from './types';
import { viz } from './viz';

export type {
  ComponentDoc,
  ComponentExample,
  GroupInfo,
  GroupKey,
  PropDoc,
  PropsTable,
} from './types';

export const GROUPS: readonly GroupInfo[] = [
  {
    key: 'base',
    label: 'Base',
    description:
      'Buttons, badges, status words, chips, logos, icons, IDs, masked secrets, avatars, callouts and code snippets.',
  },
  {
    key: 'forms',
    label: 'Forms',
    description:
      'Fields, inputs, radio cards, pick lists, steppers, the live give-access form, risk acceptance, error summaries and type catalogs.',
  },
  {
    key: 'layout',
    label: 'Layout',
    description:
      'App shell, sidebar, account menu, page column, page header, tabs, trays, detail layout, danger zone, dialogs, menus and disclosures.',
  },
  {
    key: 'data',
    label: 'Data',
    description:
      'Tables, filters, quick links, pagers, empty states, key-value lists, secrets, activity feeds, diffs and times.',
  },
  {
    key: 'viz',
    label: 'Visualization',
    description:
      'Needs attention, pipeline, KPIs, charts, reasons bar, connections map, matrix, checklist, request trace and split view.',
  },
];

export const REGISTRY: Readonly<Record<GroupKey, readonly ComponentDoc[]>> = {
  base,
  forms,
  layout,
  data,
  viz,
};

export function findGroup(key: string): GroupInfo | undefined {
  return GROUPS.find((group) => group.key === key);
}

export function findComponent(
  groupKey: string,
  slug: string,
): { group: GroupInfo; doc: ComponentDoc } | undefined {
  const group = findGroup(groupKey);
  const doc = group ? REGISTRY[group.key].find((entry) => entry.slug === slug) : undefined;
  return group && doc ? { group, doc } : undefined;
}

export function componentHref(group: GroupKey, slug: string): string {
  return `/docs/components/${group}/${slug}`;
}
