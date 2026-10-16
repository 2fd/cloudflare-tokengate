import { describe, expect, it } from 'vitest';
import { Field, Input, More, Reveal, SubBox } from '../../src';
import { render } from '../render';

describe('Reveal', () => {
  it('renders the hidden-branch box of option K of field N', () => {
    expect(
      render(
        <Reveal field={2} option={5}>
          <Field id="repo" label="Repository name (ID)" neededFor="Another repository">
            <Input mono />
          </Field>
        </Reveal>,
      ),
    ).toMatch(/^<div class="rv2 subbox" data-o="5"><div class="field"><label for="repo">/);
  });

  it('renders without the box and appends the class', () => {
    expect(
      render(
        <Reveal field={4} option={4} box={false} class="x">
          y
        </Reveal>,
      ),
    ).toBe('<div class="rv4 x" data-o="4">y</div>');
  });

  it('allows optional fields and does not affect siblings', () => {
    expect(() =>
      render(
        <>
          <Reveal field={1} option={1}>
            <Input id="a" />
          </Reveal>
          <Input id="b" required />
        </>,
      ),
    ).not.toThrow();
  });
});

describe('SubBox', () => {
  it('renders a div or a labelled aside', () => {
    expect(render(<SubBox>x</SubBox>)).toBe('<div class="subbox">x</div>');
    expect(
      render(
        <SubBox as="aside" labelledBy="next-h" class="y">
          x
        </SubBox>,
      ),
    ).toBe('<aside class="subbox y" aria-labelledby="next-h">x</aside>');
  });
});

describe('More', () => {
  it('renders a closed disclosure with a meta note', () => {
    expect(
      render(
        <More summary="More constraints" meta="workflow pin">
          x
        </More>,
      ),
    ).toBe(
      '<details class="more"><summary>More constraints <span class="meta">workflow pin</span></summary><div class="more-b">x</div></details>',
    );
  });

  it('renders open and appends the class', () => {
    expect(
      render(
        <More summary="S" open class="x">
          x
        </More>,
      ),
    ).toBe(
      '<details class="more x" open=""><summary>S</summary><div class="more-b">x</div></details>',
    );
  });
});
