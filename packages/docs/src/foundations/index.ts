// Foundations pages in nav order. Each topic is one file in this folder.
import { accessibility } from './accessibility';
import { color } from './color';
import { elevation } from './elevation';
import { iconography } from './iconography';
import { layout } from './layout';
import { spacing } from './spacing';
import { status } from './status';
import type { Foundation } from './types';
import { typography } from './typography';

export type { Foundation } from './types';

export const FOUNDATIONS: readonly Foundation[] = [
  color,
  typography,
  spacing,
  elevation,
  iconography,
  layout,
  status,
  accessibility,
];

export function findFoundation(slug: string): Foundation | undefined {
  return FOUNDATIONS.find((topic) => topic.slug === slug);
}
