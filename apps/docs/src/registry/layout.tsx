// Docs entries of the "layout" group (packages/ui/src/components/layout). One ComponentDoc per
// component page, in nav order. Only the layout group agent edits this file.
import {
  AccountMenu,
  AppShell,
  Badge,
  CodeBlock,
  ConfirmDialog,
  DangerRow,
  DangerZone,
  DetailLayout,
  Dialog,
  DialogClose,
  DialogTrigger,
  Disclosure,
  HealthLine,
  HealthStrip,
  Identity,
  Menu,
  MenuItem,
  MenuSeparator,
  NavIcon,
  Page,
  PageHeader,
  Panel,
  RelationLine,
  Segmented,
  SideNav,
  TabRow,
  Tabs,
  Tray,
  type SideNavSection,
} from '@tokengate/ui';
import type { ComponentDoc } from './types';

// ----- shared example data (the tokengate data set of the design reference) ----------------------

type SectionKey = 'monitoring' | 'tokens' | 'consumers' | 'users';

/**
 * The admin sidebar as every page renders it: the same four sections, only the open section and
 * the current item change. `counts: false` is the empty install (no counts, no pill).
 */
function adminSections(open: SectionKey, current: string, counts = true): SideNavSection[] {
  const sub = (items: Array<[string, string]>) =>
    items.map(([label, href]) => ({ label, href, current: href === current }));
  return [
    {
      label: 'Monitoring',
      href: '#',
      icon: <NavIcon name="monitoring" />,
      open: open === 'monitoring',
      items: sub([
        ['Overview', '#overview'],
        ['Requests', '#requests'],
        ['Audit log', '#audit'],
        ['Data retention', '#retention'],
      ]),
    },
    {
      label: 'Service tokens',
      href: '#',
      icon: <NavIcon name="tokens" />,
      count: counts ? 6 : undefined,
      open: open === 'tokens',
      items: sub([
        ['Tokens', '#tokens'],
        ['Allowed hosts', '#hosts'],
        ['Encryption keys', '#keys'],
      ]),
    },
    {
      label: 'Service consumers',
      href: '#',
      icon: <NavIcon name="consumers" />,
      count: counts ? 3 : undefined,
      open: open === 'consumers',
      items: sub([
        ['Consumers', '#consumers'],
        ['Consumer access', '#access'],
      ]),
    },
    {
      label: 'Users',
      href: '#',
      icon: <NavIcon name="users" />,
      pill: counts ? { label: '1 pending', srLabel: ': a person needs your decision' } : undefined,
      open: open === 'users',
      items: sub([
        ['People', '#people'],
        ['Sign-in', '#sign-in'],
      ]),
    },
  ];
}

const BRAND = { name: 'tokengate', href: '#', host: 'gate.acme.dev' };

const SLACK_LOGO = (
  <span class="logo lg lg-slack" aria-hidden="true">
    S
  </span>
);

function SlackRow(props: { name: string; meta: string; logo: 'github' | 'gitlab' }) {
  return (
    <>
      <span class={`logo sm lg-${props.logo}`} aria-hidden="true">
        {props.logo === 'github' ? 'GH' : 'GL'}
      </span>
      <span class="ent-t">
        <a class="ent-n" href="#">
          {props.name}
        </a>
        <span class="meta">{props.meta}</span>
      </span>
    </>
  );
}

const SECTIONS_CODE = `// one data structure for every page: only open and current change
const sections = [
  { label: 'Monitoring', href: '/admin', icon: <NavIcon name="monitoring" />, items: [...] },
  { label: 'Service tokens', href: '/admin/tokens', icon: <NavIcon name="tokens" />, count: 6,
    open: true, items: [{ label: 'Tokens', href: '/admin/tokens', current: true }, ...] },
  { label: 'Service consumers', href: '/admin/consumers', icon: <NavIcon name="consumers" />, count: 3, items: [...] },
  { label: 'Users', href: '/admin/users', icon: <NavIcon name="users" />,
    pill: { label: '1 pending', srLabel: ': a person needs your decision' }, items: [...] },
];`;

// ----- pages ---------------------------------------------------------------------------------------

