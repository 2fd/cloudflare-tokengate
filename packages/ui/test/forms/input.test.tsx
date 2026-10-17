import { describe, expect, it } from 'vitest';
import { Field, Input, Reveal, Textarea } from '../../src';
import { render } from '../render';

describe('Input', () => {
  it('needs an id or a Field', () => {
    expect(() => render(<Input />)).toThrow(/needs an id/);
  });

  it('mono turns off autocomplete, spellcheck, autocapitalize and autocorrect', () => {
    expect(render(<Input id="r" mono placeholder="acme/api (89012345)" />)).toBe(
      '<input class="input mono" id="r" type="text" placeholder="acme/api (89012345)" autocomplete="off" spellcheck="false" autocapitalize="none" autocorrect="off"/>',
    );
  });

  it('secret is a mono password ignored by password managers, without autocorrect', () => {
    const html = render(<Input id="s" secret name="credential" />);
    expect(html).toContain('class="input mono"');
    expect(html).toContain('type="password"');
    expect(html).toContain(
      'autocorrect="off" data-1p-ignore="true" data-lpignore="true" data-bwignore="true"',
    );
    expect(html).toContain('autocomplete="off"');
  });

  it('plain text renders no autocorrect or password-manager attributes', () => {
    const html = render(<Input id="plain" />);
    expect(html).toBe('<input class="input" id="plain" type="text"/>');
  });

  it('spellcheck and autocapitalize override the mono defaults', () => {
    expect(
      render(
        <Input
          id="e"
          type="email"
          spellcheck={false}
          autocapitalize="none"
          enterkeyhint="send"
          autofocus
        />,
      ),
    ).toBe(
      '<input class="input" id="e" type="email" enterkeyhint="send" autofocus="" spellcheck="false" autocapitalize="none"/>',
    );
    const mono = render(<Input id="m" mono spellcheck autocapitalize="words" />);
    expect(mono).toContain('spellcheck="true" autocapitalize="words" autocorrect="off"');
  });

  it('renders each enterkeyhint value', () => {
    for (const hint of ['enter', 'done', 'go', 'next', 'previous', 'search', 'send'] as const) {
      expect(render(<Input id="k" enterkeyhint={hint} />)).toContain(`enterkeyhint="${hint}"`);
    }
  });

  it('a suggestion label is the datalist option text; the link keeps the value', () => {
    const html = render(
      <Input
        id="h"
        suggestions={[{ value: 'api.github.com', label: 'GitHub API', href: '?h=api' }]}
      />,
    );
    expect(html).toContain(
      '<datalist id="h-list"><option value="api.github.com">GitHub API</option></datalist>',
    );
    expect(html).toContain('<a href="?h=api">api.github.com</a>');
  });

  it('keeps an explicit autocomplete', () => {
    expect(render(<Input id="u" mono autocomplete="username" />)).toContain(
      'autocomplete="username"',
    );
  });

  it('renders the states and native constraints', () => {
    const html = render(
      <Input
        id="p"
        value="/proxy/slack"
        readonly
        disabled
        required
        pattern="[a-z]+"
        maxlength={63}
      />,
    );
    expect(html).toBe(
      '<input class="input" id="p" type="text" value="/proxy/slack" readonly="" disabled="" required="" pattern="[a-z]+" maxlength="63"/>',
    );
    expect(render(<Input id="d" type="date" width="date" min="2026-10-15" />)).toBe(
      '<input class="input w-date" id="d" type="date" min="2026-10-15"/>',
    );
  });

  it('renders a datalist and a visible suggestions line for linked values', () => {
    const html = render(
      <Input
        id="br"
        mono
        suggestionsLabel="Used before"
        suggestions={[{ value: 'main', href: '?branch=main' }, { value: 'release/*' }]}
      />,
    );
    expect(html).toContain('list="br-list"');
    expect(html).toContain(
      '<datalist id="br-list"><option value="main"></option><option value="release/*"></option></datalist>',
    );
    expect(html).toContain('<p class="suggest">Used before <a href="?branch=main">main</a></p>');
  });

  it('renders no suggestions line when no value has a link', () => {
    const html = render(<Input id="n" suggestions={[{ value: 'a' }]} />);
    expect(html).toContain('<datalist id="n-list">');
    expect(html).not.toContain('suggest');
  });

  it('escapes values and appends the class', () => {
    const html = render(<Input id="v" value={'"><script>'} class="x" />);
    expect(html).toContain('class="input x"');
    expect(html).toContain('value="&quot;&gt;&lt;script&gt;"');
  });

  it('refuses required inside a Reveal', () => {
    expect(() =>
      render(
        <Reveal field={2} option={5}>
          <Field id="r" label="Repository">
            <Input required />
          </Field>
        </Reveal>,
      ),
    ).toThrow(/no required inside a Reveal/);
  });
});

describe('Textarea', () => {
  it('renders the value as escaped text and mono without spellcheck', () => {
    expect(render(<Textarea id="t" mono rows={4} value="<x>" />)).toBe(
      '<textarea class="input mono" id="t" rows="4" spellcheck="false">&lt;x&gt;</textarea>',
    );
  });

  it('refuses required inside a Reveal', () => {
    expect(() =>
      render(
        <Reveal field={1} option={1}>
          <Textarea id="t" required />
        </Reveal>,
      ),
    ).toThrow(/Textarea: no required/);
  });
});
