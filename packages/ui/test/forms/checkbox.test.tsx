import { describe, expect, it } from 'vitest';
import { Checkbox, Reveal } from '../../src';
import { render } from '../render';

describe('Checkbox', () => {
  it('renders a checkbox row with its label', () => {
    expect(
      render(
        <Checkbox name="also_uploads" value="1">
          Also create a token for uploads.github.com
        </Checkbox>,
      ),
    ).toBe(
      '<label class="check"><input type="checkbox" name="also_uploads" value="1"/><span>Also create a token for uploads.github.com</span></label>',
    );
  });

  it('adds a hint line inside the label', () => {
    expect(
      render(
        <Checkbox name="hosted" hint="Refuse self-hosted runners.">
          GitHub-hosted runners only
        </Checkbox>,
      ),
    ).toContain(
      '<span><span>GitHub-hosted runners only</span><span class="hint">Refuse self-hosted runners.</span></span>',
    );
  });

  it('renders checked, disabled, invalid and the class', () => {
    expect(
      render(
        <Checkbox name="a" id="a" checked disabled invalid describedBy="a-error" class="x">
          A
        </Checkbox>,
      ),
    ).toBe(
      '<label class="check x"><input type="checkbox" id="a" name="a" checked="" disabled="" aria-invalid="true" aria-describedby="a-error"/><span>A</span></label>',
    );
  });

  it('renders an error line before the label and wires it to the box', () => {
    expect(
      render(
        <Checkbox
          name="allow_host"
          id="ah"
          error="Confirm the new host"
          describedBy="ah-note"
          class="x"
        >
          Allow api.example.com
        </Checkbox>,
      ),
    ).toBe(
      '<p class="field-error" id="ah-error"><span aria-hidden="true">✕</span><span class="vh">Error:</span> Confirm the new host</p><label class="check x"><input type="checkbox" id="ah" name="allow_host" aria-invalid="true" aria-describedby="ah-error ah-note"/><span>Allow api.example.com</span></label>',
    );
  });

  it('an error needs an id', () => {
    expect(() =>
      render(
        <Checkbox name="n" error="E">
          N
        </Checkbox>,
      ),
    ).toThrow('Checkbox: error needs an id');
  });

  it('escapes the label and refuses required inside a Reveal', () => {
    expect(render(<Checkbox name="e">{'<i>'}</Checkbox>)).toContain('&lt;i&gt;');
    expect(() =>
      render(
        <Reveal field={1} option={1}>
          <Checkbox name="r" required>
            R
          </Checkbox>
        </Reveal>,
      ),
    ).toThrow(/Checkbox: no required/);
  });
});
