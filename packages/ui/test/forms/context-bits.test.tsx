import { describe, expect, it } from 'vitest';
import { FixedBar, Inherit, SubmitRow } from '../../src';
import { render } from '../render';

describe('FixedBar', () => {
  it('renders the fixed value with its logo, meta, status and change link', () => {
    expect(
      render(
        <FixedBar
          label="Token"
          logo={
            <span class="logo sm lg-slack" aria-hidden="true">
              S
            </span>
          }
          name="Slack"
          meta="/proxy/slack"
          status={<span class="badge ok">Secret set</span>}
          change={{ href: '/admin/access/new', context: 'token' }}
        />,
      ),
    ).toBe(
      '<div class="fixedbar"><span class="lbl">Token</span><span class="logo sm lg-slack" aria-hidden="true">S</span><span class="grow"><b>Slack</b> <span class="meta mono">/proxy/slack</span></span><span class="badge ok">Secret set</span><a class="sm" href="/admin/access/new">Change<span class="vh"> token</span></a></div>',
    );
  });

  it('renders the minimal bar with the class and a custom link label', () => {
    expect(
      render(
        <FixedBar
          label="Consumer"
          name="GitHub Actions (acme)"
          class="x"
          change={{ href: '?', context: 'consumer', label: 'Pick another' }}
        />,
      ),
    ).toBe(
      '<div class="fixedbar x"><span class="lbl">Consumer</span><span class="grow"><b>GitHub Actions (acme)</b></span><a class="sm" href="?">Pick another<span class="vh"> consumer</span></a></div>',
    );
  });
});

describe('Inherit', () => {
  it('renders the inherited fact', () => {
    expect(
      render(
        <Inherit class="x">
          Inherited from <b>GitHub Actions (acme)</b>
        </Inherit>,
      ),
    ).toBe('<p class="inherit x">Inherited from <b>GitHub Actions (acme)</b></p>');
  });
});

describe('SubmitRow', () => {
  it('renders the buttons then the hint', () => {
    expect(
      render(
        <SubmitRow hint="After saving you get the workflow snippet." id="act" class="x">
          <button class="btn primary" type="submit">
            Give access
          </button>
        </SubmitRow>,
      ),
    ).toBe(
      '<div class="submit-row x" id="act"><button class="btn primary" type="submit">Give access</button><p class="hint">After saving you get the workflow snippet.</p></div>',
    );
    expect(render(<SubmitRow>b</SubmitRow>)).toBe('<div class="submit-row">b</div>');
  });
});
