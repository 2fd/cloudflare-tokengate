import { describe, expect, it } from 'vitest';
import { Badge, STATUS_VOCABULARY, type StatusKind } from '../../src';
import { render } from '../render';

describe('Badge', () => {
  it('renders the neutral badge without a tone class', () => {
    expect(render(<Badge>Owner</Badge>)).toBe('<span class="badge">Owner</span>');
  });

  it('adds the tone and hides the glyph from assistive tech', () => {
    expect(
      render(
        <Badge tone="ok" glyph="✓" class="x">
          Active
        </Badge>,
      ),
    ).toBe('<span class="badge ok x"><span aria-hidden="true">✓</span>Active</span>');
  });

  it.each(['ok', 'warn', 'bad', 'info', 'pending', 'off', 'accent', 'outline'] as const)(
    'renders the %s tone class',
    (tone) => {
      expect(render(<Badge tone={tone}>x</Badge>)).toBe(`<span class="badge ${tone}">x</span>`);
    },
  );

  it.each(Object.keys(STATUS_VOCABULARY) as StatusKind[])(
    'status %s sets the tone, the glyph and the word of the vocabulary',
    (status) => {
      const { tone, glyph, word } = STATUS_VOCABULARY[status];
      expect(render(<Badge status={status} />)).toBe(
        `<span class="badge ${tone}"><span aria-hidden="true">${glyph}</span>${word}</span>`,
      );
    },
  );

  it('shows Pending approval in the pending tone, apart from neutral info notes', () => {
    expect(render(<Badge status="pending" />)).toBe(
      '<span class="badge pending"><span aria-hidden="true">◐</span>Pending approval</span>',
    );
  });

  it('lets the word, tone and glyph override a status preset', () => {
    expect(render(<Badge status="expiring">Expires in 6 days</Badge>)).toBe(
      '<span class="badge warn"><span aria-hidden="true">⌛</span>Expires in 6 days</span>',
    );
    expect(render(<Badge status="active" tone="accent" glyph="★" />)).toBe(
      '<span class="badge accent"><span aria-hidden="true">★</span>Active</span>',
    );
  });

  it('escapes text', () => {
    expect(render(<Badge glyph="<">{'<b>x</b>'}</Badge>)).toBe(
      '<span class="badge"><span aria-hidden="true">&lt;</span>&lt;b&gt;x&lt;/b&gt;</span>',
    );
  });
});
