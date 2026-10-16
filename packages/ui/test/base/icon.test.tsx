import { describe, expect, it } from 'vitest';
import { ICON_NAMES, Icon } from '../../src';
import { render } from '../render';

describe('Icon', () => {
  it('is a decorative 24-unit svg.ic by default', () => {
    expect(render(<Icon name="search" />)).toBe(
      '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6"></circle><path d="M20 20l-4.5-4.5"></path></svg>',
    );
  });

  it('is a named image with a label', () => {
    const html = render(<Icon name="gate" label="tokengate" class="x" />);
    expect(html).toMatch(
      /^<svg class="ic x" viewBox="0 0 24 24" role="img" aria-label="tokengate">/,
    );
    expect(html).not.toContain('aria-hidden');
  });

  it.each(ICON_NAMES)('%s renders only outline shapes', (name) => {
    const html = render(<Icon name={name} />);
    expect(html).toMatch(/^<svg class="ic"[^>]*><(path|circle|rect) /);
    expect(html).not.toMatch(/fill=|style=|<script|<use/);
  });

  it('escapes the label', () => {
    expect(render(<Icon name="token" label={'"><x'} />)).toContain('aria-label="&quot;&gt;&lt;x"');
  });
});
