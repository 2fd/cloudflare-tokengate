import { describe, expect, it } from 'vitest';
import { ConnectionsMap } from '../../src';
import { render } from '../render';
import { accesses, atScale, consumers, tokens } from './fixtures';

const base = () =>
  render(<ConnectionsMap id="cm" consumers={consumers} tokens={tokens} accesses={accesses} />);

/** `d` attributes of the wires with their classes. */
function wires(html: string): Array<{ cls: string; d: string }> {
  return [...html.matchAll(/<path class="([^"]+)" d="([^"]+)"/g)].map((m) => ({
    cls: m[1] ?? '',
    d: m[2] ?? '',
  }));
}

describe('ConnectionsMap', () => {
  it('sorts consumers by accesses and tokens by requests', () => {
    const html = base();
    const names = [...html.matchAll(/<span class="nm">([^<]+)/g)].map((m) => m[1]?.trim());
    expect(names).toEqual([
      'GitHub Actions (acme)',
      'GitLab CI (platform)',
      'Buildkite (acme)',
      'OpenAI',
      'Slack',
      'Anthropic',
      'GitHub',
      'Discord alerts',
      'Slack (legacy)',
    ]);
  });

  it('draws one wire per consumer–token pair with the geometry rule', () => {
    const html = base();
    // 6 token rows: H = 6 * 64 - 8; the busiest consumer spans 4 rows and centers at 124.
    expect(html).toContain('viewBox="0 0 100 376" preserveAspectRatio="none" height="376"');
    expect(html).toContain('<li class="node cnode rs4">');
    expect(wires(html)).toEqual([
      { cls: 'wire', d: 'M0 124 C50 124 50 28 100 28' },
      { cls: 'wire', d: 'M0 124 C50 124 50 92 100 92' },
      { cls: 'wire warn', d: 'M0 124 C50 124 50 156 100 156' },
      { cls: 'wire warn', d: 'M0 124 C50 124 50 220 100 220' },
      { cls: 'wire warn', d: 'M0 284 C50 284 50 92 100 92' },
      { cls: 'wire', d: 'M0 284 C50 284 50 284 100 284' },
      { cls: 'wire off', d: 'M0 348 C50 348 50 348 100 348' },
    ]);
  });

  it('labels the map, hides the wires and reads counts as words', () => {
    const html = base();
    expect(html).toContain(
      '<div class="cmap" id="cm" role="group" aria-label="Connections map. Every line is also listed as text below.">',
    );
    expect(html).toContain('<div class="cmap-mid" aria-hidden="true">');
    expect(html).toContain('<span class="cnt">6<span class="vh"> accesses</span></span>');
    expect(html).toContain('<span class="cnt">1<span class="vh"> access</span></span>');
    expect(html).toContain('9 accesses</span>');
    expect(html).toContain(
      '<span class="vh">. Used by GitHub Actions (acme) and GitLab CI (platform)</span>',
    );
  });

  it('renders token metrics with the zero, bad and warn tones', () => {
    const html = base();
    expect(html).toContain('<span class="m bad">21<span class="vh"> denied</span></span>');
    expect(html).toContain('<span class="m warn x">11<span class="vh"> errors</span></span>');
    expect(html).toContain('<span class="m warn x">1<span class="vh"> error</span></span>');
    expect(html).toContain('<span class="m z">0<span class="vh"> denied</span></span>');
    expect(html).toContain(
      '<span class="m keep zero">0<span class="u" aria-hidden="true"> req</span>',
    );
    expect(html).toContain('<span class="t-warn">⌛ Secret expires in 6 days</span>');
    expect(html).toContain('<span class="t-bad">✕ 1 of 2 accesses expired</span>');
  });

  it('marks idle nodes and the edge tag', () => {
    const html = base();
    expect(html).toContain(
      '<li class="node cnode idle"><span class="logo lg-buildkite dis" aria-hidden="true">BK</span>',
    );
    expect(html).toContain('<li class="node tnode idle"><span class="tag">1 idle token</span>');
  });

  it('links nodes to the access list and builds the list equivalent', () => {
    const html = base();
    expect(html).toContain('href="/admin/issuer-access-rules?consumer=github-acme"');
    expect(html).toContain('href="/admin/issuer-access-rules?token=discord-alerts"');
    expect(html).toContain('<summary>Show the map as a list (9 accesses)</summary>');
    expect(html.match(/<li><span class="arrow">|<li><a class="arrow"/g)).toHaveLength(9);
    expect(html).toContain('<a class="arrow" href="/admin/issuer-access-rules/acc_bk1">');
    expect(html).toContain('<span class="st warn">Expires in 9 days</span>');
    expect(html).toContain('<span class="st off">Inactive: token disabled</span>');
    expect(html).toContain('<span class="st">Active</span>');
  });

  it('shows the focus bar and the default legend without a scale note', () => {
    const html = base();
    expect(html).toContain('<nav class="qlinks" aria-label="Focus on a credential access rule">');
    expect(html).toContain(
      '<a class="ql" href="/admin/issuer-access-rules" aria-current="true">All credential access rules</a>',
    );
    expect(html).toContain('href="/admin/issuer-access-rules?focus=gitlab-platform"');
    expect(html).not.toContain('cmap-note');
    expect(html).not.toContain('more in the matrix');
    expect(html).toContain('Needs attention (the credential says why)');
  });

  it('focuses one consumer: its node and tokens on, the rest dim, its wires on top', () => {
    const html = render(
      <ConnectionsMap
        id="cm"
        consumers={consumers}
        tokens={tokens}
        accesses={accesses}
        focus="gitlab-platform"
      />,
    );
    expect(html).toContain(
      'aria-label="Connections map focused on GitLab CI (platform). Its accesses are also listed as text below."',
    );
    expect(html).toContain('<li class="node cnode is-on">');
    expect(html).toContain(
      '<a class="id" href="/admin/issuer-access-rules?consumer=gitlab-platform" aria-current="true"><span class="nm">GitLab CI (platform)</span><span class="nl">Focused · group platform (5678901)</span>',
    );
    // dimmed consumers link to their own focus
    expect(html).toContain('<li class="node cnode rs4 dim">');
    expect(html).toContain('href="/admin/issuer-access-rules?focus=github-acme"><span class="nm">');
    expect(html.match(/class="node tnode[^"]*is-on"/g)).toHaveLength(2);
    const drawn = wires(html);
    expect(drawn.slice(-2).map((w) => w.cls)).toEqual(['wire warn on', 'wire on']);
    expect(drawn.slice(0, -2).every((w) => w.cls.endsWith('dim'))).toBe(true);
    expect(html).toContain('<a class="sm" href="/admin/issuer-access-rules">Clear focus</a>');
    expect(html).toContain('<summary>Show GitLab CI (platform) as a list (2 accesses)</summary>');
    expect(html).toContain('Focused credential access rule');
  });

  it('focuses one token: it, its wires and its consumers on, the rest dim, no focus bar', () => {
    const html = render(
      <ConnectionsMap
        id="cm"
        consumers={consumers}
        tokens={tokens}
        accesses={accesses}
        focusToken="slack"
      />,
    );
    expect(html).toContain(
      'aria-label="Connections map focused on Slack. Its accesses are also listed as text below."',
    );
    expect(html).not.toContain('class="cmap-bar"');
    expect(html.match(/class="node tnode[^"]*is-on"/g)).toHaveLength(1);
    expect(html.match(/class="node tnode[^"]*dim"/g)).toHaveLength(tokens.length - 1);
    const slackConsumers = new Set(
      accesses.filter((a) => a.token === 'slack').map((a) => a.consumer),
    );
    expect(html.match(/class="node cnode[^"]*is-on"/g)).toHaveLength(slackConsumers.size);
    const toSlack = accesses.filter((a) => a.consumer === 'github-acme' && a.token === 'slack');
    expect(html).toContain(
      `<span class="nl">${toSlack.length} ${toSlack.length === 1 ? 'access' : 'accesses'} to Slack</span>`,
    );
    const drawn = wires(html);
    expect(drawn.filter((w) => w.cls.endsWith(' on')).length).toBe(slackConsumers.size);
    expect(drawn.filter((w) => !w.cls.endsWith(' on')).every((w) => w.cls.endsWith('dim'))).toBe(
      true,
    );
    expect(html).toContain('Lines to Slack');
  });

  it('applies the scale rule: 6 busiest per side plus a group node, never more than 7 rows', () => {
    const data = atScale();
    const html = render(<ConnectionsMap id="cm" {...data} />);
    expect(html.match(/class="node cnode/g)).toHaveLength(6);
    expect(html.match(/class="node tnode/g)).toHaveLength(6);
    expect(html).toContain(
      '<a class="id" href="/admin/issuer-access-rules?view=matrix&amp;consumers=rest"><span class="nm">+ 8 more credential access rules</span><span class="nl">9 accesses · open in the matrix</span>',
    );
    expect(html).toContain('<span class="nm">+ 3 more credentials</span>');
    // H = 7 * 64 - 8 and the group rows (index 6) center at 412
    expect(html).toContain('height="440"');
    expect(wires(html).some((w) => w.d === 'M0 412 C50 412 50 412 100 412')).toBe(true);
    expect(html).toContain(
      '<p class="cmap-note"><b>14 credential access rules, 9 credentials.</b> The map draws the 6 busiest on each side',
    );
    expect(html).toContain('15 accesses');
    expect(html).toContain(
      '<a class="ql" href="/admin/issuer-access-rules?view=matrix">11 more in the matrix</a>',
    );
  });

  it('always shows the focused consumer and its tokens, even outside the busiest 6', () => {
    const data = atScale();
    const html = render(<ConnectionsMap id="cm" {...data} focus="c13" />);
    expect(html).toContain('<span class="nm">Credential access rule 13</span>');
    expect(html).toContain('<span class="nm">Credential 8</span>');
    expect(html.match(/class="node cnode/g)).toHaveLength(6);
    expect(html).toContain(
      'aria-current="true">Credential access rule 13 <span class="n">2</span></a>',
    );
  });

  it('honors maxRows, baseHref, focusLinks and footer, and escapes names', () => {
    const html = render(
      <ConnectionsMap
        id="cm"
        consumers={[{ ...consumers[0]!, name: '<b>x</b>' }]}
        tokens={tokens.slice(0, 1)}
        accesses={[{ consumer: 'gitlab-platform', token: 'slack', status: 'Active' }]}
        baseHref="/admin/issuer-access-rules?env=prod"
        focusLinks={0}
        footer="Refused before a token was chosen: 182"
        class="extra"
      />,
    );
    expect(html).not.toContain('<b>x</b>');
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(html).toContain(
      'href="/admin/issuer-access-rules?env=prod&amp;consumer=gitlab-platform"',
    );
    expect(html).not.toContain('cmap-bar');
    expect(html).toContain(
      '<div class="tray-f"><span>Refused before a token was chosen: 182</span>',
    );
    expect(html).toContain('class="cmap extra"');
  });

  it('labels the numbers with the range', () => {
    const html = render(
      <ConnectionsMap
        id="cm"
        consumers={consumers}
        tokens={tokens}
        accesses={accesses}
        rangeLabel={{ short: 'Req 7 d', long: 'requests in 7 days' }}
      />,
    );
    expect(html).toContain('<span class="keep">Req 7 d</span>');
    expect(html).toContain('<span class="vh"> requests in 7 days</span>');
    expect(html).not.toContain('24 h');
    expect(base()).toContain('<span class="keep">Req 24 h</span>');
  });

  it('keeps focus links on focusHref and links the token numbers', () => {
    const html = render(
      <ConnectionsMap
        id="cm"
        consumers={consumers}
        tokens={tokens.map((t) =>
          t.id === 'openai'
            ? {
                ...t,
                hrefs: {
                  requests: `/admin/requests?token=${t.id}`,
                  denied: `/admin/requests?token=${t.id}&outcome=denied`,
                  errors: `/admin/requests?token=${t.id}&outcome=error`,
                },
              }
            : t,
        )}
        accesses={accesses}
        focus="gitlab-platform"
        focusHref="/admin"
      />,
    );
    expect(html).toContain('<a class="ql" href="/admin">All credential access rules</a>');
    expect(html).toContain('href="/admin?focus=github-acme"');
    expect(html).toContain('<a class="sm" href="/admin">Clear focus</a>');
    // the other consumer nodes refocus on focusHref; the focused one and the tokens stay on baseHref
    expect(html).toContain('<a class="id" href="/admin?focus=buildkite-acme">');
    expect(html).toContain(
      'href="/admin/issuer-access-rules?consumer=gitlab-platform" aria-current="true"',
    );
    expect(html).toContain('href="/admin/issuer-access-rules?token=openai"');
    expect(html).toContain(
      '<span class="m keep"><a href="/admin/requests?token=openai">3,902<span class="vh"> requests in 24 hours</span></a><span class="u" aria-hidden="true"> req</span></span>',
    );
    expect(html).toContain(
      '<span class="m bad"><a href="/admin/requests?token=openai&amp;outcome=denied">21<span class="vh"> denied</span></a></span>',
    );
    expect(html).toContain(
      '<span class="m warn x"><a href="/admin/requests?token=openai&amp;outcome=error">11<span class="vh"> errors</span></a></span>',
    );
    expect(html).toContain('<span class="m keep">2,140<span class="u" aria-hidden="true">');
  });
});
