import { describe, expect, it } from 'vitest';
import {
  LiveForm,
  LivePhrase,
  LiveSummary,
  RiskSwitch,
  SummaryFoot,
  SummaryRow,
  SummaryWire,
} from '../../src';
import { render } from '../render';

describe('LiveForm', () => {
  it('renders the live form layout with the form column and the rail', () => {
    expect(
      render(
        <LiveForm action="/admin/access" rail={<aside>r</aside>} id="give">
          x
        </LiveForm>,
      ),
    ).toBe(
      '<form class="lform form-layout" method="post" action="/admin/access" id="give"><div class="stack">x</div><aside>r</aside></form>',
    );
  });

  it('takes get and the class', () => {
    expect(
      render(
        <LiveForm method="get" class="y">
          x
        </LiveForm>,
      ),
    ).toBe('<form class="lform form-layout y" method="get"><div class="stack">x</div></form>');
    expect(render(<LiveForm layout="form-layout">x</LiveForm>)).toContain(
      'class="lform form-layout"',
    );
  });

  it('layout="fields" renders the column alone, without .form-layout', () => {
    expect(
      render(
        <LiveForm layout="fields" action="/admin/access/1" class="y" hidden={{ _csrf: 't' }}>
          x
        </LiveForm>,
      ),
    ).toBe(
      '<form class="lform y" method="post" action="/admin/access/1"><input type="hidden" name="_csrf" value="t"/><div class="stack">x</div></form>',
    );
  });

  it('refuses a rail with layout="fields"', () => {
    expect(() =>
      render(
        <LiveForm layout="fields" rail={<aside>r</aside>}>
          x
        </LiveForm>,
      ),
    ).toThrow(/a rail needs layout="form-layout"/);
  });
});

describe('LiveSummary', () => {
  it('renders a labelled rail with a tray and a panel', () => {
    expect(
      render(
        <LiveSummary id="sum" title="This access" description="Follows the choices in this form.">
          x
        </LiveSummary>,
      ),
    ).toBe(
      '<aside class="rail" id="sum" aria-labelledby="sum-h"><section class="tray"><div class="tray-h"><div class="t"><h2 id="sum-h">This access</h2><p>Follows the choices in this form.</p></div></div><div class="panel"><div class="lsum">x</div></div></section></aside>',
    );
  });

  it('renders an h3 at tray-title size', () => {
    expect(
      render(
        <LiveSummary id="s" title="T" headingLevel={3} class="x">
          x
        </LiveSummary>,
      ),
    ).toContain(
      '<aside class="rail x" id="s" aria-labelledby="s-h"><section class="tray"><div class="tray-h"><div class="t"><h3 id="s-h">T</h3>',
    );
  });
});

describe('summary parts', () => {
  it('SummaryRow renders a logo or a glyph tile, a title and a meta line', () => {
    expect(
      render(<SummaryRow logo="slack" title="Slack" meta="gate.acme.dev/proxy/slack" mono />),
    ).toBe(
      '<div class="lsum-row"><span class="logo lg-slack" aria-hidden="true">S</span><span><b>Slack</b><span class="meta mono">gate.acme.dev/proxy/slack</span></span></div>',
    );
    expect(render(<SummaryRow title="May call" class="x" />)).toBe(
      '<div class="lsum-row x"><span class="ico" aria-hidden="true">→</span><span><b>May call</b></span></div>',
    );
  });

  it('SummaryWire and SummaryFoot', () => {
    expect(render(<SummaryWire />)).toBe('<div class="lsum-wire" aria-hidden="true"></div>');
    expect(render(<SummaryFoot>Expires never.</SummaryFoot>)).toBe(
      '<p class="lsum-foot">Expires never.</p>',
    );
  });

  it('LivePhrase renders a phrase per option and the empty phrase', () => {
    expect(
      render(
        <LivePhrase
          field={1}
          as="b"
          phrases={{ 1: 'GitHub Actions (acme)', 2: 'GitLab CI (platform)' }}
          empty="Choose a consumer"
        />,
      ),
    ).toBe(
      '<b class="sv1"><span data-o="1">GitHub Actions (acme)</span><span data-o="2">GitLab CI (platform)</span><span data-o="0">Choose a consumer</span></b>',
    );
    expect(render(<LivePhrase field={6} phrases={{ 2: 'in 7 days' }} decorative class="x" />)).toBe(
      '<span class="sv6 x" aria-hidden="true"><span data-o="2">in 7 days</span></span>',
    );
  });

  it('LivePhrase escapes its phrases', () => {
    expect(render(<LivePhrase field={2} phrases={{ 1: '<b>' }} />)).toContain('&lt;b&gt;');
  });

  it('RiskSwitch renders both phrases', () => {
    expect(render(<RiskSwitch safe="No risks." risk="1 risk to accept." />)).toBe(
      '<span class="if-norisk">No risks.</span><span class="if-risk t-warn">1 risk to accept.</span>',
    );
  });
});
