import { describe, expect, it } from 'vitest';
import { IdChip, Kbd, Mask, Mono, Slug } from '../../src';
import { render } from '../render';

describe('IdChip', () => {
  it('shows the full ID with the kind as tooltip', () => {
    expect(render(<IdChip kind="Token">svc_01JB8Y2K4M6P8R0T2V4X6Z8A1C</IdChip>)).toBe(
      '<span class="idchip" title="Token ID">svc_01JB8Y2K4M6P8R0T2V4X6Z8A1C</span>',
    );
  });

  it('has no title without a kind, keeps classes and escapes', () => {
    expect(render(<IdChip class="x">{'<id>'}</IdChip>)).toBe(
      '<span class="idchip x">&lt;id&gt;</span>',
    );
  });
});

describe('Slug, Mono, Kbd', () => {
  it('render their element and class', () => {
    expect(render(<Slug>slack-legacy</Slug>)).toBe('<span class="slug">slack-legacy</span>');
    expect(render(<Mono class="x">acme/api</Mono>)).toBe('<span class="mono x">acme/api</span>');
    expect(render(<Kbd>Esc</Kbd>)).toBe('<kbd>Esc</kbd>');
    expect(render(<Kbd class="x">{'<'}</Kbd>)).toBe('<kbd class="x">&lt;</kbd>');
  });
});

describe('Mask', () => {
  it('hides the dots and names the secret for screen readers', () => {
    expect(render(<Mask last4="9fQa" />)).toBe(
      '<span class="mask"><span aria-hidden="true">•••• </span><span class="vh">Secret ending in </span>9fQa</span>',
    );
  });

  it('never renders more than the last 4 characters', () => {
    const html = render(<Mask last4="xoxb-1234-secret-9fQa" size="lg" class="x" />);
    expect(html).toMatch(/^<span class="mask lg x">/);
    expect(html).toMatch(/<\/span>9fQa<\/span>$/);
    expect(html).not.toContain('xoxb');
  });

  it.each([undefined, ''])('says the last characters are not stored (last4 %j)', (last4) => {
    expect(render(<Mask last4={last4} srPrefix="Old secret ending in" />)).toBe(
      '<span class="mask"><span aria-hidden="true">••••</span><span class="vh">Secret, last characters not stored</span></span>',
    );
  });

  it('keeps the size and class without last4', () => {
    expect(render(<Mask size="lg" class="x" />)).toMatch(/^<span class="mask lg x">/);
  });

  it('takes another screen-reader label and escapes', () => {
    expect(render(<Mask last4="<&>" srPrefix="Old secret ending in" />)).toContain(
      '<span class="vh">Old secret ending in </span>&lt;&amp;&gt;',
    );
  });
});
