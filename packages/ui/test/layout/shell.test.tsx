import { describe, expect, it } from 'vitest';
import { AccountMenu, AppShell, HealthLine, HealthStrip, MenuItem, SideNav } from '../../src';
import { render } from '../render';

const sections = [
  { label: 'Monitoring', href: '/admin', current: true },
  {
    label: 'Credentials',
    href: '/admin/credentials',
    count: 6,
    open: true,
    items: [
      { label: 'Credentials', href: '/admin/credentials', current: true },
      { label: 'Allowed hosts', href: '/admin/credentials/hosts' },
    ],
  },
  { label: 'Users', href: '/admin/users', pill: { label: '1 pending', srSuffix: ': decide' } },
];

describe('SideNav', () => {
  const html = render(<SideNav label="Sections" sections={sections} />);

  it('marks the current page and shows only the open section items', () => {
    expect(html).toContain('<a class="nav-item" href="/admin" aria-current="page">');
    expect(html).toContain('<a class="nav-item is-open" href="/admin/credentials">');
    expect(html).toContain(
      '<li><a href="/admin/credentials" aria-current="page">Credentials</a></li>',
    );
    expect(html.match(/<ul class="nav-sub">/g)).toHaveLength(1);
  });

  it('marks an ancestor of a deeper page with aria-current="true"', () => {
    const deeper = render(
      <SideNav
        label="Sections"
        sections={[
          { label: 'Monitoring', href: '/admin', current: 'true' },
          {
            label: 'Credentials',
            href: '/admin/credentials',
            open: true,
            items: [
              { label: 'Credentials', href: '/admin/credentials', current: 'true' },
              { label: 'Keys', href: '/admin/credentials/keys', current: 'page' },
              { label: 'Hosts', href: '/admin/credentials/hosts', current: false },
            ],
          },
        ]}
      />,
    );
    expect(deeper).toContain('<a class="nav-item" href="/admin" aria-current="true">');
    expect(deeper).toContain(
      '<li><a href="/admin/credentials" aria-current="true">Credentials</a></li>',
    );
    expect(deeper).toContain(
      '<li><a href="/admin/credentials/keys" aria-current="page">Keys</a></li>',
    );
    expect(deeper).toContain('<li><a href="/admin/credentials/hosts">Hosts</a></li>');
  });

  it('renders counts and the pill with its screen reader text', () => {
    expect(html).toContain('<span class="nav-count">6</span>');
    expect(html).toContain(
      '<span class="nav-pill">1 pending<span class="vh">: decide</span></span>',
    );
  });

  it('puts item counts on their own rows in grouped navigation', () => {
    const grouped = render(
      <SideNav
        label="Sections"
        grouped
        sections={[
          {
            label: 'Credentials',
            href: '/admin/credentials',
            items: [
              { label: 'Credentials', href: '/admin/credentials', count: 6 },
              { label: 'Allowed hosts', href: '/admin/credentials/hosts' },
              { label: 'Access Rules', href: '/admin/credential-access-rules', count: 3 },
            ],
          },
        ]}
      />,
    );
    expect(grouped).toContain(
      '<a class="nav-item" href="/admin/credentials"><span class="nav-text">Credentials</span><span class="nav-count">6</span></a>',
    );
    expect(grouped).toContain(
      '<a class="nav-item" href="/admin/credentials/hosts"><span class="nav-text">Allowed hosts</span></a>',
    );
    expect(grouped).toContain(
      '<span class="nav-text">Access Rules</span><span class="nav-count">3</span>',
    );
  });

  it('puts the attention dot after the label, with its meaning for screen readers', () => {
    const attention = { tone: 'info' as const, srSuffix: ': 1 note' };
    const grouped = render(
      <SideNav
        label="Sections"
        grouped
        sections={[
          {
            label: 'Settings',
            href: '/admin/users',
            pill: { label: '1 pending' },
            items: [{ label: 'People', href: '/admin/users', attention }],
          },
        ]}
      />,
    );
    expect(grouped).toContain(
      '<span class="nav-text">People</span><span class="dot nav-dot info" aria-hidden="true"></span><span class="vh">: 1 note</span><span class="nav-pill">1 pending</span>',
    );
    const flat = render(
      <SideNav
        label="Sections"
        sections={[
          {
            label: 'Settings',
            href: '/admin/users',
            open: true,
            items: [{ label: 'People', href: '/admin/users', attention }],
          },
        ]}
      />,
    );
    expect(flat).toContain(
      '<a href="/admin/users">People<span class="dot nav-dot info" aria-hidden="true"></span><span class="vh">: 1 note</span></a>',
    );
  });
});