const appShell: ComponentDoc = {
  slug: 'app-shell',
  name: 'AppShell',
  related: ['SideNav', 'NavIcon', 'HealthLine', 'AccountMenu', 'HealthStrip'],
  summary:
    'The frame of every page: skip link, light sidebar (instance, health line, navigation, account menu) and the main column with the centered page.',
  usage: {
    when: [
      'Once per page, as the outermost element of the body. Every admin page renders the same sidebar from one data structure.',
      'The health line (HealthLine) always; the error strip (HealthStrip) only while a problem breaks every call.',
    ],
    whenNot: [
      'Inside another shell. In docs examples, pass landmarks={false}.',
      <>
        Warnings and notes: they go to the health line and to Needs attention, never to the{' '}
        <code>HealthStrip</code>.
      </>,
    ],
  },
  examples: [
    {
      title: 'Sidebar with an open section and the account menu',
      description:
        'Counts and the pending pill sit on the section row, open or closed; only the open section shows its items. The account button opens a popover menu (no JavaScript). Below 40rem the sidebar is a top bar with a Menu button.',
      layout: 'frame',
      render: () => (
        <AppShell
          landmarks={false}
          mainId="ex-shell-1"
          brand={BRAND}
          health={
            <HealthLine href="#" tone="warn" srLabel=". Open Overview, Needs attention">
              3 warnings to review
            </HealthLine>
          }
          nav={<SideNav label="Sections (example)" sections={adminSections('tokens', '#tokens')} />}
          account={
            <AccountMenu id="ex-acct-1" name="Maya Chen" role="Owner" initials="MC">
              <MenuItem href="#">Export configuration</MenuItem>
              <MenuItem href="/docs">Docs</MenuItem>
              <MenuSeparator />
              <MenuItem action="#">Sign out</MenuItem>
            </AccountMenu>
          }
        >
          <Page>
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
          </Page>
        </AppShell>
      ),
      code: `${SECTIONS_CODE}

<AppShell
  brand={{ name: 'tokengate', href: '/admin', host: 'gate.acme.dev' }}
  health={
    <HealthLine href="/admin#ov-attention" tone="warn" srLabel=". Open Overview, Needs attention">
      3 warnings to review
    </HealthLine>
  }
  nav={<SideNav label="Sections" sections={sections} />}
  account={
    <AccountMenu id="acct" name="Maya Chen" role="Owner" initials="MC">
      <MenuItem href="/admin/export">Export configuration</MenuItem>
      <MenuItem href="/docs">Docs</MenuItem>
      <MenuSeparator />
      <MenuItem action="/admin/logout">Sign out</MenuItem>
    </AccountMenu>
  }
>
  <Page>
    <PageHeader title="Service tokens" count={6} description="…" actions={…} />
  </Page>
</AppShell>`,
    },
    {
      title: 'Error-level health strip',
      description:
        'Only for a problem that breaks every call. The strip spans the main column; its text lines up with the centered page column.',
      layout: 'frame',
      render: () => (
        <AppShell
          landmarks={false}
          mainId="ex-shell-2"
          brand={BRAND}
          health={
            <HealthLine href="#" tone="bad" srLabel=". Open Overview, Health">
              1 problem stops every call
            </HealthLine>
          }
          nav={
            <SideNav label="Sections (strip example)" sections={adminSections('tokens', '#keys')} />
          }
          account={
            <AccountMenu id="ex-acct-2" name="Maya Chen" role="Owner" initials="MC">
              <MenuItem href="/docs">Docs</MenuItem>
            </AccountMenu>
          }
          banner={
            <HealthStrip title="Keyring unavailable." action={<a href="#">Fix encryption keys</a>}>
              Stored secrets cannot be opened, so every call fails.
            </HealthStrip>
          }
        >
          <Page>
            <PageHeader
              crumbs={[{ label: 'Service tokens', href: '#' }, { label: 'Encryption keys' }]}
              title="Encryption keys"
              description="Keys that seal the stored secrets. tokengate keeps the old keys until every secret is sealed with the new one."
            />
          </Page>
        </AppShell>
      ),
      code: `<AppShell
  brand={brand}
  health={<HealthLine href="/admin#ov-health" tone="bad" srLabel=". Open Overview, Health">1 problem stops every call</HealthLine>}
  nav={<SideNav label="Sections" sections={sections} />}
  account={account}
  banner={
    <HealthStrip title="Keyring unavailable." action={<a href="/admin/tokens/keys">Fix encryption keys</a>}>
      Stored secrets cannot be opened, so every call fails.
    </HealthStrip>
  }
>
  <Page>…</Page>
</AppShell>`,
    },
    {
      title: 'Empty install, token manager',
      description:
        'No counts and no pill; the health line reads “Healthy · 1 note” and links to Health. The token manager’s account menu has no Export configuration.',
      layout: 'frame',
      render: () => (
        <AppShell
          landmarks={false}
          mainId="ex-shell-3"
          brand={BRAND}
          health={
            <HealthLine href="#" srLabel=". Open Overview, Health">
              Healthy · 1 note
            </HealthLine>
          }
          nav={
            <SideNav
              label="Sections (empty install example)"
              sections={adminSections('monitoring', '#overview', false)}
            />
          }
          account={
            <AccountMenu id="ex-acct-3" name="Priya Natarajan" role="Token manager" initials="PN">
              <MenuItem href="/docs">Docs</MenuItem>
              <MenuSeparator />
              <MenuItem action="#">Sign out</MenuItem>
            </AccountMenu>
          }
        >
          <Page>
            <PageHeader
              title="Overview"
              description="Get started: load a token, add a consumer, then give it access."
            />
          </Page>
        </AppShell>
      ),
      code: `<AppShell
  brand={brand}
  health={<HealthLine href="/admin#ov-health" srLabel=". Open Overview, Health">Healthy · 1 note</HealthLine>}
  nav={<SideNav label="Sections" sections={sectionsWithoutCounts} />}
  account={
    <AccountMenu id="acct" name="Priya Natarajan" role="Token manager" initials="PN">
      <MenuItem href="/docs">Docs</MenuItem>
      <MenuSeparator />
      <MenuItem action="/admin/logout">Sign out</MenuItem>
    </AccountMenu>
  }
>
  <Page>…</Page>
</AppShell>`,
    },
    {
      title: 'Health line tones',
      description: 'One dot and the words. The dot never stands alone.',
      layout: 'stack',
      render: () => (
        <>
          <HealthLine href="#" srLabel=". Open Overview, Health">
            Healthy · 1 note
          </HealthLine>
          <HealthLine href="#" tone="info" srLabel=". Open Overview, Health">
            Healthy · 2 notes
          </HealthLine>
          <HealthLine href="#" tone="warn" srLabel=". Open Overview, Needs attention">
            3 warnings to review
          </HealthLine>
          <HealthLine href="#" tone="bad" srLabel=". Open Overview, Health">
            1 problem stops every call
          </HealthLine>
        </>
      ),
      code: `<HealthLine href="/admin#ov-health" srLabel=". Open Overview, Health">Healthy · 1 note</HealthLine>
<HealthLine href="/admin#ov-health" tone="info" srLabel=". Open Overview, Health">Healthy · 2 notes</HealthLine>
<HealthLine href="/admin#ov-attention" tone="warn" srLabel=". Open Overview, Needs attention">3 warnings to review</HealthLine>
<HealthLine href="/admin#ov-health" tone="bad" srLabel=". Open Overview, Health">1 problem stops every call</HealthLine>`,
    },
    {
      title: 'Section icons',
      description: 'The four inline SVG icons of the sidebar, decorative (aria-hidden).',
      render: () => (
        <>
          <NavIcon name="monitoring" />
          <NavIcon name="tokens" />
          <NavIcon name="consumers" />
          <NavIcon name="users" />
        </>
      ),
      code: `<NavIcon name="monitoring" />
<NavIcon name="tokens" />
<NavIcon name="consumers" />
<NavIcon name="users" />`,
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
          description: 'Instance block: the name links home, the host is the mono line under it.',
        },
        { name: 'nav', type: 'Child', required: true, description: 'A SideNav.' },
        { name: 'health', type: 'Child', description: 'A HealthLine, under the instance block.' },
        {
          name: 'account',
          type: 'Child',
          description: 'An AccountMenu (it renders the .acct block) at the bottom of the sidebar.',
        },
        {
          name: 'banner',
          type: 'Child',
          description: 'A HealthStrip at the top of main, for error-level problems only.',
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
          description:
            'false renders a div instead of main and drops the skip link (docs examples).',
        },
        { name: 'class', type: 'string', description: 'Extra classes on .app.' },
        { name: 'children', type: 'Child', description: 'Main column content: one Page.' },
      ],
    },
    {
      component: 'SideNav',
      props: [
        {
          name: 'label',
          type: 'string',
          required: true,
          description: 'Name of the nav landmark ("Sections").',
        },
        {
          name: 'sections',
          type: 'readonly SideNavSection[]',
          required: true,
          description:
            'label, href, icon, count, pill { label, srLabel }, open, current, items[] { label, href, current }.',
        },
        { name: 'class', type: 'string', description: 'Extra classes on the nav.' },
      ],
    },
    {
      component: 'NavIcon',
      props: [
        {
          name: 'name',
          type: "'monitoring' | 'tokens' | 'consumers' | 'users'",
          required: true,
          description: 'Which section icon.',
        },
        { name: 'class', type: 'string', description: 'Extra classes on the svg.' },
      ],
    },
    {
      component: 'HealthLine',
      props: [
        {
          name: 'href',
          type: 'string',
          required: true,
          description: 'Overview, Needs attention (#ov-attention) or Health (#ov-health).',
        },
        {
          name: 'tone',
          type: "'ok' | 'warn' | 'bad' | 'info'",
          default: "'ok'",
          description: 'Dot color.',
        },
        { name: 'children', type: 'Child', required: true, description: 'The visible summary.' },
        {
          name: 'srLabel',
          type: 'string',
          description:
            'Rest of the link name for screen readers (". Open Overview, Needs attention").',
        },
        { name: 'class', type: 'string', description: 'Extra classes on the link.' },
      ],
    },
    {
      component: 'AccountMenu',
      props: [
        { name: 'id', type: 'string', required: true, description: 'Id of the popover menu.' },
        { name: 'name', type: 'string', required: true, description: 'The signed-in person.' },
        {
          name: 'role',
          type: 'string',
          required: true,
          description: 'Their role, under the name.',
        },
        {
          name: 'initials',
          type: 'string',
          required: true,
          description: 'Avatar initials (hidden from screen readers).',
        },
        { name: 'class', type: 'string', description: 'Extra classes on .acct.' },
        {
          name: 'children',
          type: 'Child',
          required: true,
          description:
            'MenuItems: Export configuration (admins and owners), Docs, MenuSeparator, Sign out.',
        },
      ],
    },
    {
      component: 'HealthStrip',
      props: [
        { name: 'title', type: 'string', required: true, description: 'Bold first sentence.' },
        {
          name: 'glyph',
          type: 'string',
          default: "'✕'",
          description: 'Decorative glyph before the title.',
        },
        { name: 'children', type: 'Child', description: 'What it means: what fails.' },
        { name: 'action', type: 'Child', description: 'The fix, usually one link.' },
        { name: 'class', type: 'string', description: 'Extra classes on the strip.' },
      ],
    },
  ],
  accessibility: [
    'The skip link is the first focusable element and targets main; there is one main per page.',
    'The current page carries aria-current="page", on the sub-item or on a section without items.',
    'The navigation is a nav landmark with the name you pass. Below 40rem it sits behind a native details “Menu” button.',
    'The pending pill and the health line finish their sentence for screen readers (srLabel), so the link names are complete.',
    'The account button opens a popover: the browser sets aria-expanded, Esc and a click outside close it. Its name ends with “, account menu”.',
    'The health strip is role="alert": it is announced when the page loads. Use it for one error-level problem only.',
  ],
  do: [
    'Render the sidebar from one data structure, so it is the same markup on every page.',
    'Keep counts and the pending pill on the section row, open or closed. Drop them on an empty install.',
    'Show Export configuration in the account menu only to admins and owners.',
  ],
  dont: [
    'Do not add group labels to the sidebar.',
    'Do not vary the sidebar per page, other than the current item and the counts.',
    'Do not use the health strip for warnings: the health line and Needs attention carry them.',
  ],
  classes: [
    'app',
    'skip-link',
    'side',
    'side-in',
    'inst',
    'mark',
    'inst-name',
    'inst-host',
    'health',
    'dot',
    'navd',
    'navd-in',
    'nav',
    'nav-item',
    'is-open',
    'nav-sub',
    'nav-count',
    'nav-pill',
    'ic',
    'acct',
    'acct-btn',
    'acct-who',
    'avatar',
    'chev',
    'main',
    'hstrip',
  ],
};

