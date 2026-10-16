import { describe, expect, it } from 'vitest';
import { Dot, RiskTag, Status } from '../../src';
import { render } from '../render';

describe('Status', () => {
  it('is ok by default, with no tone class', () => {
    expect(render(<Status>Active</Status>)).toBe('<span class="st">Active</span>');
  });

  it.each(['warn', 'bad', 'info', 'off'] as const)('renders the %s tone', (tone) => {
    expect(render(<Status tone={tone}>x</Status>)).toBe(`<span class="st ${tone}">x</span>`);
  });

  it('takes tone and word from the vocabulary and keeps class passthrough', () => {
    expect(render(<Status status="disabled" class="x" />)).toBe(
      '<span class="st off x">Disabled</span>',
    );
    expect(render(<Status status="expiring">Expires in 9 days</Status>)).toBe(
      '<span class="st warn">Expires in 9 days</span>',
    );
  });

  it('escapes the word', () => {
    expect(render(<Status>{'<i>'}</Status>)).toBe('<span class="st">&lt;i&gt;</span>');
  });
});

describe('Dot', () => {
  it('is a decorative dot', () => {
    expect(render(<Dot />)).toBe('<span class="dot" aria-hidden="true"></span>');
    expect(render(<Dot tone="warn" class="x" />)).toBe(
      '<span class="dot warn x" aria-hidden="true"></span>',
    );
  });
});

describe('RiskTag', () => {
  it('says Risk by default with a hidden glyph', () => {
    expect(render(<RiskTag />)).toBe(
      '<span class="risktag"><span aria-hidden="true">⚠</span>Risk</span>',
    );
  });

  it('takes another word and extra classes', () => {
    expect(render(<RiskTag class="x">Risky branch</RiskTag>)).toBe(
      '<span class="risktag x"><span aria-hidden="true">⚠</span>Risky branch</span>',
    );
  });
});
