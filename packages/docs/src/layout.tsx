// The docs chrome, built from @tokengate/ui: AppShell with a SideNav generated from the
// foundations list and the registry, and the centered Page column. Every docs page renders
// through DocsLayout, so the sidebar markup is the same everywhere and only the current item moves.
// The sidebar is the admin's: labeled groups (`SideNav grouped`) with every page visible.
import { AppShell, ChartPatterns, Page, SideNav, type SideNavSection } from '@tokengate/ui';
import { raw } from 'hono/html';
import type { Child } from 'hono/jsx';
import { docsCss, docsUiCss } from './assets';
import { FOUNDATIONS } from './foundations';
import { GROUPS, REGISTRY, componentHref, type GroupKey } from './registry';

export type DocsLocation =
  | { kind: 'overview' }
  | { kind: 'foundation'; slug: string }
  | { kind: 'group'; group: GroupKey }
  | { kind: 'component'; group: GroupKey; slug: string }
  | { kind: 'none' };

/**
 * The sidebar groups: Introduction (the overview), Foundations, then one group per component
 * group. A component group opens with "All components", its index page, so every docs page has a
 * current item. No item icons: one repeated group icon on every component would carry nothing.
 */
export function docsSections(at: DocsLocation): SideNavSection[] {
  const sections: SideNavSection[] = [
    {
      label: 'Introduction',
      href: '/docs',
      items: [{ label: 'Overview', href: '/docs', current: at.kind === 'overview' }],
    },
    {
      label: 'Foundations',
      href: `/docs/foundations/${FOUNDATIONS[0]?.slug ?? ''}`,
      items: FOUNDATIONS.map((topic) => ({
        label: topic.title,
        href: `/docs/foundations/${topic.slug}`,
        current: at.kind === 'foundation' && at.slug === topic.slug,
      })),
    },
  ];
  for (const group of GROUPS) {
    const docs = REGISTRY[group.key];
    const href = `/docs/components/${group.key}`;
    sections.push({
      label: group.label,
      href,
      items: [
        {
          label: 'All components',
          href,
          count: docs.length > 0 ? docs.length : undefined,
          current: at.kind === 'group' && at.group === group.key,
        },
        ...docs.map((doc) => ({
          label: doc.name,
          href: componentHref(group.key, doc.slug),
          current: at.kind === 'component' && at.group === group.key && at.slug === doc.slug,
        })),
      ],
    });
  }
  return sections;
}

export interface DocsLayoutProps {
  /** Document title, before " – tokengate design system". */
  title: string;
  description?: string;
  at: DocsLocation;
  children?: Child;
}

export function DocsLayout(props: DocsLayoutProps) {
  return (
    <>
      {raw('<!doctype html>')}
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <meta name="color-scheme" content="light dark" />
          <title>{`${props.title} – tokengate design system`}</title>
          {props.description ? <meta name="description" content={props.description} /> : null}
          <link rel="stylesheet" href={docsUiCss.href} />
          <link rel="stylesheet" href={docsCss.href} />
        </head>
        <body>
          {/* the chart fills (#hatch, #dots), once per page for every Chart and ReasonBar example */}
          <ChartPatterns />
          <AppShell
            brand={{ name: 'tokengate', href: '/docs', host: 'design system' }}
            nav={<SideNav label="Documentation" sections={docsSections(props.at)} grouped />}
          >
            <Page>{props.children}</Page>
          </AppShell>
        </body>
      </html>
    </>
  );
}