const menu: ComponentDoc = {
  slug: 'menu',
  name: 'Menu',
  related: ['MenuItem', 'MenuSeparator'],
  summary:
    'A popover list of links and POST buttons, opened by a button with popovertarget: no JavaScript, Esc and a click outside close it.',
  usage: {
    when: [
      'The account menu (AccountMenu uses it).',
      'A short list of secondary actions on one object, where each item is a link or a single POST.',
    ],
    whenNot: [
      'One or two actions: show the buttons.',
      'A choice the user must confirm: open a ConfirmDialog from the page instead. A menu never opens a dialog.',
      'Navigation between pages of a section: that is the sidebar.',
    ],
  },
  examples: [
    {
      title: 'Links, a separator and a POST item',
      description: 'Press the button: the menu opens in the top layer.',
      render: () => (
        <>
          <button class="btn secondary" type="button" popovertarget="ex-menu-1">
            Slack actions<span aria-hidden="true">▾</span>
          </button>
          <Menu id="ex-menu-1">
            <MenuItem href="#">Test the secret</MenuItem>
            <MenuItem href="#">Open requests</MenuItem>
            <MenuSeparator />
            <MenuItem action="#" name="enabled" value="0">
              Disable Slack
            </MenuItem>
          </Menu>
        </>
      ),
      code: `<button class="btn secondary" type="button" popovertarget="slack-actions">
  Slack actions<span aria-hidden="true">▾</span>
</button>
<Menu id="slack-actions">
  <MenuItem href="/admin/tokens/slack/test">Test the secret</MenuItem>
  <MenuItem href="/admin/requests?token=slack">Open requests</MenuItem>
  <MenuSeparator />
  <MenuItem action="/admin/tokens/svc_01JB8Y2K…/enabled" name="enabled" value="0">
    Disable Slack
  </MenuItem>
</Menu>`,
    },
  ],
  props: [
    {
      component: 'Menu',
      props: [
        {
          name: 'id',
          type: 'string',
          required: true,
          description: 'Popover id; the opening button sets popovertarget to it.',
        },
        { name: 'class', type: 'string', description: 'Extra classes on .menu.' },
        {
          name: 'children',
          type: 'Child',
          required: true,
          description: 'MenuItems and MenuSeparators.',
        },
      ],
    },
    {
      component: 'MenuItem',
      props: [
        { name: 'href', type: 'string', description: 'A link item. Pass href or action.' },
        {
          name: 'action',
          type: 'string',
          description: 'A POST item: the item is the submit button of its own form.',
        },
        { name: 'name / value', type: 'string', description: 'Sent with a POST item.' },
        {
          name: 'fields',
          type: 'Child',
          description: 'Hidden inputs of a POST item (CSRF token).',
        },
        { name: 'class', type: 'string', description: 'Extra classes on the item.' },
        { name: 'children', type: 'Child', required: true, description: 'The outcome as a label.' },
      ],
    },
    { component: 'MenuSeparator', props: [] },
  ],
  accessibility: [
    'The trigger is a real button with popovertarget: the browser exposes aria-expanded and moves focus logically.',
    'Items are ordinary links and buttons in Tab order, not an ARIA menu (that would need scripted arrow keys).',
    'Give the trigger a visible label; the chevron is aria-hidden.',
  ],
  do: ['Name items after their outcome.', 'Keep Sign out last, after a separator.'],
  dont: [
    'Do not open a dialog from a menu item.',
    'Do not use role="menu" or put more than about six items in a menu.',
  ],
  classes: ['menu', 'menu-item'],
};

const page: ComponentDoc = {
  slug: 'page',
  name: 'Page',
  summary:
    'The centered content column in the main area: at most 76rem plus the gutters, 32px between blocks. The sidebar stays on the left.',
  usage: {
    when: ['Once per page, directly inside AppShell, holding the header and the trays.'],
    whenNot: ['Nested: there is one column per page.'],
  },
  examples: [
    {
      title: 'Header and trays in the column',
      description:
        'Wider than 76rem, the free space splits evenly on both sides; narrower, the gutter is 32px, then 24px under 64rem and 16px under 40rem.',
      layout: 'frame',
      render: () => (
        <Page>
          <PageHeader
            title="Consumer access"
            count={9}
            description="Who can use which token, and from which jobs."
          />
          <Tray id="ex-page-tray" title="All accesses" count={9} description="Newest first.">
            <Panel variant="pad">
              <p>The tray starts at the column’s left edge, like the header.</p>
            </Panel>
          </Tray>
          <Tray id="ex-page-tray-2" title="Expiring soon" count={1}>
            <Panel variant="pad">
              <p>32px between top-level blocks.</p>
            </Panel>
          </Tray>
        </Page>
      ),
      code: `<Page>
  <PageHeader title="Consumer access" count={9} description="Who can use which token, and from which jobs." />
  <Tray id="all-accesses" title="All accesses" count={9} description="Newest first.">
    <Panel variant="pad">…</Panel>
  </Tray>
  <Tray id="expiring" title="Expiring soon" count={1}>…</Tray>
</Page>`,
    },
  ],
  props: [
    {
      component: 'Page',
      props: [
        { name: 'class', type: 'string', description: 'Extra classes on .page.' },
        { name: 'children', type: 'Child', description: 'PageHeader, then the top-level blocks.' },
      ],
    },
  ],
  accessibility: [
    'A plain div: landmarks come from AppShell, headings from PageHeader and Tray.',
    'The column reflows down to 320px without sideways scrolling.',
  ],
  do: [
    'Let every block start at the column’s left edge.',
    'Put a form page’s form layout directly in Page: the column narrows to the form measure by itself.',
  ],
  dont: ['Do not set widths or margins on blocks to “center” them: the column does it.'],
  classes: ['page', 'stack', 'stack-sm'],
};

