import { describe, expect, it } from 'vitest';
import { RiskAcceptance } from '../../src';
import { render } from '../render';

const risks = [{ label: 'Pull request into', text: 'pull_request jobs run the proposed code.' }];

describe('RiskAcceptance', () => {
  it('renders a labelled group with the risks and one acceptance box', () => {
    expect(
      render(
        <RiskAcceptance
          id="risk"
          title="Accept 1 risk to save this access"
          risks={risks}
          confirm="I accept this risk for acme/api → Slack"
        />,
      ),
    ).toBe(
      '<div class="riskacc" id="risk" role="group" aria-labelledby="risk-h"><h2 id="risk-h"><span aria-hidden="true">⚠</span> Accept 1 risk to save this access</h2><ul><li><b>Pull request into:</b> pull_request jobs run the proposed code.</li></ul><label class="check"><input type="checkbox" id="risk-ack" name="acknowledge_warnings" value="1"/><span>I accept this risk for acme/api → Slack</span></label><p class="hint">Or pick a safer option above; this box then goes away.</p></div>',
    );
  });

  it('never renders required', () => {
    expect(render(<RiskAcceptance id="r" title="T" risks={risks} confirm="C" />)).not.toContain(
      'required',
    );
  });

  it('wires the error to the box and keeps it checked', () => {
    const html = render(
      <RiskAcceptance
        id="r"
        title="T"
        risks={risks}
        confirm="C"
        checked
        error="Accept the risk or pick a safer option."
      />,
    );
    expect(html).toContain('<p class="field-error" id="r-error">');
    expect(html).toContain('checked="" aria-invalid="true" aria-describedby="r-error"/>');
  });

  it('takes a custom name, value, hint, heading level and class, or no hint', () => {
    const html = render(
      <RiskAcceptance
        id="r"
        title="T"
        risks={risks}
        confirm="C"
        name="ack"
        value="yes"
        hint="H"
        headingLevel={2}
        class="x"
      />,
    );
    expect(html).toMatch(
      /^<div class="riskacc x" id="r" role="group" aria-labelledby="r-h"><h2 id="r-h">/,
    );
    expect(html).toContain('name="ack" value="yes"');
    expect(html).toContain('<p class="hint">H</p>');
    expect(
      render(<RiskAcceptance id="r" title="T" risks={risks} confirm="C" hint={null} />),
    ).not.toContain('class="hint"');
  });

  it('escapes the risk text', () => {
    expect(
      render(
        <RiskAcceptance id="r" title="T" risks={[{ label: '<b>', text: '<i>' }]} confirm="C" />,
      ),
    ).not.toMatch(/<b><b>|<i>/);
  });
});