describe('AppShell', () => {
  it('replaces the built-in mark with an image', () => {
    const html = render(<AppShell brand={{ name: 'Acme', href: '/', image: '/logo.png' }} />);
    expect(html).toContain('<img src="/logo.png" alt="" width="32" height="32"/>');
    expect(html).not.toContain('M12 3l7 3');
  });

  it('supports a custom title and icon', () => {
    const html = render(
      <AppShell brand={{ name: 'Acme <Gateway>', href: '/admin', icon: 'home' }} />,
    );
    expect(html).toContain('Acme &lt;Gateway&gt;');
    expect(html).toContain('M4 11l8-7 8 7');
    expect(html).not.toContain('M12 3l7 3');
  });

  it('links the skip link to main', () => {
    const html = render(
      <AppShell brand={{ name: 'tokengate', href: '/admin' }} nav="nav" mainId="m">
        body
      </AppShell>,
    );
    expect(html).toContain('<a class="skip-link" href="#m">Skip to content</a>');
    expect(html).toContain('<main class="main" id="m" tabindex="-1">body</main>');
    expect(html).toContain(
      '<details class="navd"><summary>Menu<span class="chev" aria-hidden="true">▾</span></summary>',
    );
    // the instance mark is the gate icon of the set, not a second drawing of it
    expect(html).toContain(
      '<span class="mark" aria-hidden="true"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z"></path>',
    );
  });

  it('drops the landmarks when drawn inside another page', () => {
    const html = render(
      <AppShell brand={{ name: 't', href: '/' }} nav="n" landmarks={false}>
        x
      </AppShell>,
    );
    expect(html).not.toContain('<main');
    expect(html).not.toContain('skip-link');
    expect(html).toContain('<div class="main" id="main">x</div>');
  });

  it('leaves out the Menu disclosure with neither nav nor account (pre-login)', () => {
    const html = render(
      <AppShell brand={{ name: 'tokengate', href: '/admin' }} health={<a class="health">h</a>}>
        x
      </AppShell>,
    );
    expect(html).not.toContain('navd');
    expect(html).toContain('<a class="health">h</a></div></div><main class="main" id="main"');
    expect(html).toContain('<main class="main" id="main" tabindex="-1">x</main>');
  });

  it.each([
    ['nav', { nav: 'n' }],
    ['account', { account: 'a' }],
  ])('keeps the Menu disclosure with only %s', (_, slots) => {
    const html = render(<AppShell brand={{ name: 't', href: '/' }} {...slots} />);
    expect(html).toContain('<details class="navd">');
  });

  it('treats null and false slots as absent', () => {
    const html = render(<AppShell brand={{ name: 't', href: '/' }} nav={null} account={false} />);
    expect(html).not.toContain('navd');
  });
});

describe('AppShell slots', () => {
  const html = render(
    <AppShell
      brand={{ name: 'tokengate', href: '/admin', host: 'gate.acme.dev' }}
      nav="nav"
      class="x"
      health={
        <HealthLine
          href="/admin#ov-attention"
          tone="warn"
          srSuffix=". Open Overview, Needs attention"
        >
          3 warnings to review
        </HealthLine>
      }
      account={
        <AccountMenu id="acct" name="Maya Chen" role="Owner" initials="MC">
          <MenuItem href="/docs">Docs</MenuItem>
        </AccountMenu>
      }
      banner={<HealthStrip title="Keyring unavailable.">Every call fails.</HealthStrip>}
    >
      body
    </AppShell>,
  );

  it('places brand, health, nav and account in the sidebar, banner first in main', () => {
    expect(html).toMatch(/^<div class="app x">/);
    expect(html).toContain('<span class="inst-host">gate.acme.dev</span>');
    expect(html.indexOf('class="health"')).toBeLessThan(html.indexOf('class="navd"'));
    expect(html.indexOf('nav</')).toBeLessThan(html.indexOf('class="acct"'));
    expect(html).toContain(
      '<main class="main" id="main" tabindex="-1"><p class="hstrip" role="alert">',
    );
    expect(html).toContain('</p>body</main>');
  });

  it('does not double-wrap the account block', () => {
    expect(html.match(/class="acct"/g)).toHaveLength(1);
  });

  it('omits the host line when there is none', () => {
    expect(render(<AppShell brand={{ name: 't', href: '/' }} nav="n" />)).not.toContain(
      'inst-host',
    );
  });
});