const pageHeader: ComponentDoc = {
  slug: 'page-header',
  name: 'PageHeader',
  related: ['Breadcrumbs', 'Identity', 'RelationLine'],
  summary:
    'Breadcrumb, the title row (list title with count, or the detail identity) with the actions, then the relation line and the tab row.',
  usage: {
    when: [
      'At the top of every page, as the first child of Page.',
      'List pages: title, count and description. Detail pages: Identity with logo, status, slug and ID chip.',
    ],
    whenNot: ['Section headings inside the page: those are tray titles.'],
  },
  examples: [
    {
      title: 'List page',
      layout: 'frame',
      render: () => (
        <PageHeader
          title="Service tokens"
          count={6}
          description={
            <>
              Secrets of the upstream APIs that consumers call through tokengate. Loading a token
              gives nobody access; consumer access is given separately. <a href="#">Learn more</a>
            </>
          }
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
  description={<>Secrets of the upstream APIs that consumers call through tokengate. … <a href="/docs/tokens">Learn more</a></>}
  actions={<a class="btn primary" href="/admin/tokens/new"><span class="plus" aria-hidden="true">+</span>Add token</a>}
/>`,
    },
    {
      title: 'Detail page: identity, relation line and tab row',
      description:
        'Meta order: type → slug → ID chip → facts. The ID chip holds the full ID and selects as a whole (the copy source).',
      layout: 'frame',
      render: () => (
        <PageHeader
          crumbs={[{ label: 'Service tokens', href: '#' }, { label: 'Slack' }]}
          identity={
            <Identity
              logo={SLACK_LOGO}
              title="Slack"
              status={
                <Badge tone="ok" glyph="✓">
                  Active
                </Badge>
              }
              type="Slack Web API"
              slug="slack"
              entityId={{ value: 'svc_01JB8Y2K4M6P8R0T2V4X6Z8A1C', label: 'Token ID' }}
              facts={['Created 3 Oct 2026']}
            />
          }
          actions={
            <>
              <a class="btn secondary" href="#">
                Test
              </a>
              <a class="btn secondary" href="#">
                Replace secret
              </a>
              <a class="btn primary" href="#">
                <span class="plus" aria-hidden="true">
                  +
                </span>
                Give access
              </a>
            </>
          }
        >
          <RelationLine>
            <a href="#">2 consumers</a> can use Slack through <a href="#">3 accesses</a>. 2,140
            requests in the last 24 hours.
          </RelationLine>
          <TabRow>
            <Tabs
              label="Token views (example)"
              items={[
                { label: 'Overview', href: '#', current: true },
                { label: 'Access', href: '#', count: 3 },
                { label: 'Requests', href: '#' },
                { label: 'Settings', href: '#' },
              ]}
            />
            <Segmented
              label="Range (example)"
              size="sm"
              items={[
                { label: '24 hours', href: '#', current: true },
                { label: '7 days', href: '#' },
                { label: '30 days', href: '#' },
              ]}
            />
          </TabRow>
        </PageHeader>
      ),
      code: `<PageHeader
  crumbs={[{ label: 'Service tokens', href: '/admin/tokens' }, { label: 'Slack' }]}
  identity={
    <Identity
      logo={<span class="logo lg lg-slack" aria-hidden="true">S</span>}
      title="Slack"
      status={<Badge tone="ok" glyph="✓">Active</Badge>}
      type="Slack Web API"
      slug="slack"
      entityId={{ value: 'svc_01JB8Y2K4M6P8R0T2V4X6Z8A1C', label: 'Token ID' }}
      facts={['Created 3 Oct 2026']}
    />
  }
  actions={<>…Test, Replace secret, <a class="btn primary" href="…">+ Give access</a></>}
>
  <RelationLine><a href="…">2 consumers</a> can use Slack through <a href="…">3 accesses</a>. …</RelationLine>
  <TabRow>
    <Tabs label="Token views" items={[{ label: 'Overview', href: '…', current: true }, { label: 'Access', href: '…', count: 3 }, …]} />
    <Segmented label="Range" size="sm" items={[{ label: '24 hours', href: '?range=24h', current: true }, …]} />
  </TabRow>
</PageHeader>`,
    },
    {
      title: 'Detail page for a person',
      description: 'An avatar instead of a logo; a pending person has the info badge.',
      layout: 'frame',
      render: () => (
        <PageHeader
          crumbs={[{ label: 'People', href: '#' }, { label: 'Sam Ito' }]}
          identity={
            <Identity
              logo={
                <span class="avatar lg pending" aria-hidden="true">
                  SI
                </span>
              }
              title="Sam Ito"
              status={
                <Badge tone="info" glyph="◐">
                  Pending approval
                </Badge>
              }
              type="sam@acme.dev"
              entityId={{ value: 'usr_01JB9C4R7T2V5X8Z1B3D6F9H2K', label: 'User ID' }}
              facts={['Asked 2 h ago']}
            />
          }
          actions={
            <a class="btn primary" href="#">
              Approve
            </a>
          }
        />
      ),
      code: `<PageHeader
  crumbs={[{ label: 'People', href: '/admin/users' }, { label: 'Sam Ito' }]}
  identity={
    <Identity
      logo={<span class="avatar lg pending" aria-hidden="true">SI</span>}
      title="Sam Ito"
      status={<Badge tone="info" glyph="◐">Pending approval</Badge>}
      type="sam@acme.dev"
      entityId={{ value: 'usr_01JB9C4R7T2V5X8Z1B3D6F9H2K', label: 'User ID' }}
      facts={['Asked 2 h ago']}
    />
  }
  actions={<a class="btn primary" href="…">Approve</a>}
/>`,
    },
    {
      title: 'Breadcrumb to a request',
      description:
        'The first crumb is the list page (its H1), never the section; a request is named by its ID.',
      layout: 'frame',
      render: () => (
        <PageHeader
          crumbs={[{ label: 'Requests', href: '#' }, { label: 'req_01JB8Z5K…' }]}
          title="Denied request"
          description="GitHub Actions (acme) › acme/api called Slack and no access matched."
        />
      ),
      code: `<PageHeader
  crumbs={[{ label: 'Requests', href: '/admin/requests' }, { label: 'req_01JB8Z5K…' }]}
  title="Denied request"
  description="GitHub Actions (acme) › acme/api called Slack and no access matched."
/>`,
    },
  ],
  props: [
    {
      component: 'PageHeader',
      props: [
        {
          name: 'title',
          type: 'Child',
          description: 'List pages: the H1. Pass title or identity.',
        },
        {
          name: 'count',
          type: 'number | string',
          description: 'List pages: count after the title.',
        },
        {
          name: 'description',
          type: 'Child',
          description: 'List pages: one or two sentences (max 70ch).',
        },
        {
          name: 'identity',
          type: 'Child',
          description: 'Detail pages: an Identity (it renders the H1).',
        },
        {
          name: 'crumbs',
          type: 'readonly Crumb[]',
          description: 'Breadcrumb; the last is the current page.',
        },
        { name: 'actions', type: 'Child', description: 'Buttons; at most one primary, last.' },
        { name: 'class', type: 'string', description: 'Extra classes on the header.' },
        {
          name: 'children',
          type: 'Child',
          description: 'Rows under the title: RelationLine, then TabRow or Tabs.',
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
    {
      component: 'Identity',
      props: [
        { name: 'title', type: 'Child', required: true, description: 'The object name: the H1.' },
        { name: 'logo', type: 'Child', description: 'A 40px logo tile or avatar, aria-hidden.' },
        { name: 'status', type: 'Child', description: 'Status badge inside the H1.' },
        {
          name: 'type',
          type: 'Child',
          description: 'Type or description, first in the meta line.',
        },
        { name: 'slug', type: 'string', description: 'Mono slug.' },
        {
          name: 'entityId',
          type: '{ value: string; label: string }',
          description:
            'Full ID in the ID chip; label ("Token ID") is its tooltip and screen reader name.',
        },
        {
          name: 'facts',
          type: 'readonly Child[]',
          description: 'Facts after the ID (created, last sign-in).',
        },
        { name: 'class', type: 'string', description: 'Extra classes on .ident.' },
      ],
    },
    {
      component: 'RelationLine',
      props: [
        { name: 'class', type: 'string', description: 'Extra classes on the paragraph.' },
        { name: 'children', type: 'Child', description: 'One sentence with the counts as links.' },
      ],
    },
  ],
  accessibility: [
    'One H1 per page: the list title, or the name inside Identity (with its status badge).',
    'The breadcrumb is a nav named “Breadcrumb”; the last item has aria-current="page".',
    'The ID chip’s kind (“Token ID”) is read before the chip; the chip itself holds only the ID, so selecting it copies only the ID.',
  ],
  do: [
    'Name the first crumb after the list page the object belongs to.',
    'Keep the identity meta order: type, slug, ID chip, facts.',
  ],
  dont: [
    'Do not put more than one primary button in the header.',
    'Do not truncate the ID in the markup: CSS ellipsis handles narrow widths.',
  ],
  classes: [
    'ph',
    'crumbs',
    'ph-row',
    'ph-title',
    'count',
    'desc',
    'ph-actions',
    'ident',
    'ident-meta',
    'slug',
    'idchip',
    'relline',
  ],
};

const tabs: ComponentDoc = {
  slug: 'tabs',
  name: 'Tabs',
  related: ['TabRow', 'Segmented'],
  summary:
    'Linked tabs for the views of one object, and the linked segmented control for one parameter of a view (range, Map | Matrix).',
  usage: {
    when: [
      'Tabs: the views of one object (Overview, Access, Requests, Settings) or the outcomes of one list.',
      'Segmented: 2–5 values of one parameter of the same view, such as the time range.',
      'TabRow: tabs and a segmented control on one shared line under the header.',
    ],
    whenNot: [
      'Sub-navigation of a section: it lives in the sidebar.',
      'Choices inside a form: use radio cards or picks.',
    ],
  },
  examples: [
    {
      title: 'Entity tabs with counts',
      layout: 'stack',
      render: () => (
        <Tabs
          label="Consumer views (example)"
          items={[
            { label: 'Overview', href: '#', current: true },
            { label: 'Access', href: '#', count: 6 },
            { label: 'Requests', href: '#' },
            { label: 'Trust settings', href: '#' },
          ]}
        />
      ),
      code: `<Tabs
  label="Consumer views"
  items={[
    { label: 'Overview', href: '/admin/consumers/github-acme', current: true },
    { label: 'Access', href: '/admin/consumers/github-acme/access', count: 6 },
    { label: 'Requests', href: '/admin/consumers/github-acme/requests' },
    { label: 'Trust settings', href: '/admin/consumers/github-acme/trust' },
  ]}
/>`,
    },
    {
      title: 'Tab row: outcomes and the time range',
      layout: 'stack',
      render: () => (
        <TabRow>
          <Tabs
            label="Outcome (example)"
            items={[
              { label: 'All', href: '#', count: '8,214', current: true },
              { label: 'Allowed', href: '#', count: '7,961' },
              { label: 'Denied', href: '#', count: 241 },
              { label: 'Errors', href: '#', count: 12 },
            ]}
          />
          <Segmented
            label="Time range (example)"
            size="sm"
            items={[
              { label: '1 hour', href: '#' },
              { label: '24 hours', href: '#', current: true },
              { label: '7 days', href: '#' },
              { label: '30 days', href: '#' },
            ]}
          />
        </TabRow>
      ),
      code: `<TabRow>
  <Tabs label="Outcome" items={[
    { label: 'All', href: '?outcome=all', count: '8,214', current: true },
    { label: 'Allowed', href: '?outcome=allowed', count: '7,961' },
    { label: 'Denied', href: '?outcome=denied', count: 241 },
    { label: 'Errors', href: '?outcome=error', count: 12 },
  ]} />
  <Segmented label="Time range" size="sm" items={[
    { label: '1 hour', href: '?range=1h' },
    { label: '24 hours', href: '?range=24h', current: true },
    { label: '7 days', href: '?range=7d' },
    { label: '30 days', href: '?range=30d' },
  ]} />
</TabRow>`,
    },
    {
      title: 'Segmented control, default size',
      description: 'The view switch in a tray header of the connections map.',
      render: () => (
        <Segmented
          label="View (example)"
          items={[
            { label: 'Map', href: '#', current: true },
            { label: 'Matrix', href: '#' },
          ]}
        />
      ),
      code: `<Segmented label="View" items={[
  { label: 'Map', href: '?view=map', current: true },
  { label: 'Matrix', href: '?view=matrix' },
]} />`,
    },
  ],
  props: [
    {
      component: 'Tabs',
      props: [
        { name: 'label', type: 'string', required: true, description: 'Name of the nav landmark.' },
        {
          name: 'items',
          type: 'readonly { label: Child; href: string; count?: number | string; current?: boolean }[]',
          required: true,
          description: 'The tabs; mark exactly one current.',
        },
        { name: 'class', type: 'string', description: 'Extra classes on the nav.' },
      ],
    },
    {
      component: 'TabRow',
      props: [
        { name: 'class', type: 'string', description: 'Extra classes on .tabrow.' },
        { name: 'children', type: 'Child', description: 'Tabs, then a Segmented.' },
      ],
    },
    {
      component: 'Segmented',
      props: [
        { name: 'label', type: 'string', required: true, description: 'Name of the nav landmark.' },
        {
          name: 'items',
          type: 'readonly { label: Child; href: string; current?: boolean }[]',
          required: true,
          description: 'The values; mark exactly one current.',
        },
        { name: 'size', type: "'sm'", description: '32px instead of 40px.' },
        { name: 'class', type: 'string', description: 'Extra classes on the nav.' },
      ],
    },
  ],
  accessibility: [
    'Each tab and segment is a link to a page; the current one has aria-current="page". No ARIA tab roles: they would need scripted arrow keys.',
    'Each nav has its own name (label), so a page with tabs and a range lists both landmarks clearly.',
    'The current tab is marked by color and a 2px bar; in forced colors by an outline.',
  ],
  do: ['Mark exactly one item current.', 'Put counts in the tab, not in its label text.'],
  dont: [
    'Do not use tabs for sub-navigation of a section.',
    'Do not use a segmented control for more than five values.',
  ],
  classes: ['tabs', 'n', 'tabrow', 'seg', 'sm'],
};

const tray: ComponentDoc = {
  slug: 'tray',
  name: 'Tray',
  related: ['Panel'],
  summary: 'A gray tray card with a title row, holding one or more white panels.',
  usage: {
    when: [
      'Every top-level block of a page under the header.',
      'Panel inside a tray: pad for content, flush for tables.',
    ],
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
          description="Each token is a secret tokengate keeps for one upstream API."
          actions={
            <a class="btn sm secondary" href="#">
              Open consumer access
            </a>
          }
        >
          <Panel variant="pad">
            <p>A padded panel: 20px inside, 20px between its children.</p>
          </Panel>
          <Panel variant="pad">
            <p>A second panel, 4px below the first.</p>
          </Panel>
        </Tray>
      ),
      code: `<Tray id="all-tokens" title="All tokens" count={6}
  description="Each token is a secret tokengate keeps for one upstream API."
  actions={<a class="btn sm secondary" href="/admin/access">Open consumer access</a>}>
  <Panel variant="pad">…</Panel>
  <Panel variant="pad">…</Panel>
</Tray>`,
    },
    {
      title: 'Warn tone with a footer',
      layout: 'stack',
      render: () => (
        <Tray
          id="ex-tray-2"
          title="Needs attention"
          count={3}
          tone="warn"
          footer="Updated 14:05 UTC"
        >
          <Panel variant="pad">
            <p>The secret of OpenAI expires on 21 Oct 2026.</p>
          </Panel>
        </Tray>
      ),
      code: `<Tray id="attention" title="Needs attention" count={3} tone="warn" footer="Updated 14:05 UTC">
  <Panel variant="pad">…</Panel>
</Tray>`,
    },
    {
      title: 'Flush panel and a level-3 title',
      description:
        'Under another h2, the title is an h3 that looks the same. A flush panel holds a table edge to edge.',
      layout: 'stack',
      render: () => (
        <Tray id="ex-tray-3" title="Allowed hosts" level={3} count={2}>
          <Panel variant="flush">
            <p class="oneline">slack.com, files.slack.com</p>
          </Panel>
        </Tray>
      ),
      code: `<Tray id="hosts" title="Allowed hosts" level={3} count={2}>
  <Panel variant="flush">…table…</Panel>
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
        {
          name: 'bar',
          type: 'Child',
          description:
            'A filter bar or quick links placed straight in the title row, after the title.',
        },
        {
          name: 'hideTitle',
          type: 'boolean',
          description:
            'Keeps the title for screen readers only, so the title row holds just the bar.',
        },
        { name: 'actions', type: 'Child', description: 'Right side of the title row.' },
        { name: 'footer', type: 'Child', description: 'Footer facts.' },
        { name: 'level', type: '2 | 3', default: '2', description: 'Heading level of the title.' },
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
    'The warn bar is decorative: say why in the content.',
  ],
  do: ['Give every tray a unique id.', 'Stack panels in a tray; they get 4px between them.'],
  dont: [
    'Do not put a tray inside a panel.',
    'Do not skip heading levels: use level={3} under an h2.',
  ],
  classes: ['tray', 'tray-h', 't', 'end', 'tray-f', 'tone-warn', 'panel', 'pad', 'flush'],
};

const dangerZone: ComponentDoc = {
  slug: 'danger-zone',
  name: 'DangerZone',
  related: ['DangerRow'],
  summary:
    'The last tray of a detail page: the destructive actions as rows, least destructive first; Delete opens a confirm dialog.',
  usage: {
    when: ['Disable, delete, reset and remove actions of one object, on its detail page.'],
    whenNot: [
      'Row actions in a list: they stay in the row (and confirm in a dialog when irreversible).',
    ],
  },
  examples: [
    {
      title: 'Disable, then delete with a confirm dialog',
      description:
        'Disable posts directly (it is reversible). Delete… opens the dialog; press it to try.',
      layout: 'stack',
      render: () => (
        <>
          <DangerZone id="ex-dz-1">
            <DangerRow
              title="Disable token"
              description="2 consumers lose access until you enable it again. Nothing is deleted."
              action={
                <form method="post" action="#">
                  <input type="hidden" name="enabled" value="0" />
                  <button class="btn secondary" type="submit">
                    Disable Slack
                  </button>
                </form>
              }
            />
            <DangerRow
              title="Delete Slack and its 3 consumer accesses"
              description="The secret and the accesses are removed. This cannot be undone."
              action={
                <DialogTrigger dialog="ex-dz-dlg" variant="danger">
                  Delete Slack…
                </DialogTrigger>
              }
            />
          </DangerZone>
          <ConfirmDialog
            id="ex-dz-dlg"
            title="Delete Slack and its 3 consumer accesses?"
            description="This cannot be undone. Calls through /proxy/slack fail from the next request."
            action="#"
            confirmLabel="Delete Slack"
            consequences={['The secret •••• 9fQa is erased.', '3 consumer accesses are deleted.']}
            confirmText={{ value: 'slack', hint: 'The slug of this token, in lower case.' }}
          />
        </>
      ),
      code: `<DangerZone id="danger">
  <DangerRow
    title="Disable token"
    description="2 consumers lose access until you enable it again. Nothing is deleted."
    action={
      <form method="post" action="/admin/tokens/svc_01JB8Y2K…/enabled">
        <input type="hidden" name="enabled" value="0" />
        <button class="btn secondary" type="submit">Disable Slack</button>
      </form>
    }
  />
  <DangerRow
    title="Delete Slack and its 3 consumer accesses"
    description="The secret and the accesses are removed. This cannot be undone."
    action={<DialogTrigger dialog="dlg-del" variant="danger">Delete Slack…</DialogTrigger>}
  />
</DangerZone>
<ConfirmDialog id="dlg-del" … />`,
    },
  ],
  props: [
    {
      component: 'DangerZone',
      props: [
        {
          name: 'id',
          type: 'string',
          required: true,
          description: 'Tray id; the heading gets id-h.',
        },
        {
          name: 'title',
          type: 'Child',
          default: "'Danger zone'",
          description: 'Tray title, in the bad color.',
        },
        { name: 'class', type: 'string', description: 'Extra classes on the tray.' },
        { name: 'children', type: 'Child', required: true, description: 'DangerRows.' },
      ],
    },
    {
      component: 'DangerRow',
      props: [
        {
          name: 'title',
          type: 'Child',
          required: true,
          description: 'What the action does, with the object (an h3).',
        },
        { name: 'description', type: 'Child', description: 'The consequence in one sentence.' },
        {
          name: 'action',
          type: 'Child',
          required: true,
          description:
            'A secondary submit (reversible) or a danger DialogTrigger whose label ends with “…”.',
        },
        { name: 'class', type: 'string', description: 'Extra classes on .dz-row.' },
      ],
    },
  ],
  accessibility: [
    'A named region (its h2); each row is an h3, so the actions are reachable by heading.',
    'Button labels name the object (“Disable Slack”, “Delete Slack…”), so they make sense out of context.',
  ],
  do: ['Put the reversible action first.', 'Say what is kept and what is lost.'],
  dont: [
    'Do not use the solid danger button on the page: it lives only inside the confirm dialog.',
    'Do not delete without a confirm dialog.',
  ],
  classes: ['danger-zone', 'dz-row', 'tray', 'panel', 'flush'],
};

const detailLayout: ComponentDoc = {
  slug: 'detail-layout',
  name: 'DetailLayout',
  summary:
    'The body of a detail page: the main column of trays plus a 20rem right rail from 80rem; below that the rail drops under the main column.',
  usage: {
    when: ['Detail pages (a token, a consumer, an access, a person), after the page header.'],
    whenNot: ['Form pages: their summary rail comes with the form layout.', 'List pages.'],
  },
  examples: [
    {
      title: 'Token detail with its rail',
      layout: 'frame',
      render: () => (
        <Page>
          <DetailLayout
            railLabel="Slack activity and details (example)"
            rail={
              <>
                <Tray id="ex-dl-details" title="Details">
                  <Panel>
                    {/* dl.rkv: RailKeyValue of the data group */}
                    <dl class="rkv">
                      <div>
                        <dt>Token ID</dt>
                        <dd class="mono copyable">svc_01JB8Y2K4M6P8R0T2V4X6Z8A1C</dd>
                      </div>
                      <div>
                        <dt>Slug</dt>
                        <dd class="mono">slack</dd>
                      </div>
                      <div>
                        <dt>Created</dt>
                        <dd>
                          3 Oct 2026<small>by Priya Natarajan</small>
                        </dd>
                      </div>
                    </dl>
                  </Panel>
                </Tray>
                <Tray id="ex-dl-history" title="History">
                  <Panel>
                    {/* ol.feed.compact: Feed of the data group */}
                    <ol class="feed compact">
                      <li>
                        <span class="avatar" aria-hidden="true">
                          MC
                        </span>
                        <span class="s">
                          <b>Maya Chen</b> gave <a href="#">acme/api</a> access
                        </span>
                        <time datetime="2026-10-15T09:12Z">09:12</time>
                      </li>
                      <li>
                        <span class="avatar" aria-hidden="true">
                          PN
                        </span>
                        <span class="s">
                          <b>Priya Natarajan</b> created Slack
                        </span>
                        <time datetime="2026-10-03T14:18Z">3 Oct</time>
                      </li>
                    </ol>
                    <p class="rail-foot">
                      <a class="linkish" href="#">
                        Audit history <span aria-hidden="true">→</span>
                      </a>
                    </p>
                  </Panel>
                </Tray>
              </>
            }
          >
            <Tray id="ex-dl-dest" title="Destination" description="Set by the Slack Web API type.">
              <Panel variant="pad">
                {/* dl.kv: KeyValue of the data group */}
                <dl class="kv">
                  <div>
                    <dt>Base URL</dt>
                    <dd class="mono">https://slack.com/api</dd>
                  </div>
                  <div>
                    <dt>Secret sent as</dt>
                    <dd>
                      <code>Authorization: Bearer</code>
                    </dd>
                  </div>
                  <div>
                    <dt>Timeout</dt>
                    <dd>2 min</dd>
                  </div>
                </dl>
              </Panel>
            </Tray>
            <DangerZone id="ex-dl-danger">
              <DangerRow
                title="Disable token"
                description="2 consumers lose access until you enable it again."
                action={
                  <button class="btn secondary" type="button">
                    Disable Slack
                  </button>
                }
              />
            </DangerZone>
          </DetailLayout>
        </Page>
      ),
      code: `<Page>
  <PageHeader identity={<Identity … />} … />
  <DetailLayout
    railLabel="Slack activity and details"
    rail={<>
      <Tray id="details" title="Details"><Panel><dl class="rkv">…</dl></Panel></Tray>
      <Tray id="history" title="History">
        <Panel>
          <ol class="feed compact">…</ol>
          <p class="rail-foot"><a class="linkish" href="/admin/audit?target=…">Audit history <span aria-hidden="true">→</span></a></p>
        </Panel>
      </Tray>
    </>}
  >
    <Tray id="destination" title="Destination" description="Set by the Slack Web API type.">…</Tray>
    <DangerZone id="danger">…</DangerZone>
  </DetailLayout>
</Page>`,
    },
  ],
  props: [
    {
      component: 'DetailLayout',
      props: [
        {
          name: 'railLabel',
          type: 'string',
          required: true,
          description: 'Name of the rail landmark (aside).',
        },
        {
          name: 'rail',
          type: 'Child',
          required: true,
          description: 'Rail trays: details, history, small KPIs.',
        },
        { name: 'class', type: 'string', description: 'Extra classes on .detail.' },
        {
          name: 'children',
          type: 'Child',
          required: true,
          description: 'Main column trays, 32px apart.',
        },
      ],
    },
  ],
  accessibility: [
    'The rail is a complementary landmark (aside) with its own name.',
    'In the source the main column comes first, so it is read and tabbed through before the rail.',
  ],
  do: ['Put the object’s relations and settings in the main column, IDs and history in the rail.'],
  dont: ['Do not put primary actions only in the rail: they belong in the header.'],
  classes: ['detail', 'col', 'rail', 'rail-foot'],
};

const dialog: ComponentDoc = {
  slug: 'dialog',
  name: 'Dialog',
  related: ['ConfirmDialog', 'DialogTrigger', 'DialogClose'],
  summary:
    'A modal dialog around one form, opened with no JavaScript (command="show-modal"); ConfirmDialog adds the consequences, the type-to-confirm field and the solid danger button.',
  usage: {
    when: [
      'ConfirmDialog: every irreversible action (delete, reset sign-in, make owner), opened from a danger button whose label ends with “…”.',
      'Dialog with wide: a short edit (rename, change destination) that keeps the page context.',
    ],
    whenNot: [
      'Reversible actions (disable): post directly and show a notice with Undo.',
      'Long forms: a form page.',
      'From a menu item: put the trigger on the page.',
    ],
  },
  examples: [
    {
      title: 'Confirm a cascade (press the button)',
      description:
        'Esc closes the dialog and focus returns to the button. The confirm button stays the only solid danger button in the product.',
      render: () => (
        <>
          <DialogTrigger dialog="ex-dlg-1" variant="danger">
            Delete Slack…
          </DialogTrigger>
          <ConfirmDialog
            id="ex-dlg-1"
            title="Delete Slack and its 3 consumer accesses?"
            description={
              <>
                This cannot be undone. The secret is destroyed, and from the next request these jobs
                get <code>404</code> from <code>/proxy/slack</code>:
              </>
            }
            action="#"
            confirmLabel="Delete Slack"
            affected={[
              <SlackRow
                logo="github"
                name="acme/api · environment production"
                meta="GitHub Actions (acme) · last used 2 min ago"
              />,
              <SlackRow
                logo="github"
                name="acme/web · branch main"
                meta="GitHub Actions (acme) · last used 2 h ago"
              />,
              <SlackRow
                logo="gitlab"
                name="platform/deploy-tools · environment production"
                meta="GitLab CI (platform) · last used 5 h ago"
              />,
            ]}
            confirmText={{
              value: 'slack',
              hint: 'The slug of this token, in lower case.',
              name: 'confirm_slug',
            }}
            fields={<input type="hidden" name="with_accesses" value="1" />}
          >
            {/* .callout: Callout of the base group */}
            <div class="callout">
              <span class="gl" aria-hidden="true">
                i
              </span>
              <div class="body">
                <p class="more">
                  2,140 requests used Slack in the last 24 hours. To stop them for now, disable
                  Slack instead: nothing is deleted and you can enable it again.
                </p>
              </div>
            </div>
          </ConfirmDialog>
        </>
      ),
      code: `<DialogTrigger dialog="dlg-del" variant="danger">Delete Slack…</DialogTrigger>
<ConfirmDialog
  id="dlg-del"
  title="Delete Slack and its 3 consumer accesses?"
  description={<>This cannot be undone. … get <code>404</code> from <code>/proxy/slack</code>:</>}
  action="/admin/tokens/svc_01JB8Y2K…/delete"
  confirmLabel="Delete Slack"
  affected={accesses.map((a) => <>…logo, name link, meta…</>)}
  confirmText={{ value: 'slack', hint: 'The slug of this token, in lower case.', name: 'confirm_slug' }}
  fields={<input type="hidden" name="with_accesses" value="1" />}
>
  <Callout more="2,140 requests used Slack in the last 24 hours. …" /> {/* base group */}
</ConfirmDialog>`,
    },
    {
      title: 'Drawn open: consequence list',
      description:
        'open renders the dialog in the page flow: the server does this after a failed submit (the confirm text did not match), or on a GET confirm page. Cancel is then a link back.',
      render: () => (
        <ConfirmDialog
          id="ex-dlg-2"
          open
          cancelHref="#"
          title="Delete Slack and its 3 consumer accesses?"
          description="Calls through /proxy/slack fail at once. You cannot undo this."
          action="#"
          confirmLabel="Delete Slack"
          consequences={[
            <>
              The secret <span class="mask">•••• 9fQa</span> is erased.
            </>,
            <>
              <a href="#">3 consumer accesses</a> are deleted: acme/api, acme/web,
              platform/deploy-tools.
            </>,
            '2,140 requests in the last 24 hours used it.',
          ]}
          confirmText={{ value: 'slack' }}
        />
      ),
      code: `<ConfirmDialog
  id="dlg-del"
  open
  cancelHref="/admin/tokens/slack"
  title="Delete Slack and its 3 consumer accesses?"
  description="Calls through /proxy/slack fail at once. You cannot undo this."
  action="/admin/tokens/svc_01JB8Y2K…/delete"
  confirmLabel="Delete Slack"
  consequences={[
    <>The secret <span class="mask">•••• 9fQa</span> is erased.</>,
    <><a href="/admin/access?token=slack">3 consumer accesses</a> are deleted: acme/api, acme/web, platform/deploy-tools.</>,
    '2,140 requests in the last 24 hours used it.',
  ]}
  confirmText={{ value: 'slack' }}
/>`,
    },
    {
      title: 'Wide edit dialog (press the button)',
      render: () => (
        <>
          <DialogTrigger dialog="ex-dlg-3">Rename…</DialogTrigger>
          <Dialog
            id="ex-dlg-3"
            wide
            title="Rename GitHub Actions (acme)"
            description="Lists and the audit log show the new name. Accesses keep working."
            action="#"
            footer={
              <>
                <DialogClose dialog="ex-dlg-3" />
                <button class="btn primary" type="submit">
                  Rename
                </button>
              </>
            }
          >
            <div class="field">
              <label for="ex-dlg-3-name">Name</label>
              <input
                class="input"
                id="ex-dlg-3-name"
                name="name"
                value="GitHub Actions (acme)"
                required
              />
            </div>
          </Dialog>
        </>
      ),
      code: `<DialogTrigger dialog="dlg-rename">Rename…</DialogTrigger>
<Dialog
  id="dlg-rename"
  wide
  title="Rename GitHub Actions (acme)"
  description="Lists and the audit log show the new name. Accesses keep working."
  action="/admin/consumers/github-acme/name"
  footer={<><DialogClose dialog="dlg-rename" /><button class="btn primary" type="submit">Rename</button></>}
>
  <div class="field"><label for="dlg-rename-name">Name</label><input class="input" id="dlg-rename-name" name="name" value="GitHub Actions (acme)" required /></div>
</Dialog>`,
    },
  ],
  props: [
    {
      component: 'Dialog',
      props: [
        {
          name: 'id',
          type: 'string',
          required: true,
          description: 'Dialog id; the title gets id-h, the description id-d.',
        },
        { name: 'title', type: 'Child', required: true, description: 'The question or task (h2).' },
        {
          name: 'description',
          type: 'Child',
          description: 'Under the title; the dialog’s description.',
        },
        { name: 'action', type: 'string', description: 'Form target. Default: the current URL.' },
        { name: 'method', type: "'post' | 'get'", default: "'post'", description: 'Form method.' },
        { name: 'fields', type: 'Child', description: 'Hidden inputs at the top of the form.' },
        {
          name: 'children',
          type: 'Child',
          description: 'Body; it scrolls, header and footer stay.',
        },
        {
          name: 'footer',
          type: 'Child',
          required: true,
          description: 'DialogClose, then the confirm button.',
        },
        { name: 'wide', type: 'boolean', description: '40rem instead of 32rem.' },
        {
          name: 'open',
          type: 'boolean',
          description: 'Render it open in the page flow (no modal).',
        },
        { name: 'class', type: 'string', description: 'Extra classes on the dialog.' },
      ],
    },
    {
      component: 'ConfirmDialog',
      props: [
        {
          name: 'id / title / description',
          type: 'string / Child',
          required: true,
          description: 'As in Dialog (description optional).',
        },
        {
          name: 'action',
          type: 'string',
          required: true,
          description: 'Where the confirm button posts.',
        },
        {
          name: 'confirmLabel',
          type: 'string',
          required: true,
          description: 'The outcome, without “…” (“Delete Slack”).',
        },
        {
          name: 'tone',
          type: "'danger' | 'primary'",
          default: "'danger'",
          description: 'Solid danger or primary confirm button.',
        },
        {
          name: 'consequences',
          type: 'readonly Child[]',
          description: 'What happens (ul.conseq), with counts and links.',
        },
        {
          name: 'affected',
          type: 'readonly Child[]',
          description: 'Affected objects as a bordered list (ul.dlg-list).',
        },
        {
          name: 'confirmText',
          type: '{ value: string; label?: Child; hint?: Child; name?: string }',
          description: 'Type-to-confirm, only for irreversible cascades. Matched literally.',
        },
        { name: 'fields', type: 'Child', description: 'Hidden inputs.' },
        {
          name: 'children',
          type: 'Child',
          description: 'More body content (a Callout with an alternative).',
        },
        { name: 'cancelLabel', type: 'string', default: "'Cancel'", description: 'Cancel label.' },
        { name: 'open', type: 'boolean', description: 'Render it open in the page flow.' },
        {
          name: 'cancelHref',
          type: 'string',
          description: 'With open: Cancel is a link back to this URL.',
        },
        { name: 'wide / class', type: 'boolean / string', description: 'As in Dialog.' },
      ],
    },
    {
      component: 'DialogTrigger',
      props: [
        {
          name: 'dialog',
          type: 'string',
          required: true,
          description: 'Id of the dialog it opens.',
        },
        {
          name: 'variant',
          type: "'primary' | 'secondary' | 'danger' | 'ghost'",
          default: "'secondary'",
          description: 'Button style; danger always opens a confirm dialog.',
        },
        { name: 'size', type: "'sm'", description: 'Small button.' },
        { name: 'class', type: 'string', description: 'Extra classes on the button.' },
        { name: 'children', type: 'Child', required: true, description: 'Label, ending with “…”.' },
      ],
    },
    {
      component: 'DialogClose',
      props: [
        {
          name: 'dialog',
          type: 'string',
          required: true,
          description: 'Id of the dialog it closes.',
        },
        { name: 'class', type: 'string', description: 'Extra classes on the button.' },
        { name: 'children', type: 'Child', default: "'Cancel'", description: 'Label.' },
      ],
    },
  ],
  accessibility: [
    'The dialog is labelled by its title and described by its description. It is modal: focus moves into it, the page behind is inert, Esc closes it and focus returns to the trigger.',
    <>
      It opens without any script: the trigger is{' '}
      <code>&lt;button type="button" commandfor command="show-modal"&gt;</code>. Where invoker
      commands are missing, the same button opens the dialog as a popover (
      <code>popovertarget</code>), with Esc to close.
    </>,
    'Cancel and the trigger are type="button", so they never submit a form; only the confirm button submits.',
    'The type-to-confirm field is required with a literal pattern, and its hint is wired with aria-describedby. The server checks it again.',
  ],
  do: [
    'Put the object and the count in the title (“Delete Slack and its 3 consumer accesses?”).',
    'List what is lost, with links, before the confirm button.',
    'Offer the reversible alternative (Disable) inside the dialog.',
  ],
  dont: [
    'Do not use type-to-confirm for actions that are easy to undo.',
    'Do not open a dialog from a menu or from another dialog.',
    'Do not put the solid danger button anywhere but the dialog footer.',
  ],
  classes: ['dlg', 'wide', 'dlg-h', 'dlg-b', 'dlg-f', 'conseq', 'dlg-list', 'danger-solid'],
};

const disclosure: ComponentDoc = {
  slug: 'disclosure',
  name: 'Disclosure',
  summary:
    'A native details disclosure with a chevron: disc for extra information or rarely used settings, more for the “More constraints” part of a form.',
  usage: {
    when: [
      'disc: advanced settings, exact conditions, the health checks list: things most people never open.',
      'more: optional constraints of a form, with a hint naming what is inside.',
      'name: an exclusive group where opening one closes the others.',
    ],
    whenNot: ['Required fields: never hide them.', 'Navigation: links or tabs.'],
  },
  examples: [
    {
      title: 'Plain disclosure with a hint',
      layout: 'stack',
      render: () => (
        <Panel variant="pad">
          <Disclosure
            summary="Advanced trust settings"
            hint="issuer, audience, algorithms, max token age"
          >
            <p class="hint">
              Defaults fit GitHub Actions. Change them only for GitHub Enterprise with its own
              issuer.
            </p>
          </Disclosure>
        </Panel>
      ),
      code: `<Disclosure summary="Advanced trust settings" hint="issuer, audience, algorithms, max token age">
  <p class="hint">Defaults fit GitHub Actions. …</p>
</Disclosure>`,
    },
    {
      title: 'Open, with the exact conditions',
      layout: 'stack',
      render: () => (
        <Panel variant="pad">
          <Disclosure summary="Exact conditions" open>
            <CodeBlock label="Exact conditions">
              {`repository_owner_id = 1234567
repository_id = 89012345
environment = production`}
            </CodeBlock>
          </Disclosure>
        </Panel>
      ),
      code: `<Disclosure summary="Exact conditions" open>
  <CodeBlock label="Exact conditions">{\`repository_owner_id = 1234567
repository_id = 89012345
environment = production\`}</CodeBlock>
</Disclosure>`,
    },
    {
      title: 'More constraints in a form',
      layout: 'stack',
      render: () => (
        <Panel variant="pad">
          <Disclosure variant="more" summary="More constraints" hint="workflow pin">
            <div class="field">
              <label for="ex-disc-wf">
                Workflow <span class="opt">(optional)</span>
              </label>
              <span class="hint" id="ex-disc-wf-h">
                The workflow file at a ref, as in the job’s job_workflow_ref claim.
              </span>
              <input
                class="input mono"
                id="ex-disc-wf"
                placeholder="acme/api/.github/workflows/deploy.yml@refs/heads/main"
                aria-describedby="ex-disc-wf-h"
                autocomplete="off"
              />
            </div>
          </Disclosure>
        </Panel>
      ),
      code: `<Disclosure variant="more" summary="More constraints" hint="workflow pin">
  <div class="field">…Workflow (optional)…</div>
</Disclosure>`,
    },
    {
      title: 'Exclusive group',
      description: 'Same name: opening one closes the other.',
      layout: 'stack',
      render: () => (
        <Panel variant="pad">
          <Disclosure name="ex-disc-group" summary="GitHub Enterprise Cloud with its own issuer">
            <p class="hint">Use the issuer URL of your enterprise.</p>
          </Disclosure>
          <Disclosure name="ex-disc-group" summary="Self-managed GitLab">
            <p class="hint">Use the instance URL, for example https://gitlab.acme.dev.</p>
          </Disclosure>
        </Panel>
      ),
      code: `<Disclosure name="issuer" summary="GitHub Enterprise Cloud with its own issuer">…</Disclosure>
<Disclosure name="issuer" summary="Self-managed GitLab">…</Disclosure>`,
    },
  ],
  props: [
    {
      component: 'Disclosure',
      props: [
        { name: 'summary', type: 'Child', required: true, description: 'What opens.' },
        {
          name: 'hint',
          type: 'Child',
          description: 'Regular-weight hint after the summary: what is inside.',
        },
        {
          name: 'variant',
          type: "'disc' | 'more'",
          default: "'disc'",
          description: 'Plain disclosure or form “More”.',
        },
        {
          name: 'open',
          type: 'boolean',
          description: 'Rendered open (a field inside has an error).',
        },
        { name: 'name', type: 'string', description: 'Exclusive group name.' },
        { name: 'id', type: 'string', description: 'Id of the details, to link to it.' },
        { name: 'class', type: 'string', description: 'Extra classes on the details.' },
        { name: 'children', type: 'Child', required: true, description: 'The hidden content.' },
      ],
    },
  ],
  accessibility: [
    'A native details/summary: a button with its expanded state for screen readers, Enter and Space toggle it.',
    'The chevron is CSS and turns when open.',
    'Open it on the server when a field inside has an error, so the error is visible.',
  ],
  do: ['Name what is inside in the hint.'],
  dont: ['Do not put required fields in a closed disclosure.', 'Do not nest disclosures.'],
  classes: ['disc', 'disc-b', 'more', 'more-b', 'hint', 'meta'],
};

export const layout: readonly ComponentDoc[] = [
  appShell,
  page,
  pageHeader,
  tabs,
  tray,
  detailLayout,
  dangerZone,
  dialog,
  menu,
  disclosure,
];
