import { describe, expect, it } from 'vitest';
import { Chip, Chips } from '../../src';
import { render } from '../render';

describe('Chip', () => {
  it('links a logo chip with a count and a hidden srSuffix', () => {
    expect(
      render(
        <Chip
          href="/admin/access?token=slack"
          logo="slack"
          count={2}
          srSuffix=": 2 accesses. Open."
        >
          Slack
        </Chip>,
      ),
    ).toBe(
      '<a class="chip" href="/admin/access?token=slack"><span class="logo xs lg-slack" aria-hidden="true">S</span>Slack <span class="n">2</span><span class="vh">: 2 accesses. Open.</span></a>',
    );
  });

  it('tints only the glyph of an expiring relation', () => {
    expect(
      render(
        <Chip href="#" logo="openai" count={1} glyph="⌛" glyphTone="warn">
          OpenAI
        </Chip>,
      ),
    ).toContain('<span class="g t-warn" aria-hidden="true">⌛</span>');
  });

  it.each(['warn', 'bad'] as const)('renders the %s tone', (tone) => {
    expect(
      render(
        <Chip logo="anthropic" tone={tone} glyph="✕">
          Anthropic
        </Chip>,
      ),
    ).toMatch(new RegExp(`^<span class="chip ${tone}">`));
  });

  it('dims the logo of an inactive chip', () => {
    const html = render(
      <Chip href="#" logo="slack" tone="off" glyph="⚠">
        Slack (legacy)
      </Chip>,
    );
    expect(html).toMatch(/^<a class="chip off" href="#">/);
    expect(html).toContain('<span class="logo xs lg-slack dis" aria-hidden="true">S</span>');
  });

  it('is a text chip without a logo and a span without href', () => {
    expect(render(<Chip class="x">acme/api · env production</Chip>)).toBe(
      '<span class="chip text x">acme/api · env production</span>',
    );
  });

  it('escapes the name', () => {
    expect(render(<Chip>{'<x>'}</Chip>)).toBe('<span class="chip text">&lt;x&gt;</span>');
  });
});

describe('Chips', () => {
  it('wraps chips and ends with the more link', () => {
    expect(
      render(
        <Chips more={{ href: '/admin/consumers/gha', label: '+1 more' }} class="x">
          <Chip>a</Chip>
        </Chips>,
      ),
    ).toBe(
      '<div class="chips x"><span class="chip text">a</span><a class="more-link" href="/admin/consumers/gha">+1 more</a></div>',
    );
  });
});
