import { describe, expect, it } from 'vitest';
import { LOGO_BRANDS, Logo, LogoStack, type LogoBrand } from '../../src';
import { render } from '../render';

describe('Logo', () => {
  it('is a decorative 32px tile with the brand letters', () => {
    expect(render(<Logo brand="slack" />)).toBe(
      '<span class="logo lg-slack" aria-hidden="true">S</span>',
    );
  });

  it.each(['xs', 'sm', 'lg'] as const)('renders the %s size class', (size) => {
    expect(render(<Logo brand="github" size={size} />)).toBe(
      `<span class="logo ${size} lg-github" aria-hidden="true">GH</span>`,
    );
  });

  it.each(Object.keys(LOGO_BRANDS) as LogoBrand[])('has a tile for %s', (brand) => {
    const html = render(<Logo brand={brand} />);
    expect(html).toContain(`class="logo lg-${brand}"`);
    expect(html).not.toContain('aria-hidden="true"></span>');
  });

  it('draws the key icon for OIDC and escapes the custom letters', () => {
    expect(render(<Logo brand="oidc" />)).toBe(
      '<span class="logo lg-oidc" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="8" cy="15" r="4"></circle><path d="M11 12l9-9M16 7l3 3"></path></svg></span>',
    );
    expect(render(<Logo brand="custom" />)).toBe(
      '<span class="logo lg-custom" aria-hidden="true">&lt;/&gt;</span>',
    );
  });

  it('dims a disabled tile, takes other letters and a label, and keeps classes', () => {
    expect(
      render(
        <Logo brand="custom" disabled label="Acme CRM" class="x">
          AC
        </Logo>,
      ),
    ).toBe('<span class="logo lg-custom dis x" role="img" aria-label="Acme CRM">AC</span>');
  });
});

describe('LogoStack', () => {
  it('hides the overlapping tiles and keeps the count text', () => {
    expect(
      render(
        <LogoStack brands={['github', 'gitlab']} class="x">
          2 consumers
        </LogoStack>,
      ),
    ).toBe(
      '<span class="lstack x"><span class="tiles" aria-hidden="true"><span class="logo sm lg-github" aria-hidden="true">GH</span><span class="logo sm lg-gitlab" aria-hidden="true">GL</span></span>2 consumers</span>',
    );
  });

  it('draws LogoSpec tiles: other letters and a disabled tile', () => {
    expect(
      render(
        <LogoStack
          brands={[
            { brand: 'custom', text: 'AC' },
            { brand: 'slack', disabled: true },
          ]}
        >
          2 tokens
        </LogoStack>,
      ),
    ).toBe(
      '<span class="lstack"><span class="tiles" aria-hidden="true"><span class="logo sm lg-custom" aria-hidden="true">AC</span><span class="logo sm lg-slack dis" aria-hidden="true">S</span></span>2 tokens</span>',
    );
  });

  it('is decorative without a count', () => {
    expect(render(<LogoStack brands={['github', 'gitlab']} />)).toBe(
      '<span class="lstack" aria-hidden="true"><span class="tiles"><span class="logo sm lg-github" aria-hidden="true">GH</span><span class="logo sm lg-gitlab" aria-hidden="true">GL</span></span></span>',
    );
  });
});

describe('Logo cssLetters', () => {
  it('moves the letters to data-l so the tile adds no text', () => {
    expect(render(<Logo brand="vercel" size="sm" cssLetters />)).toBe(
      '<span class="logo sm lg-vercel" data-l="▲" aria-hidden="true"></span>',
    );
  });
});
