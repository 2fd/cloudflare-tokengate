import { describe, expect, it } from 'vitest';
import { FormStep, RowPicker, Stepper } from '../../src';
import { render } from '../render';

describe('Stepper', () => {
  it('is an ordered list', () => {
    expect(render(<Stepper class="x">y</Stepper>)).toBe('<ol class="stepper x">y</ol>');
  });
});

describe('FormStep', () => {
  it('renders a fieldset step with a numbered legend and live slot', () => {
    expect(
      render(
        <FormStep n={1} title="Consumer" live={1} id="consumer">
          <RowPicker name="consumer" options={[{ value: 'gh', title: 'GitHub Actions (acme)' }]} />
        </FormStep>,
      ),
    ).toBe(
      '<li class="fstep"><span class="fstep-n" aria-hidden="true">1</span><fieldset class="fstep-b sf1" id="consumer"><legend class="fstep-t"><span class="vh">Step 1: </span>Consumer</legend><div class="rlist"><label class="row-pick nologo" data-o="1"><input type="radio" id="consumer-1" name="consumer" value="gh"/><span class="t">GitHub Actions (acme)</span><span></span></label></div></fieldset></li>',
    );
  });

  it('renders a description and the count scope', () => {
    const html = render(
      <FormStep
        n={3}
        title="Allowed operations"
        description="Presets for the Slack Web API."
        live={5}
        countScope
      >
        x
      </FormStep>,
    );
    expect(html).toContain('<fieldset class="fstep-b sf5 count-scope">');
    expect(html).toContain(
      '</legend><p class="hint">Presets for the Slack Web API.</p>x</fieldset>',
    );
  });

  it('renders a group step with a heading that labels it', () => {
    expect(
      render(
        <FormStep
          n={2}
          kind="group"
          id="jobs"
          title="Which jobs"
          description="Inherited from GitHub Actions (acme)."
        >
          x
        </FormStep>,
      ),
    ).toBe(
      '<li class="fstep"><span class="fstep-n" aria-hidden="true">2</span><div class="fstep-b" id="jobs" role="group" aria-labelledby="jobs-h"><div class="fstep-t"><h2 id="jobs-h"><span class="vh">Step 2: </span>Which jobs</h2><p>Inherited from GitHub Actions (acme).</p></div>x</div></li>',
    );
    expect(
      render(
        <FormStep n={2} kind="group" title="T" headingLevel={2}>
          x
        </FormStep>,
      ),
    ).toContain('<div class="fstep-b"><div class="fstep-t"><h2>');
  });

  it('renders the current and done states', () => {
    const current = render(
      <FormStep n={2} title="T" state="current">
        x
      </FormStep>,
    );
    expect(current).toMatch(/^<li class="fstep is-current" aria-current="step">/);
    const done = render(
      <FormStep n={1} title="T" state="done" class="x">
        x
      </FormStep>,
    );
    expect(done).toMatch(/^<li class="fstep is-done x">/);
    expect(done).toContain('<span class="vh">Step 1, done: </span>');
  });

  it('escapes the title', () => {
    expect(
      render(
        <FormStep n={1} title="<b>">
          x
        </FormStep>,
      ),
    ).toContain('&lt;b&gt;');
  });
});
