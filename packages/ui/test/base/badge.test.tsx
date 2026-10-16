import { describe, expect, it } from 'vitest';
import { Badge } from '../../src';
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
});
