import { describe, expect, it } from 'vitest';
import { AskSomeone, Button, Callout, Notice } from '../../src';
import { render } from '../render';

describe('Callout', () => {
  it('is an info callout with the i glyph by default', () => {
    expect(render(<Callout title="Only one active owner.">Invite a second owner.</Callout>)).toBe(
      '<div class="callout"><span class="gl" aria-hidden="true">i</span><div class="body"><p><b>Only one active owner.</b> Invite a second owner.</p></div></div>',
    );
  });

  it.each([
    ['ok', '✓'],
    ['warn', '⚠'],
    ['bad', '✕'],
  ] as const)('renders the %s tone with its glyph', (tone, glyph) => {
    expect(render(<Callout tone={tone} title="t" />)).toBe(
      `<div class="callout ${tone}"><span class="gl" aria-hidden="true">${glyph}</span><div class="body"><p><b>t</b></p></div></div>`,
    );
  });

  it('renders a glyph override, the second line and the actions', () => {
    const html = render(
      <Callout
        tone="warn"
        glyph="⌛"
        title="The secret of OpenAI expires on 21 Oct 2026."
        more="Its 1 consumer access stops working then."
        actions={<Button size="sm">Replace secret</Button>}
        class="x"
      />,
    );
    expect(html).toBe(
      '<div class="callout warn x"><span class="gl" aria-hidden="true">⌛</span><div class="body"><p><b>The secret of OpenAI expires on 21 Oct 2026.</b></p><p class="more">Its 1 consumer access stops working then.</p></div><div class="acts"><button class="btn sm secondary" type="button">Replace secret</button></div></div>',
    );
  });

  it('is focusable only with autofocus', () => {
    expect(render(<Callout title="t" autofocus />)).toMatch(
      /^<div class="callout" tabindex="-1" autofocus="">/,
    );
    expect(render(<Callout title="t" />)).not.toContain('tabindex');
  });

  it('never renders role=alert and escapes text', () => {
    const html = render(<Callout title="<b>">{'<i>'}</Callout>);
    expect(html).not.toContain('role=');
    expect(html).toContain('<b>&lt;b&gt;</b> &lt;i&gt;');
  });
});

describe('Notice', () => {
  it('is an ok callout with role=status', () => {
    expect(render(<Notice title="Access given." class="x" />)).toBe(
      '<div class="callout ok notice x" role="status"><span class="gl" aria-hidden="true">✓</span><div class="body"><p><b>Access given.</b></p></div></div>',
    );
  });

  it('takes focus after a redirect with autofocus', () => {
    expect(render(<Notice title="Access given." autofocus />)).toBe(
      '<div class="callout ok notice" role="status" tabindex="-1" autofocus=""><span class="gl" aria-hidden="true">✓</span><div class="body"><p><b>Access given.</b></p></div></div>',
    );
  });

  it('does not change the markup without autofocus', () => {
    const html = render(<Notice title="Access given." autofocus={false} />);
    expect(html).toMatch(/^<div class="callout ok notice" role="status">/);
    expect(html).not.toContain('tabindex');
    expect(html).not.toContain('autofocus');
  });

  it('keeps another tone', () => {
    expect(render(<Notice tone="info" title="Saved." />)).toMatch(
      /^<div class="callout notice" role="status">/,
    );
  });
});

describe('AskSomeone', () => {
  it('names one person', () => {
    expect(render(<AskSomeone people={['Maya Chen']}>Only owners can do this.</AskSomeone>)).toBe(
      '<p class="ask">Only owners can do this. Ask <b>Maya Chen</b>.</p>',
    );
  });

  it('joins names with commas and "or" and adds the link', () => {
    expect(
      render(
        <AskSomeone
          people={['Priya Natarajan', 'Diego Ruiz', 'Maya Chen']}
          link={{ href: 'mailto:priya@acme.dev', label: 'Email them this page' }}
          class="x"
        >
          Only token managers can add tokens.
        </AskSomeone>,
      ),
    ).toBe(
      '<p class="ask x">Only token managers can add tokens. Ask <b>Priya Natarajan</b>, <b>Diego Ruiz</b> or <b>Maya Chen</b>. <a href="mailto:priya@acme.dev">Email them this page</a></p>',
    );
  });

  it('counts the people it does not name', () => {
    expect(
      render(
        <AskSomeone
          people={['A', 'B', 'C']}
          more={2}
          link={{ href: 'mailto:a@acme.dev', label: 'Email them this page' }}
        >
          Only owners can do this.
        </AskSomeone>,
      ),
    ).toBe(
      '<p class="ask">Only owners can do this. Ask <b>A</b>, <b>B</b> or <b>C</b> and 2 more. <a href="mailto:a@acme.dev">Email them this page</a></p>',
    );
  });

  it('ignores more without people and when it is 0', () => {
    expect(
      render(
        <AskSomeone people={[]} more={3}>
          Only owners can do this.
        </AskSomeone>,
      ),
    ).toBe('<p class="ask">Only owners can do this.</p>');
    expect(
      render(
        <AskSomeone people={['A']} more={0}>
          x
        </AskSomeone>,
      ),
    ).toBe('<p class="ask">x Ask <b>A</b>.</p>');
  });

  it('escapes names', () => {
    expect(render(<AskSomeone people={['<x>']}>y</AskSomeone>)).toContain('<b>&lt;x&gt;</b>');
  });
});
