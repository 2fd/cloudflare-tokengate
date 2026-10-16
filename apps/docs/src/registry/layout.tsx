// Docs entries of the "layout" group (packages/ui/src/components/layout). One ComponentDoc per
// component page, in nav order. Only the layout group agent edits this file.
import { AppShell, Page, PageHeader, Panel, SideNav, Tray } from '@tokengate/ui';
import type { ComponentDoc } from './types';

const EXAMPLE_SECTIONS = [
  { label: 'Monitoring', href: '#' },
  {
    label: 'Service tokens',
    href: '#',
    count: 6,
    open: true,
    items: [
      { label: 'Tokens', href: '#', current: true },
      { label: 'Allowed hosts', href: '#' },
      { label: 'Encryption keys', href: '#' },
    ],
  },
  { label: 'Service consumers', href: '#', count: 3 },
  {
    label: 'Users',
    href: '#',
    pill: { label: '1 pending', srLabel: ': a person needs your decision' },
  },
];

export const layout: readonly ComponentDoc[] = [
  {
    slug: 'app-shell',
    name: 'AppShell',
    related: ['SideNav'],
    summary:
      'The frame of every page: skip link, light sidebar with the instance block and navigation, and the main column.',
    usage: {
      when: ['Once per page, as the outermost element of the body.'],
      whenNot: ['Inside another shell. In docs examples, pass landmarks={false}.'],
    },
    examples: [
      {
        title: 'Sidebar with an open section',
        description:
          'Counts and the pending pill sit on the section row; only the open section shows its items.',
        layout: 'frame',
        render: () => (
          <AppShell
            landmarks={false}
            mainId="ex-shell-main"
            brand={{ name: 'tokengate', href: '#', host: 'gate.acme.dev' }}
            nav={<SideNav label="Sections (example)" sections={EXAMPLE_SECTIONS} />}
          >
            <Page>
              <PageHeader title="Service tokens" count={6} />
            </Page>
          </AppShell>
        ),
        code: `<AppShell
  brand={{ name: 'tokengate', href: '/admin', host: 'gate.acme.dev' }}
  nav={<SideNav label="Sections" sections={sections} />}
>
  <Page>
    <PageHeader title="Service tokens" count={6} />
  </Page>
</AppShell>`,
      },
    ],
    props: [
      {
        component: 'AppShell',
        props: [
          {
            name: 'brand',
            type: '{ name: string; href: string; host?: string }',
            required: true,
            description: 'Instance block: name link and the mono host line.',
          },
          { name: 'nav', type: 'Child', required: true, description: 'Usually a SideNav.' },
          { name: 'health', type: 'Child', description: 'Health line under the brand.' },
          { name: 'account', type: 'Child', description: 'Account block at the bottom.' },
          {
            name: 'banner',
            type: 'Child',
            description: 'Error-level health strip at the top of main.',
          },
          {
            name: 'mainId',
            type: 'string',
            default: "'main'",
            description: 'Id of main; the skip link target.',
          },
          {
            name: 'landmarks',
            type: 'boolean',
            default: 'true',
            description: 'false renders a div instead of main and drops the skip link.',
          },
          { name: 'class', type: 'string', description: 'Extra classes on .app.' },
          { name: 'children', type: 'Child', description: 'Main column content, usually a Page.' },
        ],
      },
      {
        component: 'SideNav',
        props: [
          {
            name: 'label',
            type: 'string',
            required: true,
            description: 'Name of the nav landmark.',
          },
          {
            name: 'sections',
            type: 'readonly SideNavSection[]',
            required: true,
            description:
              'label, href, icon, count, pill, open, current, items[] (label, href, current).',
          },
          { name: 'class', type: 'string', description: 'Extra classes on the nav.' },
        ],
      },
    ],
    accessibility: [
      'The skip link is the first focusable element and targets main.',
      'The current page carries aria-current="page", on the sub-item or on a section without items.',
      'Below 40rem the navigation sits behind a native details “Menu” button: no JavaScript.',
    ],
    do: [
      'Render the sidebar from one data structure, so it is the same markup on every page.',
      'Keep counts and the pending pill on the section row, open or closed.',
    ],
    dont: ['Do not add group labels to the sidebar.', 'Do not vary the sidebar per page.'],
    classes: [
      'app',
      'skip-link',
      'side',
      'side-in',
      'inst',
      'mark',
      'navd',
      'nav',
      'nav-item',
      'nav-sub',
      'nav-count',
      'nav-pill',
      'main',
    ],
  },
  {
    slug: 'page',
    name: 'Page',
    summary: 'The centered content column inside the main area: at most 76rem plus the gutters.',
    usage: {
      when: ['Once per page, directly inside AppShell, holding the header and the trays.'],
    },
    examples: [
      {
        title: 'Header and a tray in the column',
        layout: 'frame',
        render: () => (
          <Page>
            <PageHeader title="Consumer access" description="Who can use which token." />
            <Tray id="ex-page-tray" title="All accesses" count={9}>
              <Panel variant="pad">
                <p>Content of the tray.</p>
              </Panel>
            </Tray>
          </Page>
        ),
        code: `<Page>
  <PageHeader title="Consumer access" description="Who can use which token." />
  <Tray id="all-accesses" title="All accesses" count={9}>
    <Panel variant="pad">…</Panel>
  </Tray>
</Page>`,
      },
    ],
    props: [
      {
        component: 'Page',
        props: [
          { name: 'class', type: 'string', description: 'Extra classes on .page.' },
          { name: 'children', type: 'Child', description: 'Header, then top-level blocks.' },
        ],
      },
    ],
    accessibility: [
      'A plain div: landmarks come from AppShell, headings from PageHeader and Tray.',
    ],
    do: ['Let every block start at the column’s left edge.'],
    dont: ['Do not set widths on blocks to “center” them: the column does it.'],
    classes: ['page'],
  },
  {
    slug: 'page-header',
    name: 'PageHeader',
    related: ['Breadcrumbs'],
    summary: 'Breadcrumb, H1 with an optional count, description and the header actions.',
    usage: {
      when: ['At the top of every page, as the first child of Page.'],
    },
    examples: [
      {
        title: 'List page',
        layout: 'frame',
        render: () => (
          <PageHeader
            title="Service tokens"
            count={6}
            description="Secrets of the upstream APIs that consumers call through tokengate."
            actions={
              <a class="btn primary" href="#">
                <span class="plus" aria-hidden="true">
                  +
                </span>
                Add token
              </a>
            }
          />
        ),
        code: `<PageHeader
  title="Service tokens"
  count={6}
  description="Secrets of the upstream APIs that consumers call through tokengate."
  actions={<a class="btn primary" href="/admin/tokens/new">+ Add token</a>}
/>`,
      },
      {
        title: 'With a breadcrumb',
        layout: 'frame',
        render: () => (
          <PageHeader
            crumbs={[{ label: 'Requests', href: '#' }, { label: 'req_01JB8Z5K…' }]}
            title="Denied request"
          />
        ),
        code: `<PageHeader
  crumbs={[{ label: 'Requests', href: '/admin/requests' }, { label: 'req_01JB8Z5K…' }]}
  title="Denied request"
/>`,
      },
    ],
    props: [
      {
        component: 'PageHeader',
        props: [
          { name: 'title', type: 'Child', required: true, description: 'The H1.' },
          { name: 'count', type: 'number | string', description: 'Count after the title.' },
          { name: 'description', type: 'Child', description: 'One or two sentences.' },
          {
            name: 'crumbs',
            type: 'readonly Crumb[]',
            description: 'Breadcrumb; the last is current.',
          },
          { name: 'actions', type: 'Child', description: 'At most one primary button.' },
          { name: 'class', type: 'string', description: 'Extra classes on the header.' },
          {
            name: 'children',
            type: 'Child',
            description: 'Rows under the title (relation line, tabs).',
          },
        ],
      },
      {
        component: 'Breadcrumbs',
        props: [
          {
            name: 'items',
            type: 'readonly { label: string; href?: string }[]',
            required: true,
            description: 'From the list page to the current page.',
          },
          { name: 'class', type: 'string', description: 'Extra classes on the nav.' },
        ],
      },
    ],
    accessibility: [
      'One H1 per page.',
      'The breadcrumb is a nav named “Breadcrumb”; the last item has aria-current="page".',
    ],
    do: ['Name the first crumb after the list page the object belongs to.'],
    dont: ['Do not put more than one primary button in the header.'],
    classes: ['ph', 'crumbs', 'ph-row', 'ph-title', 'count', 'desc', 'ph-actions'],
  },
  {
    slug: 'tray',
    name: 'Tray',
    related: ['Panel'],
    summary: 'A gray tray card with a title row, holding one or more white panels.',
    usage: {
      when: ['Every top-level block of a page under the header.'],
      whenNot: ['Inside a panel: never nest a tray in a panel.'],
    },
    examples: [
      {
        title: 'Title, count, description and actions',
        layout: 'stack',
        render: () => (
          <Tray
            id="ex-tray-1"
            title="All tokens"
            count={6}
            description="Upstream API secrets."
            actions={
              <a class="btn sm secondary" href="#">
                Export
              </a>
            }
          >
            <Panel variant="pad">
              <p>A padded panel.</p>
            </Panel>
            <Panel variant="pad">
              <p>A second panel, 4px below.</p>
            </Panel>
          </Tray>
        ),
        code: `<Tray id="all-tokens" title="All tokens" count={6} description="Upstream API secrets."
  actions={<a class="btn sm secondary" href="…">Export</a>}>
  <Panel variant="pad">…</Panel>
  <Panel variant="pad">…</Panel>
</Tray>`,
      },
      {
        title: 'Warn tone with a footer',
        layout: 'stack',
        render: () => (
          <Tray id="ex-tray-2" title="Needs attention" tone="warn" footer="Updated 14:05 UTC">
            <Panel variant="pad">
              <p>The secret of OpenAI expires on 21 Oct 2026.</p>
            </Panel>
          </Tray>
        ),
        code: `<Tray id="attention" title="Needs attention" tone="warn" footer="Updated 14:05 UTC">
  <Panel variant="pad">…</Panel>
</Tray>`,
      },
    ],
    props: [
      {
        component: 'Tray',
        props: [
          {
            name: 'id',
            type: 'string',
            required: true,
            description: 'Section id; the heading gets id-h.',
          },
          { name: 'title', type: 'Child', required: true, description: 'Tray title.' },
          { name: 'count', type: 'number | string', description: 'Count after the title.' },
          { name: 'description', type: 'Child', description: 'One line under the title.' },
          { name: 'actions', type: 'Child', description: 'Right side of the title row.' },
          { name: 'footer', type: 'Child', description: 'Footer facts.' },
          {
            name: 'level',
            type: '2 | 3',
            default: '2',
            description: 'Heading level of the title.',
          },
          { name: 'tone', type: "'warn'", description: 'Warn bar at the top.' },
          { name: 'class', type: 'string', description: 'Extra classes on the section.' },
          { name: 'children', type: 'Child', description: 'Panels.' },
        ],
      },
      {
        component: 'Panel',
        props: [
          {
            name: 'variant',
            type: "'pad' | 'flush'",
            description: 'pad: 20px padding. flush: tables.',
          },
          { name: 'class', type: 'string', description: 'Extra classes on the panel.' },
          { name: 'children', type: 'Child', description: 'Content.' },
        ],
      },
    ],
    accessibility: [
      'The section is labelled by its heading (aria-labelledby), so it is a named region.',
    ],
    do: ['Give every tray a unique id.', 'Stack panels in a tray; they get 4px between them.'],
    dont: [
      'Do not put a tray inside a panel.',
      'Do not skip heading levels: use level={3} under an h2.',
    ],
    classes: ['tray', 'tray-h', 'tray-f', 'tone-warn', 'panel', 'pad', 'flush'],
  },
];
