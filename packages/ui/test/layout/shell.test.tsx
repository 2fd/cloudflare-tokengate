import { describe, expect, it } from 'vitest';
import {
  AccountMenu,
  AppShell,
  HealthLine,
  HealthStrip,
  MenuItem,
  NavIcon,
  SideNav,
} from '../../src';
import { render } from '../render';

const sections = [
  { label: 'Monitoring', href: '/admin', current: true },
  {
    label: 'Service tokens',
    href: '/admin/tokens',
    count: 6,
    open: true,
    items: [
      { label: 'Tokens', href: '/admin/tokens', current: true },
      { label: 'Allowed hosts', href: '/admin/tokens/hosts' },
    ],
  },
  { label: 'Users', href: '/admin/users', pill: { label: '1 pending', srLabel: ': decide' } },
];

describe('SideNav', () => {
  const html = render(<SideNav label="Sections" sections={sections} />);

  it('marks the current page and shows only the open section items', () => {
    expect(html).toContain('<a class="nav-item" href="/admin" aria-current="page">');
    expect(html).toContain('<a class="nav-item is-open" href="/admin/tokens">');
    expect(html).toContain('<li><a href="/admin/tokens" aria-current="page">Tokens</a></li>');
    expect(html.match(/<ul class="nav-sub">/g)).toHaveLength(1);
  });

  it('renders counts and the pill with its screen reader text', () => {
    expect(html).toContain('<span class="nav-count">6</span>');
    expect(html).toContain(
      '<span class="nav-pill">1 pending<span class="vh">: decide</span></span>',
    );
  });
});

describe('AppShell', () => {
  it('links the skip link to main', () => {
    const html = render(
      <AppShell brand={{ name: 'tokengate', href: '/admin' }} nav="nav" mainId="m">
        body
      </AppShell>,
    );
    expect(html).toContain('<a class="skip-link" href="#m">Skip to content</a>');
    expect(html).toContain('<main class="main" id="m">body</main>');
    expect(html).toContain('<details class="navd"><summary>Menu</summary>');
  });

  it('drops the landmarks when drawn inside another page', () => {
    const html = render(
      <AppShell brand={{ name: 't', href: '/' }} nav="n" landmarks={false}>
        x
      </AppShell>,
    );
    expect(html).not.toContain('<main');
    expect(html).not.toContain('skip-link');
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
          srLabel=". Open Overview, Needs attention"
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
    expect(html).toContain('<main class="main" id="main"><p class="hstrip" role="alert">');
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
        <HealthLine href="/admin#ov-attention" tone="warn" srLabel=". Open Overview">
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

describe('NavIcon', () => {
  it.each(['monitoring', 'tokens', 'consumers', 'users'] as const)(
    '%s is a hidden svg.ic',
    (name) => {
      const html = render(<NavIcon name={name} />);
      expect(html).toMatch(
        /^<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><(path|circle|rect) /,
      );
    },
  );

  it('passes classes through', () => {
    expect(render(<NavIcon name="users" class="big" />)).toContain('class="ic big"');
  });
});
