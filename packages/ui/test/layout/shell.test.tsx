import { describe, expect, it } from 'vitest';
import { AppShell, SideNav } from '../../src';
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
