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
    description: 'Buttons, badges, status dots, chips, logos, IDs, callouts and code snippets.',
  },
  {
    key: 'forms',
    label: 'Forms',
    description:
      'Fields, radio cards, pick lists, the live give-access form, filters and confirm dialogs.',
  },
  {
    key: 'layout',
    label: 'Layout',
    description: 'App shell, sidebar, centered page column, page header, tabs, trays and panels.',
  },
  {
    key: 'data',
    label: 'Data',
    description:
      'Tables, empty states, key-value lists, the right rail, activity feed and secrets.',
  },
  {
    key: 'viz',
    label: 'Visualization',
    description:
      'KPIs, charts, pipeline, needs attention, request trace, connections map and matrix.',
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
