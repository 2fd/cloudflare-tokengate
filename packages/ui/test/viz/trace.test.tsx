import { describe, expect, it } from 'vitest';
import { ArrowRow, NextStep, Trace } from '../../src';
import { render } from '../render';

describe('Trace', () => {
  it('renders each state with its default word and hidden glyph', () => {
    const html = render(
      <Trace
        label="Where the call stopped"
        steps={[
          { state: 'pass', title: 'Caller verified', detail: 'GitHub Actions (acme)' },
          {
            state: 'fail',
            status: 'Failed, stopped here',
            title: 'Access matched',
            detail: (
              <>
                branch <mark>feature/login-redesign</mark>
              </>
            ),
          },
          { state: 'notrun', title: 'Upstream', detail: 'Slack was not called' },
          { state: 'warn', title: 'Any branch' },
          { state: 'on', title: 'Ask an owner' },
        ]}
      />,
    );
    expect(html.startsWith('<ol class="trace" aria-label="Where the call stopped">')).toBe(true);
    expect(html).toContain(
      '<li class="tstep pass"><span class="s"><span aria-hidden="true">✓ </span>Passed</span><span class="v">Caller verified</span><span class="d">GitHub Actions (acme)</span></li>',
    );
    expect(html).toContain(
      '<li class="tstep fail"><span class="s"><span aria-hidden="true">✕ </span>Failed, stopped here</span><span class="v">Access matched</span><span class="d">branch <mark>feature/login-redesign</mark></span></li>',
    );
    expect(html).toContain(
      '<li class="tstep notrun"><span class="s"><span aria-hidden="true">– </span>Not reached</span>',
    );
    expect(html).toContain(
      '<li class="tstep warn"><span class="s"><span aria-hidden="true">⚠ </span>Risk accepted</span><span class="v">Any branch</span></li>',
    );
    expect(html).toContain('<li class="tstep is-on"><span class="s">Current choice</span>');
  });

  it('takes a glyph override and a class, and escapes text', () => {
    const html = render(<Trace class="c3" steps={[{ state: 'pass', glyph: '', title: '<x>' }]} />);
    expect(html).toBe(
      '<ol class="trace c3"><li class="tstep pass"><span class="s">Passed</span><span class="v">&lt;x&gt;</span></li></ol>',
    );
  });
});

describe('NextStep', () => {
  it('renders the bold title, prefill chips and actions', () => {
    const html = render(
      <NextStep
        title="Give access from this request."
        prefill={[
          { label: 'GitHub Actions (acme)', logo: { brand: 'github' } },
          { label: 'acme/web', mono: true },
          { label: 'Slack', logo: { brand: 'slack' } },
        ]}
        actions={
          <a class="btn primary" href="/admin/access/new">
            Give access from this request
          </a>
        }
      >
        The form opens with these values filled in.
      </NextStep>,
    );
    expect(html).toBe(
      '<div class="todo"><p><b>Give access from this request.</b> The form opens with these values filled in.</p><p class="prefill"><span class="vh">Filled in: </span><span class="chip"><span class="logo xs lg-github" aria-hidden="true">GH</span>GitHub Actions (acme)</span><span class="chip text mono">acme/web</span><span class="chip"><span class="logo xs lg-slack" aria-hidden="true">S</span>Slack</span></p><div class="btn-row"><a class="btn primary" href="/admin/access/new">Give access from this request</a></div></div>',
    );
  });

  it('leaves out empty parts', () => {
    expect(render(<NextStep title="Nothing to do." class="x" />)).toBe(
      '<div class="todo x"><p><b>Nothing to do.</b></p></div>',
    );
  });
});

describe('ArrowRow', () => {
  it('reads "can use" instead of the arrow', () => {
    expect(
      render(
        <ArrowRow
          consumer={{
            name: 'GitLab CI (platform) › platform/deploy-tools',
            logo: { brand: 'gitlab' },
            context: 'branch main',
          }}
          token={{
            name: 'Discord alerts',
            logo: { brand: 'discord' },
            context: <code>POST /</code>,
          }}
        />,
      ),
    ).toBe(
      '<span class="arrow"><span class="side-c"><span class="logo xs lg-gitlab" aria-hidden="true">GL</span>GitLab CI (platform) › platform/deploy-tools<span class="ctx"><span class="sep" aria-hidden="true">· </span>branch main</span></span><span class="to" aria-hidden="true">→</span><span class="vh"> can use </span><span class="side-t"><span class="logo xs lg-discord" aria-hidden="true">D</span>Discord alerts<span class="ctx"><span class="sep" aria-hidden="true">· </span><code>POST /</code></span></span></span>',
    );
  });

  it('renders only the consumer side without a token: no arrow, no verb', () => {
    const html = render(
      <ArrowRow
        consumer={{
          name: 'Unverified caller',
          logo: { brand: 'github' },
          context: 'refused before a token was chosen',
        }}
      />,
    );
    expect(html).toBe(
      '<span class="arrow"><span class="side-c"><span class="logo xs lg-github" aria-hidden="true">GH</span>Unverified caller<span class="ctx"><span class="sep" aria-hidden="true">· </span>refused before a token was chosen</span></span></span>',
    );
    const linked = render(<ArrowRow href="/r/1" verb="may call" consumer={{ name: 'c' }} />);
    expect(linked).toBe(
      '<a class="arrow" href="/r/1"><span class="side-c"><span class="ent-n">c</span></span></a>',
    );
  });

  it('is one link when it has href, with a custom verb and class', () => {
    const html = render(
      <ArrowRow
        href="/admin/access/acc_1"
        verb="may call"
        class="x"
        consumer={{ name: 'Buildkite (acme)', logo: { brand: 'oidc' } }}
        token={{ name: 'Slack (legacy)', logo: { brand: 'slack', disabled: true } }}
      />,
    );
    expect(html).toContain(
      '<a class="arrow x" href="/admin/access/acc_1"><span class="side-c"><span class="logo xs lg-oidc" aria-hidden="true"><svg viewBox="0 0 24 24">',
    );
    expect(html).toContain('<span class="ent-n">Buildkite (acme)</span>');
    expect(html).toContain('<span class="vh"> may call </span>');
    expect(html).toContain('<span class="logo xs lg-slack dis" aria-hidden="true">S</span>');
  });
});
