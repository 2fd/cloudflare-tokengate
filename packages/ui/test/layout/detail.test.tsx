import { describe, expect, it } from 'vitest';
import { DetailLayout } from '../../src';
import { render } from '../render';

describe('DetailLayout', () => {
  it('renders the main column and a named rail aside', () => {
    expect(
      render(
        <DetailLayout railLabel="Slack details" rail="r" class="x">
          m
        </DetailLayout>,
      ),
    ).toBe(
      '<div class="detail x"><div class="col">m</div><aside class="rail" aria-label="Slack details">r</aside></div>',
    );
  });
});