describe('HealthLine', () => {
  it('renders a hidden dot, the summary and the screen reader rest of the name', () => {
    expect(
      render(
        <HealthLine href="/admin#ov-attention" tone="warn" srSuffix=". Open Overview">
          3 warnings to review
        </HealthLine>,
      ),
    ).toBe(
      '<a class="health" href="/admin#ov-attention"><span class="dot warn" aria-hidden="true"></span>3 warnings to review<span class="vh">. Open Overview</span></a>',
    );
  });

  it('uses the plain green dot for ok and passes classes through', () => {
    const html = render(
      <HealthLine href="/admin#ov-health" class="y">
        Healthy · 1 note
      </HealthLine>,
    );
    expect(html).toContain(
      '<a class="health y" href="/admin#ov-health"><span class="dot" aria-hidden="true">',
    );
    expect(html).not.toContain('class="vh"');
  });

  it.each(['bad', 'info'] as const)('tone %s colors the dot', (tone) => {
    expect(
      render(
        <HealthLine href="#" tone={tone}>
          x
        </HealthLine>,
      ),
    ).toContain(`class="dot ${tone}"`);
  });
});

describe('HealthStrip', () => {
  it('is an alert with the glyph hidden and the action last', () => {
    expect(
      render(
        <HealthStrip title="Keyring unavailable." action={<a href="/k">Fix encryption keys</a>}>
          Every call fails.
        </HealthStrip>,
      ),
    ).toBe(
      '<p class="hstrip" role="alert"><b><span aria-hidden="true">✕</span> Keyring unavailable.</b> Every call fails. <a href="/k">Fix encryption keys</a></p>',
    );
  });

  it('takes another glyph and extra classes', () => {
    const html = render(<HealthStrip title="T" glyph="⚠" class="z" />);
    expect(html).toBe(
      '<p class="hstrip z" role="alert"><b><span aria-hidden="true">⚠</span> T</b></p>',
    );
  });

  it('leaves out the role with role={null} and reads the prefix after the glyph', () => {
    expect(
      render(
        <HealthStrip title="Keyring unavailable." role={null} srPrefix="Error:">
          Every call fails.
        </HealthStrip>,
      ),
    ).toBe(
      '<p class="hstrip"><b><span aria-hidden="true">✕</span> <span class="vh">Error: </span>Keyring unavailable.</b> Every call fails.</p>',
    );
  });

  it('keeps the alert role when set explicitly and ignores a blank prefix', () => {
    expect(render(<HealthStrip title="T" role="alert" srPrefix=" " />)).toBe(
      '<p class="hstrip" role="alert"><b><span aria-hidden="true">✕</span> T</b></p>',
    );
  });
});

describe('AccountMenu', () => {
  const html = render(
    <AccountMenu id="acct-1" name="Maya <Chen>" role="Owner" initials="MC" class="k">
      <MenuItem href="/admin/export">Export configuration</MenuItem>
    </AccountMenu>,
  );

  it('opens its popover menu from the button', () => {
    expect(html).toMatch(
      /^<div class="acct k"><button class="acct-btn" type="button" popovertarget="acct-1">/,
    );
    expect(html).toContain('<div class="menu" id="acct-1" popover="auto">');
  });

  it('hides the avatar and chevron, names the button with the person and "account menu"', () => {
    expect(html).toContain('<span class="avatar md" aria-hidden="true">MC</span>');
    expect(html).toContain('<span class="chev" aria-hidden="true">▾</span>');
    expect(html).toContain('<span class="vh">, account menu</span>');
    expect(html).toContain('<small>Owner</small>');
  });

  it('escapes the name', () => {
    expect(html).toContain('<b>Maya &lt;Chen&gt;</b>');
  });
});

describe('AccountMenu initials', () => {
  it('takes the initials from the name, like Avatar', () => {
    const html = render(
      <AccountMenu id="a" name="Diego Ruiz" role="Admin">
        x
      </AccountMenu>,
    );
    expect(html).toContain('<span class="avatar md" aria-hidden="true">DR</span>');
  });
});
