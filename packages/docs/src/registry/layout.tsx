// Docs entries of the "layout" group (packages/ui/src/components/layout). One ComponentDoc per
// component page, in nav order. Only the layout group agent edits this file.
import {
  AccountMenu,
  AppShell,
  Column,
  Avatar,
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
  FieldInline,
  HealthLine,
  Grid,
  HealthStrip,
  Identity,
  Menu,
  MenuHeader,
  MenuItem,
  MenuSeparator,
  RowMenu,
  Icon,
  Page,
  PageHeader,
  Panel,
  RelationLine,
  Segmented,
  SideNav,
  Stack,
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
 * the current item change. `counts: false` is the empty install (no counts, no pill). `deeper`
 * marks the current item as the ancestor of a deeper page (`current: 'true'`), as a detail page does.
 */
function adminSections(
  open: SectionKey,
  current: string,
  counts = true,
  deeper = false,
): SideNavSection[] {
  const mark = deeper ? ('true' as const) : true;
  const sub = (items: Array<[string, string]>) =>
    items.map(([label, href]) => ({ label, href, current: href === current ? mark : false }));
  return [
    {
      label: 'Monitoring',
      href: '#',
      icon: <Icon name="monitoring" />,
      open: open === 'monitoring',
      items: sub([
        ['Overview', '?p=overview'],
        ['Requests', '?p=requests'],
        ['Audit log', '?p=audit'],
        ['Data retention', '?p=retention'],
      ]),
    },
    {
      label: 'Service tokens',
      href: '#',
      icon: <Icon name="token" />,
      count: counts ? 6 : undefined,
      open: open === 'tokens',
      items: sub([
        ['Tokens', '?p=tokens'],
        ['Allowed hosts', '?p=hosts'],
        ['Encryption keys', '?p=keys'],
      ]),
    },
    {
      label: 'Service consumers',
      href: '#',
      icon: <Icon name="consumer" />,
      count: counts ? 3 : undefined,
      open: open === 'consumers',
      items: sub([
        ['Consumers', '?p=consumers'],
        ['Consumer access', '?p=access'],
      ]),
    },
    {
      label: 'Users',
      href: '#',
      icon: <Icon name="users" />,
      pill: counts ? { label: '1 pending', srSuffix: ': a person needs your decision' } : undefined,
      open: open === 'users',
      items: sub([
        ['People', '?p=people'],
        ['Sign-in', '?p=sign-in'],
      ]),
    },
  ];
}

const BRAND = { name: 'tokengate', href: '#', host: 'gate.acme.dev' };

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
  { label: 'Monitoring', href: '/admin', icon: <Icon name="monitoring" />, items: [...] },
  { label: 'Service tokens', href: '/admin/tokens', icon: <Icon name="token" />, count: 6,
    open: true, items: [{ label: 'Tokens', href: '/admin/tokens', current: true }, ...] },
  { label: 'Service consumers', href: '/admin/consumers', icon: <Icon name="consumer" />, count: 3, items: [...] },
  { label: 'Users', href: '/admin/users', icon: <Icon name="users" />,
    pill: { label: '1 pending', srSuffix: ': a person needs your decision' }, items: [...] },
];`;

// ----- pages ---------------------------------------------------------------------------------------

const appShell: ComponentDoc = {
  slug: 'app-shell',
  name: 'AppShell',
  related: ['SideNav', 'HealthLine', 'AccountMenu', 'HealthStrip'],
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
            <HealthLine href="#" tone="warn" srSuffix=". Open Overview, Needs attention">
              3 warnings to review
            </HealthLine>
          }
          nav={
            <SideNav label="Sections (example)" sections={adminSections('tokens', '?p=tokens')} />
          }
          account={
            <AccountMenu id="ex-acct-1" name="Maya Chen" role="Owner">
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
    <HealthLine href="/admin#ov-attention" tone="warn" srSuffix=". Open Overview, Needs attention">
      3 warnings to review
    </HealthLine>
  }
  nav={<SideNav label="Sections" sections={sections} />}
  account={
    <AccountMenu id="acct" name="Maya Chen" role="Owner">
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
            <HealthLine href="#" tone="bad" srSuffix=". Open Overview, Health">
              1 problem stops every call
            </HealthLine>
          }
          nav={
            <SideNav
              label="Sections (strip example)"
              sections={adminSections('tokens', '?p=keys')}
            />
          }
          account={
            <AccountMenu id="ex-acct-2" name="Maya Chen" role="Owner">
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
              crumbsLabel="Breadcrumb (example 1)"
              title="Encryption keys"
              description="Keys that seal the stored secrets. tokengate keeps the old keys until every secret is sealed with the new one."
            />
          </Page>
        </AppShell>
      ),
      code: `<AppShell
  brand={brand}
  health={<HealthLine href="/admin#ov-health" tone="bad" srSuffix=". Open Overview, Health">1 problem stops every call</HealthLine>}
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
            <HealthLine href="#" srSuffix=". Open Overview, Health">
              Healthy · 1 note
            </HealthLine>
          }
          nav={
            <SideNav
              label="Sections (empty install example)"
              sections={adminSections('monitoring', '?p=overview', false)}
            />
          }
          account={
            <AccountMenu id="ex-acct-3" name="Priya Natarajan" role="Token manager">
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
  health={<HealthLine href="/admin#ov-health" srSuffix=". Open Overview, Health">Healthy · 1 note</HealthLine>}
  nav={<SideNav label="Sections" sections={sectionsWithoutCounts} />}
  account={
    <AccountMenu id="acct" name="Priya Natarajan" role="Token manager">
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
      title: 'Deeper page: a token detail under Tokens',
      description:
        'A page that is not in the sidebar marks its ancestor with current: ‘true’ (aria-current="true"). It looks the same as the current page; screen readers hear “current” instead of “current page”.',
      layout: 'frame',
      render: () => (
        <AppShell
          landmarks={false}
          mainId="ex-shell-4"
          brand={BRAND}
          nav={
            <SideNav
              label="Sections (deeper page example)"
              sections={adminSections('tokens', '?p=tokens', true, true)}
            />
          }
        >
          <Page>
            <PageHeader
              crumbs={[{ label: 'Service tokens', href: '#' }, { label: 'Slack' }]}
              crumbsLabel="Breadcrumb (deeper page example)"
              title="Slack"
            />
          </Page>
        </AppShell>
      ),
      code: `// /admin/tokens/slack: Tokens holds the page, it is not the page
const sections = [
  …,
  { label: 'Service tokens', href: '/admin/tokens', icon: <Icon name="token" />, count: 6, open: true,
    items: [{ label: 'Tokens', href: '/admin/tokens', current: 'true' }, …] },
  …,
];

<AppShell brand={brand} nav={<SideNav label="Sections" sections={sections} />} account={account}>
  <Page>…</Page>
</AppShell>`,
    },
    {
      title: 'Brand only (pre-login)',
      description:
        'With neither nav nor account (Sign-in problem, Set up sign-in), the sidebar holds the instance block alone and there is no Menu button on phones. main keeps tabindex="-1" for the skip link.',
      layout: 'frame',
      render: () => (
        <AppShell landmarks={false} mainId="ex-shell-5" brand={BRAND}>
          <Page>
            <PageHeader
              title="Set up sign-in"
              description="Connect an identity provider before anyone can use the console."
            />
          </Page>
        </AppShell>
      ),
      code: `<AppShell brand={{ name: 'tokengate', href: '/admin', host: 'gate.acme.dev' }}>
  <Page>
    <PageHeader title="Set up sign-in" description="…" />
  </Page>
</AppShell>`,
    },
    {
      title: 'Health strip, unannounced, with prefix',
      description:
        'role={null} for a strip that is part of every page load: it is not announced each time. srPrefix keeps the word the glyph stands for (“Error:”).',
      layout: 'frame',
      render: () => (
        <HealthStrip
          title="Keyring unavailable."
          role={null}
          srPrefix="Error:"
          action={<a href="#">Fix encryption keys</a>}
        >
          Stored secrets cannot be opened, so every call fails.
        </HealthStrip>
      ),
      code: `<HealthStrip
  title="Keyring unavailable."
  role={null}
  srPrefix="Error:"
  action={<a href="/admin/tokens/keys">Fix encryption keys</a>}
>
  Stored secrets cannot be opened, so every call fails.
</HealthStrip>`,
    },
    {
      title: 'Health line tones',
      description: 'One dot and the words. The dot never stands alone.',
      layout: 'stack',
      render: () => (
        <>
          <HealthLine href="#" srSuffix=". Open Overview, Health">
            Healthy · 1 note
          </HealthLine>
          <HealthLine href="#" tone="info" srSuffix=". Open Overview, Health">
            Healthy · 2 notes
          </HealthLine>
          <HealthLine href="#" tone="warn" srSuffix=". Open Overview, Needs attention">
            3 warnings to review
          </HealthLine>
          <HealthLine href="#" tone="bad" srSuffix=". Open Overview, Health">
            1 problem stops every call
          </HealthLine>
        </>
      ),
      code: `<HealthLine href="/admin#ov-health" srSuffix=". Open Overview, Health">Healthy · 1 note</HealthLine>
<HealthLine href="/admin#ov-health" tone="info" srSuffix=". Open Overview, Health">Healthy · 2 notes</HealthLine>
<HealthLine href="/admin#ov-attention" tone="warn" srSuffix=". Open Overview, Needs attention">3 warnings to review</HealthLine>
<HealthLine href="/admin#ov-health" tone="bad" srSuffix=". Open Overview, Health">1 problem stops every call</HealthLine>`,
    },
    {
      title: 'Section icons',
      description:
        'The four sections use icons of the one icon set (Icon), decorative (aria-hidden): the label carries the meaning.',
      render: () => (
        <>
          <Icon name="monitoring" />
          <Icon name="token" />
          <Icon name="consumer" />
          <Icon name="users" />
        </>
      ),
      code: `<Icon name="monitoring" />
<Icon name="token" />
<Icon name="consumer" />
<Icon name="users" />`,
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
        {
          name: 'nav',
          type: 'Child',
          description:
            'A SideNav. With neither nav nor account (pre-login pages) the Menu disclosure is left out.',
        },
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
          description: 'Id of main (tabindex="-1"); the skip link target.',
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
            "label, href, icon, count, pill { label, srSuffix }, open, current, items[] { label, href, current }. current is boolean | 'page' | 'true': true or 'page' is the current page, 'true' an ancestor of a deeper page.",
        },
        { name: 'class', type: 'string', description: 'Extra classes on the nav.' },
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
          name: 'srSuffix',
          type: 'string',
          description:
            'Rest of the link name for screen readers (". Open Overview, Needs attention"). No space before punctuation.',
        },
        { name: 'class', type: 'string', description: 'Extra classes on the link.' },
      ],
    },
    {
      component: 'AccountMenu',
      props: [
        { name: 'id', type: 'string', required: true, description: 'Id of the popover menu.' },
        {
          name: 'name',
          type: 'string',
          required: true,
          description: 'The signed-in person; the avatar initials come from it (as Avatar).',
        },
        {
          name: 'role',
          type: 'string',
          required: true,
          description: 'Their role, under the name.',
        },
        {
          name: 'initials',
          type: 'string',
          description:
            'Initials instead of the ones taken from name. The avatar is hidden from screen readers.',
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
        {
          name: 'srPrefix',
          type: 'string',
          description:
            'Hidden text read before the title, after the glyph ("Error:"). The space is added.',
        },
        {
          name: 'role',
          type: "'alert' | null",
          default: "'alert'",
          description:
            'null leaves out the role: for a strip shown on every page load, which must not be announced each time.',
        },
        { name: 'children', type: 'Child', description: 'What it means: what fails.' },
        { name: 'action', type: 'Child', description: 'The fix, usually one link.' },
        { name: 'class', type: 'string', description: 'Extra classes on the strip.' },
      ],
    },
  ],
  accessibility: [
    'The skip link is the first focusable element and targets main; there is one main per page. main has tabindex="-1" so it takes the focus, with no outline; Tab never stops there.',
    'The current page carries aria-current="page", on the sub-item or on a section without items. On a deeper page that is not in the nav (a token detail), its ancestor carries aria-current="true" and looks the same; forced-colors mode outlines it.',
    'The navigation is a nav landmark with the name you pass. Below 40rem it sits behind a native details “Menu” button. Its name stays “Menu”: the state is read from aria-expanded, and the chevron turns.',
    'From 40rem the sidebar is sticky and as tall as the window, so the account menu (the only way to Sign out) stays in reach on a long page. A sidebar taller than the window scrolls on its own.',
    'The pending pill and the health line finish their sentence for screen readers (srSuffix), so the link names are complete.',
    'The account button opens a popover: the browser sets aria-expanded, Esc and a click outside close it. Its name ends with “, account menu”.',
    'The health strip is role="alert" by default: it is announced when the page loads. Use it for one error-level problem only. A shell that shows it on every page load passes role={null}, and srPrefix="Error:" so the hidden glyph keeps its word.',
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
  related: ['MenuItem', 'MenuSeparator', 'RowMenu', 'MenuHeader'],
  summary:
    'A list of links and POST buttons: a popover Menu opened by a button (account menu), or a RowMenu disclosure in a table row (“Change ▾”). No JavaScript.',
  usage: {
    when: [
      'The account menu (AccountMenu uses Menu).',
      'A short list of secondary actions on one object, where each item is a link or a single POST.',
      'The “Change ▾” menu of a table row (RowMenu): two-line items that say what each choice changes, with an Owner… item that confirms in a dialog.',
    ],
    whenNot: [
      'One or two actions: show the buttons (ActionForm).',
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
            <MenuItem action="#" name="enabled" value="0" hidden={{ _csrf: 'csrf-token' }}>
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
  <MenuItem action="/admin/tokens/svc_01JB8Y2K…/enabled" name="enabled" value="0"
    hidden={{ _csrf: csrf }}>
    Disable Slack
  </MenuItem>
</Menu>`,
    },
    {
      title: 'Row menu with two-line items',
      description:
        'A RowMenu is a details disclosure, so it opens below its row and closes when another row menu of the same name opens. Each role item says what it adds and removes; Owner… confirms in a dialog.',
      render: () => (
        <div class="dx-rowmenu">
          <RowMenu name="ex-person-actions" srSuffix="diego@acme.dev" open>
            <MenuHeader end="now Admin">
              Change the role of <b>diego@acme.dev</b>
            </MenuHeader>
            <MenuItem
              action="#"
              name="role"
              value="viewer"
              hidden={{ _csrf: 'csrf-token' }}
              srPrefix="Make diego@acme.dev"
              keyFact="Reads only"
              detail="− service tokens, consumer access, export"
            >
              Viewer
            </MenuItem>
            <MenuItem
              action="#"
              name="role"
              value="token_manager"
              hidden={{ _csrf: 'csrf-token' }}
              srPrefix="Make diego@acme.dev"
              keyFact="Loads keys"
              detail="− consumer access, export"
            >
              Token manager
            </MenuItem>
            <MenuItem
              dialog="ex-dlg-owner"
              srPrefix="Make diego@acme.dev"
              keyFact="Everything"
              detail="People, sign-in and settings too. You confirm in a dialog."
            >
              Owner…
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              action="#"
              name="status"
              value="suspended"
              tone="bad"
              srSuffix="diego@acme.dev"
              detail="tokengate refuses every request Diego makes. Undo appears right after."
            >
              Suspend
            </MenuItem>
            <MenuItem
              href="#"
              srSuffix="of diego@acme.dev"
              keyFact={<span aria-hidden="true">→</span>}
            >
              View details
            </MenuItem>
          </RowMenu>
          <ConfirmDialog
            id="ex-dlg-owner"
            title="Make diego@acme.dev Owner?"
            description="Owners can change people, roles, sign-in and settings."
            action="#"
            confirmLabel="Make Owner"
            confirmVariant="primary"
            hidden={{ _csrf: 'csrf-token', role: 'owner' }}
          />
        </div>
      ),
      code: `<RowMenu name="person-actions" srSuffix="diego@acme.dev">
  <MenuHeader end="now Admin">Change the role of <b>diego@acme.dev</b></MenuHeader>
  <MenuItem action="/admin/users/usr_diego" name="role" value="viewer" hidden={{ _csrf: csrf }}
    srPrefix="Make diego@acme.dev" keyFact="Reads only"
    detail="− service tokens, consumer access, export">Viewer</MenuItem>
  …
  <MenuItem dialog="dlg-owner-usr_diego" srPrefix="Make diego@acme.dev" keyFact="Everything"
    detail="People, sign-in and settings too. You confirm in a dialog.">Owner…</MenuItem>
  <MenuSeparator />
  <MenuItem action="/admin/users/usr_diego/status" name="status" value="suspended" tone="bad"
    srSuffix="diego@acme.dev" detail="tokengate refuses every request Diego makes. …">Suspend</MenuItem>
  <MenuItem href="/admin/users/usr_diego" srSuffix="of diego@acme.dev"
    keyFact={<span aria-hidden="true">→</span>}>View details</MenuItem>
</RowMenu>`,
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
        { name: 'href', type: 'string', description: 'A link item. Pass href, action or dialog.' },
        {
          name: 'action',
          type: 'string',
          description: 'A POST item: the item is the submit button of its own form.',
        },
        { name: 'name / value', type: 'string', description: 'Sent with a POST item.' },
        {
          name: 'hidden',
          type: 'HiddenFields',
          description: 'Hidden fields of a POST item (_csrf, ids).',
        },
        {
          name: 'dialog',
          type: 'string',
          description:
            'Opens this Dialog (command="show-modal"): a choice that confirms first. Only in a RowMenu: a popover menu never opens a dialog.',
        },
        {
          name: 'detail',
          type: 'Child',
          description: 'Second line (.s): what the choice changes. Makes a two-line item.',
        },
        {
          name: 'keyFact',
          type: 'Child',
          description: 'Short fact at the right of the label (.k). Makes a two-line item.',
        },
        { name: 'tone', type: "'bad'", description: 'A destructive choice: the label in bad.' },
        {
          name: 'srPrefix',
          type: 'string',
          description: 'Hidden text before the label ("Make diego@acme.dev"). The space is added.',
        },
        {
          name: 'srSuffix',
          type: 'string',
          description: 'Hidden text after the label ("diego@acme.dev"). The space is added.',
        },
        { name: 'class', type: 'string', description: 'Extra classes on the item.' },
        { name: 'children', type: 'Child', required: true, description: 'The outcome as a label.' },
      ],
    },
    { component: 'MenuSeparator', props: [] },
    {
      component: 'RowMenu',
      props: [
        {
          name: 'name',
          type: 'string',
          description: 'Exclusive group: the row menus of one table share it.',
        },
        { name: 'label', type: 'Child', default: "'Change'", description: 'The button label.' },
        {
          name: 'srSuffix',
          type: 'string',
          description: 'Hidden suffix naming the row ("diego@acme.dev"). The space is added.',
        },
        { name: 'open', type: 'boolean', description: 'Render it open (server state, docs).' },
        { name: 'class', type: 'string', description: 'Extra classes on details.rowmenu.' },
        {
          name: 'children',
          type: 'Child',
          required: true,
          description: 'A MenuHeader, then MenuItems and MenuSeparators.',
        },
      ],
    },
    {
      component: 'MenuHeader',
      props: [
        { name: 'end', type: 'Child', description: 'Facts on the right ("now Admin").' },
        { name: 'class', type: 'string', description: 'Extra classes on p.menu-h.' },
        {
          name: 'children',
          type: 'Child',
          required: true,
          description: 'What the choices change.',
        },
      ],
    },
  ],
  accessibility: [
    'The Menu trigger is a real button with popovertarget: the browser exposes aria-expanded and moves focus logically.',
    'A RowMenu is a details/summary disclosure: its summary is the button, exposed as expanded or collapsed.',
    'Items are ordinary links and buttons in Tab order, not an ARIA menu (that would need scripted arrow keys).',
    'Row items name their object with srPrefix or srSuffix, so “Viewer” is read “Make diego@acme.dev Viewer”.',
    'Give the trigger a visible label; the chevron is aria-hidden.',
  ],
  do: [
    'Name items after their outcome.',
    'Keep Sign out last, after a separator.',
    'Say in the detail line what a role change adds and removes.',
  ],
  dont: [
    'Do not open a dialog from a popover Menu: the popover closes as the dialog opens. Use a RowMenu, or a DialogTrigger on the page.',
    'Do not use role="menu" or put more than about six items in a popover menu.',
  ],
  classes: [
    'menu',
    'menu-item',
    'rowmenu',
    'menu-h',
    'menu-item two',
    'k',
    's',
    'menu-item bad',
    'chev',
  ],
};

const page: ComponentDoc = {
  slug: 'page',
  name: 'Page',
  summary:
    'The content column, centered on the window: at most 76rem plus the gutters, 32px between blocks. The sidebar stays on the left.',
  usage: {
    when: ['Once per page, directly inside AppShell, holding the header and the trays.'],
    whenNot: ['Nested: there is one column per page.'],
  },
  examples: [
    {
      title: 'Header and trays in the column',
      description:
        'The column is centered on the whole window, so the free space on the right equals the sidebar plus the free space on the left; it shrinks to keep that symmetry down to 60rem. The gutter is 32px, then 24px under 64rem and 16px under 40rem.',
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
          crumbsLabel="Breadcrumb (example 2)"
          identity={
            <Identity
              logo="slack"
              title="Slack"
              status={
                <Badge tone="ok" glyph="✓">
                  Active
                </Badge>
              }
              type="Slack Web API"
              slug="slack"
              entityId={{ value: 'svc_01JB8Y2K4M6P8R0T2V4X6Z8A1C', kind: 'Token' }}
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
      logo="slack"
      title="Slack"
      status={<Badge tone="ok" glyph="✓">Active</Badge>}
      type="Slack Web API"
      slug="slack"
      entityId={{ value: 'svc_01JB8Y2K4M6P8R0T2V4X6Z8A1C', kind: 'Token' }}
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
          crumbsLabel="Breadcrumb (example 3)"
          identity={
            <Identity
              logoSlot={<Avatar name="Sam Ito" size="lg" variant="pending" />}
              title="Sam Ito"
              status={
                <Badge tone="info" glyph="◐">
                  Pending approval
                </Badge>
              }
              type="sam@acme.dev"
              entityId={{ value: 'usr_01JB9C4R7T2V5X8Z1B3D6F9H2K', kind: 'User' }}
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
      logoSlot={<Avatar name="Sam Ito" size="lg" variant="pending" />}
      title="Sam Ito"
      status={<Badge tone="info" glyph="◐">Pending approval</Badge>}
      type="sam@acme.dev"
      entityId={{ value: 'usr_01JB9C4R7T2V5X8Z1B3D6F9H2K', kind: 'User' }}
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
          crumbsLabel="Breadcrumb (example 4)"
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
    {
      title: 'A one-line form in the actions',
      description:
        'A FieldInline (“Find a request”) keeps its 40px box in the actions; other forms there (an ActionForm) dissolve so their button lines up with the others. Full width below 40rem.',
      layout: 'frame',
      render: () => (
        <PageHeader
          title="Requests"
          description="Every call through tokengate in the last 30 days."
          actions={
            <FieldInline
              id="ex-ph-find"
              label="Request ID"
              name="id"
              placeholder="req_…"
              submit="Find"
              formLabel="Find a request (example)"
              action="#"
            />
          }
        />
      ),
      code: `<PageHeader
  title="Requests"
  description="Every call through tokengate in the last 30 days."
  actions={
    <FieldInline
      id="find"
      label="Request ID"
      name="id"
      placeholder="req_…"
      submit="Find"
      formLabel="Find a request"
      action="/admin/requests/find"
    />
  }
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
        {
          name: 'crumbsLabel',
          type: 'string',
          default: "'Breadcrumb'",
          description: 'Name of the breadcrumb landmark, for a second trail on the page.',
        },
        {
          name: 'actions',
          type: 'Child',
          description:
            'Buttons; at most one primary, last. A FieldInline keeps its box; other forms dissolve (display: contents).',
        },
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
        {
          name: 'label',
          type: 'string',
          default: "'Breadcrumb'",
          description: 'Name of the nav landmark; give a second trail on the page its own.',
        },
        { name: 'class', type: 'string', description: 'Extra classes on the nav.' },
      ],
    },
    {
      component: 'Identity',
      props: [
        { name: 'title', type: 'Child', required: true, description: 'The object name: the H1.' },
        { name: 'logo', type: 'LogoSpec', description: 'Brand tile (40px), decorative.' },
        {
          name: 'logoSlot',
          type: 'Child',
          description:
            'A custom decorative node instead of logo: an Avatar size="lg" for a person.',
        },
        { name: 'status', type: 'Child', description: 'Status badge inside the H1.' },
        {
          name: 'type',
          type: 'Child',
          description: 'Type or description, first in the meta line.',
        },
        { name: 'slug', type: 'string', description: 'Mono slug.' },
        {
          name: 'entityId',
          type: '{ value: string; kind: string }',
          description:
            'Full ID in an IdChip; kind ("Token") makes its tooltip and screen reader name "Token ID".',
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
    'Keep the actions at the top right: the identity takes the rest of the row, and its meta line wraps instead of pushing the buttons down.',
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
      title: 'Deeper page: a request under All',
      description:
        'On a page below a view (a request opened from the All outcome), the tab of that view has current: ‘true’ (aria-current="true"). It looks like the current tab.',
      layout: 'stack',
      render: () => (
        <Tabs
          label="Outcome (deeper page example)"
          items={[
            { label: 'All', href: '#', current: 'true' },
            { label: 'Allowed', href: '#' },
            { label: 'Denied', href: '#' },
            { label: 'Errors', href: '#' },
          ]}
        />
      ),
      code: `<Tabs label="Outcome" items={[
  { label: 'All', href: '/admin/requests', current: 'true' },
  { label: 'Allowed', href: '/admin/requests?outcome=allowed' },
  { label: 'Denied', href: '/admin/requests?outcome=denied' },
  { label: 'Errors', href: '/admin/requests?outcome=error' },
]} />`,
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
          type: "readonly { label: Child; href: string; count?: number | string; current?: boolean | 'page' | 'true' }[]",
          required: true,
          description:
            "The tabs; mark exactly one current: true or 'page' for the current view, 'true' when a deeper page of it is shown.",
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
    'Each tab and segment is a link to a page; the current one has aria-current="page", or aria-current="true" on a deeper page of that view. No ARIA tab roles: they would need scripted arrow keys.',
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
        <Tray id="ex-tray-3" title="Allowed hosts" headingLevel={3} count={2}>
          <Panel variant="flush">
            <p class="oneline">slack.com, files.slack.com</p>
          </Panel>
        </Tray>
      ),
      code: `<Tray id="hosts" title="Allowed hosts" headingLevel={3} count={2}>
  <Panel variant="flush">…table…</Panel>
</Tray>`,
    },
    {
      title: 'Hidden title, nothing beside it: a tray that only wraps a Disclosure',
      description:
        'With hideTitle and neither bar nor actions there is no title row: the screen-reader heading opens the section and the panel starts at the top of the tray.',
      layout: 'stack',
      render: () => (
        <Tray id="ex-tray-4" title="Advanced trust settings" hideTitle>
          <Panel variant="pad">
            <Disclosure summary="Advanced trust settings" hint="issuer, audience, algorithms">
              <p class="hint">Defaults fit GitHub Actions.</p>
            </Disclosure>
          </Panel>
        </Tray>
      ),
      code: `<Tray id="advanced" title="Advanced trust settings" hideTitle>
  <Panel variant="pad">
    <Disclosure summary="Advanced trust settings" hint="issuer, audience, algorithms">…</Disclosure>
  </Panel>
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
            'Keeps the title for screen readers only, so the title row holds just the bar and actions. With neither, there is no title row.',
        },
        { name: 'actions', type: 'Child', description: 'Right side of the title row.' },
        { name: 'footer', type: 'Child', description: 'Footer facts.' },
        {
          name: 'headingLevel',
          type: '2 | 3 | 4',
          default: '2',
          description:
            'Level of the title (3 under another h2). Headings inside the tray follow one level deeper.',
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
    'The warn bar is decorative: say why in the content.',
  ],
  do: ['Give every tray a unique id.', 'Stack panels in a tray; they get 4px between them.'],
  dont: [
    'Do not put a tray inside a panel.',
    'Do not skip heading levels: use headingLevel={3} under an h2.',
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
    {
      title: 'With a description',
      description: 'One line under the title says what the zone is about, on a person page.',
      layout: 'stack',
      render: () => (
        <DangerZone id="ex-dz-2" headingLevel={3} description="Stop Tom from using the console.">
          <DangerRow
            title="Disable Tom Weber"
            description="Tom cannot sign in until you enable him again. His audit entries stay."
            action={
              <form method="post" action="#">
                <button class="btn secondary" type="submit">
                  Disable Tom
                </button>
              </form>
            }
          />
        </DangerZone>
      ),
      code: `<DangerZone id="danger" headingLevel={3} description="Stop Tom from using the console.">
  <DangerRow
    title="Disable Tom Weber"
    description="Tom cannot sign in until you enable him again. His audit entries stay."
    action={<ActionForm action="/admin/users/usr_…/disable" hidden={{ _csrf }}>Disable Tom</ActionForm>}
  />
</DangerZone>`,
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
        {
          name: 'description',
          type: 'Child',
          description: 'One line under the title (the tray description).',
        },
        {
          name: 'headingLevel',
          type: '2 | 3 | 4',
          default: '2',
          description: 'Level of the tray title; the rows follow one level deeper.',
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
          description: 'What the action does, with the object (a heading).',
        },
        { name: 'description', type: 'Child', description: 'The consequence in one sentence.' },
        {
          name: 'action',
          type: 'Child',
          required: true,
          description:
            'An ActionForm (reversible) or a danger DialogTrigger whose label ends with “…”.',
        },
        {
          name: 'headingLevel',
          type: '2 | 3 | 4',
          default: '3',
          description: 'Level of the row title; its DangerZone sets it one under the tray title.',
        },
        { name: 'class', type: 'string', description: 'Extra classes on .dz-row.' },
      ],
    },
  ],
  accessibility: [
    'A named region (its h2); each row is an h3, so the actions are reachable by heading.',
    'Button labels name the object (“Disable Slack”, “Delete Slack…”), so they make sense out of context.',
  ],
  do: [
    'Put the reversible action first.',
    'Say what is kept and what is lost.',
    'Keep the action beside its text: the row wraps the action under the text only when the text column would be narrower than 14rem.',
  ],
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
            hidden={{ with_accesses: '1' }}
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
  hidden={{ _csrf: csrf, with_accesses: '1' }}
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
    {
      title: 'Approve as Owner… (submits the approve form)',
      description:
        'With form, the dialog has no form of its own: its confirm button submits the approve form on the page (form="…", name="role", value="owner"), so the fields of that form are sent and nothing nests. The dialog sits after the form here; inside it, it must come after the form’s default button.',
      render: () => (
        <>
          <form id="ex-dlg-approve" method="post" action="#">
            <input type="hidden" name="user" value="usr_01JB9C4R7T2V5X8Z1B3D6F9H2K" />
            <button class="btn secondary" type="submit" name="role" value="viewer">
              Approve as Viewer
            </button>{' '}
            <DialogTrigger dialog="ex-dlg-4">Approve as Owner…</DialogTrigger>
          </form>
          <ConfirmDialog
            id="ex-dlg-4"
            form="ex-dlg-approve"
            name="role"
            value="owner"
            title="Approve Sam Ito as Owner?"
            description="Owners can change sign-in and remove other owners."
            confirmLabel="Approve as Owner"
            confirmVariant="primary"
            consequences={[
              'Sam can change who signs in and how.',
              'Sam can give and remove every role, Owner included.',
            ]}
          />
        </>
      ),
      code: `<form id="approve" method="post" action="/admin/users/usr_…/approve">
  <input type="hidden" name="_csrf" value={csrf} />
  <Button type="submit" name="role" value="viewer">Approve as Viewer</Button>
  <DialogTrigger dialog="dlg-owner">Approve as Owner…</DialogTrigger>
</form>
<ConfirmDialog
  id="dlg-owner"
  form="approve"
  name="role"
  value="owner"
  title="Approve Sam Ito as Owner?"
  description="Owners can change sign-in and remove other owners."
  confirmLabel="Approve as Owner"
  confirmVariant="primary"
  consequences={['Sam can change who signs in and how.', 'Sam can give and remove every role, Owner included.']}
/>`,
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
        { name: 'title', type: 'Child', required: true, description: 'The question or task.' },
        {
          name: 'description',
          type: 'Child',
          description: 'Under the title; the dialog’s description.',
        },
        { name: 'action', type: 'string', description: 'Form target. Default: the current URL.' },
        { name: 'method', type: "'post' | 'get'", default: "'post'", description: 'Form method.' },
        {
          name: 'hidden',
          type: 'HiddenFields',
          description: 'Hidden fields at the top of the form (_csrf, ids).',
        },
        {
          name: 'form',
          type: 'string',
          description:
            'Id of an outer form the footer buttons submit (form="…"). The dialog then renders no form (div.dlg-in) and takes no action, method or hidden.',
        },
        {
          name: 'headingLevel',
          type: '2 | 3 | 4',
          default: '2',
          description: 'Level of the title: 2 in a modal; 3 for an open dialog under an h2.',
        },
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
          description:
            'Where the confirm button posts (the dialog’s own form). Pass action or form.',
        },
        {
          name: 'form',
          type: 'string',
          description:
            'Id of an outer form the confirm button submits instead (see Dialog form). The type-to-confirm field joins it too.',
        },
        {
          name: 'name / value',
          type: 'string',
          default: "'confirm' / '1'",
          description: 'With form: the name and value of the confirm submit.',
        },
        {
          name: 'formnovalidate',
          type: 'boolean',
          description: 'With form: the confirm submit skips the outer form’s browser validation.',
        },
        {
          name: 'confirmLabel',
          type: 'string',
          required: true,
          description: 'The outcome, without “…” (“Delete Slack”).',
        },
        {
          name: 'confirmVariant',
          type: "'danger-solid' | 'primary'",
          default: "'danger-solid'",
          description:
            'Button variant of the confirm: solid danger, or primary when nothing is destroyed.',
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
        {
          name: 'hidden',
          type: 'HiddenFields',
          description: 'Hidden fields of its own form (_csrf, ids). Not with form.',
        },
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
        {
          name: 'wide / class / headingLevel',
          type: 'boolean / string / 2 | 3 | 4',
          description: 'As in Dialog.',
        },
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
          type: 'ButtonVariant',
          default: "'secondary'",
          description: 'Button style; danger always opens a confirm dialog.',
        },
        {
          name: 'size / block / disabled / plus / icon / id / describedBy',
          type: 'as Button',
          description:
            'Every Button prop, except the ones the trigger sets (type, href, command…).',
        },
        {
          name: 'srSuffix',
          type: 'string',
          description:
            'Hidden suffix naming the row object of a row trigger ("Delete…" + "acme/api"). The space is added.',
        },
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
        {
          name: 'autofocus',
          type: 'boolean',
          description: 'Focus it when the dialog opens: the safe start of a destructive confirm.',
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
    'Focus starts in the type-to-confirm field, or on Cancel, never on the confirm button. With form (the confirm submits a form outside the dialog) Cancel keeps the autofocus too.',
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
  classes: [
    'dlg',
    'wide',
    'dlg-in',
    'dlg-h',
    'dlg-b',
    'dlg-f',
    'conseq',
    'dlg-list',
    'danger-solid',
  ],
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

const grid: ComponentDoc = {
  slug: 'grid',
  name: 'Grid',
  related: ['Column', 'Stack'],
  summary:
    'The 12-column page grid (24px gaps) for main content next to a side column, such as the Overview (8 + 4), and the vertical stacks between blocks.',
  usage: {
    when: [
      'An overview page: Needs attention and the pipeline in 8 columns, a rail of small trays in 4.',
      'A Stack: blocks 32px apart outside a Page (in a column), or fields and notes 16px apart inside a panel or form.',
    ],
    whenNot: [
      'A detail page (main column + 20rem rail): DetailLayout.',
      'A form next to its live summary: LiveForm.',
    ],
  },
  examples: [
    {
      title: 'Main 8 + rail 4',
      description:
        'From 80rem the columns sit side by side; below, every column takes the whole row, the rail under the main column.',
      layout: 'stack',
      render: () => (
        <Grid>
          <Column span={8}>
            <Tray id="gr-ex-main" title="Needs attention" count={2}>
              <Panel variant="pad">
                <p>Main column: 8 of 12 columns.</p>
              </Panel>
            </Tray>
          </Column>
          <Column span={4} rail as="aside" label="Install status">
            <Tray id="gr-ex-rail" title="Traffic">
              <Panel variant="pad">
                <p class="muted">Rail: 4 of 12 columns, trays 24px apart.</p>
              </Panel>
            </Tray>
          </Column>
        </Grid>
      ),
      code: `<Grid>
  <Column span={8}>
    <Tray id="attention" title="Needs attention" count={2}>…</Tray>
  </Column>
  <Column span={4} rail as="aside" label="Install status">
    <Tray id="traffic" title="Traffic">…</Tray>
  </Column>
</Grid>`,
    },
    {
      title: 'Stacks',
      description: 'gap="sm" puts 16px between blocks, the default 32px.',
      layout: 'stack',
      render: () => (
        <Stack gap="sm">
          <Panel variant="pad">
            <p>First block</p>
          </Panel>
          <Panel variant="pad">
            <p>Second block, 16px under it</p>
          </Panel>
        </Stack>
      ),
      code: `<Stack gap="sm">
  <Panel variant="pad">…</Panel>
  <Panel variant="pad">…</Panel>
</Stack>`,
    },
  ],
  props: [
    {
      component: 'Grid',
      props: [
        { name: 'class', type: 'string', description: 'Extra classes on .grid.' },
        {
          name: 'children',
          type: 'Child',
          required: true,
          description: 'Columns whose spans add up to 12 per row.',
        },
      ],
    },
    {
      component: 'Column',
      props: [
        {
          name: 'span',
          type: '4 | 5 | 6 | 7 | 8 | 12',
          required: true,
          description: 'Columns of 12 it spans from 80rem (.span-N); the whole row below.',
        },
        {
          name: 'rail',
          type: 'boolean',
          description: 'A side column (.rail): its trays sit 24px apart.',
        },
        {
          name: 'as',
          type: "'div' | 'section' | 'aside'",
          default: "'div'",
          description: 'The element. An aside is a complementary landmark: give it a label.',
        },
        { name: 'label', type: 'string', description: 'Accessible name of an aside or section.' },
        { name: 'class', type: 'string', description: 'Extra classes.' },
        { name: 'children', type: 'Child', required: true, description: 'Trays.' },
      ],
    },
    {
      component: 'Stack',
      props: [
        {
          name: 'gap',
          type: "'md' | 'sm'",
          default: "'md'",
          description: 'md: 32px (.stack), sm: 16px (.stack-sm).',
        },
        { name: 'class', type: 'string', description: 'Extra classes.' },
        { name: 'children', type: 'Child', required: true, description: 'The blocks.' },
      ],
    },
  ],
  accessibility: [
    'The visual order is the source order: the rail comes after the main column for screen readers and below it on narrow screens.',
    'A rail as an aside is a complementary landmark; name it with label.',
  ],
  do: ['Put the most important content in the wider, first column.'],
  dont: [
    'Do not nest grids.',
    'Do not reorder columns with CSS: the reading order must match what is seen.',
  ],
  classes: [
    'grid',
    'span-8',
    'span-4',
    'span-7',
    'span-5',
    'span-6',
    'span-12',
    'rail',
    'stack',
    'stack-sm',
  ],
};

export const layout: readonly ComponentDoc[] = [
  appShell,
  page,
  pageHeader,
  tabs,
  tray,
  detailLayout,
  grid,
  dangerZone,
  dialog,
  menu,
  disclosure,
];
