// The token page parts: Sparkline, WhoCanUse, Kpis columns, decision items, the chart scale.
import { describe, expect, it } from 'vitest';
import { Chart, Kpis, NeedsAttention, Pipeline, Sparkline, WhoCanUse } from '../../src';
import { render } from '../render';

describe('Sparkline', () => {
  const html = render(
    <Sparkline
      id="sp"
      title="Slack requests per hour"
      description="Peak at 12:00."
      bars={[{ allowed: 10 }, { allowed: 20, denied: 5 }, { allowed: 0 }]}
      axis={['15:00', '14:00']}
    />,
  );

  it('is a named image with a description', () => {
    expect(html).toContain(
      '<svg class="chart spark" viewBox="0 0 240 44" preserveAspectRatio="none" role="img" aria-labelledby="sp-t sp-d" focusable="false"><title id="sp-t">Slack requests per hour</title><desc id="sp-d">Peak at 12:00.</desc>',
    );
  });

  it('draws the allowed bars and stacks the denied ones on top, hatched', () => {
    expect(html.match(/<rect /g)).toHaveLength(3);
    expect(html).toContain('class="b-denied"');
  });

  it('shows the time labels, hidden from assistive tech', () => {
    expect(html).toContain(
      '<div class="spark-axis" aria-hidden="true"><span>15:00</span><span>14:00</span></div>',
    );
  });
});

describe('WhoCanUse', () => {
  it('draws consumer groups, access rows and the token hub', () => {
    const html = render(
      <WhoCanUse
        label="Accesses to Slack, grouped by consumer"
        token={{ name: 'Slack', logo: 'slack', path: '/proxy/slack' }}
        groups={[
          {
            consumer: {
              name: 'GitHub Actions (acme)',
              href: '/c/gh',
              line: 'org acme · 2 accesses',
              logo: 'github',
              count: 2,
            },
            accesses: [
              {
                name: 'acme/api',
                href: '/a/1',
                context: 'branch main',
                meta: 'never expires',
                status: <span class="badge ok">Active</span>,
              },
              {
                name: 'acme/web',
                href: '/a/2',
                status: 'x',
                warn: true,
                statusAction: <a href="/r">Renew</a>,
              },
            ],
            more: { href: '/m', label: '+ 5 more accesses', srSuffix: 'of GitHub Actions (acme)' },
          },
        ]}
        rest={{ href: '/matrix', label: '+ 11 more consumers' }}
        footer="Buildkite has no access."
        footerAction={
          <a class="btn sm ghost" href="/new">
            Give access
          </a>
        }
      />,
    );
    expect(html).toContain(
      '<div class="panel"><div class="wmap"><ul class="wgroups" aria-label="Accesses to Slack, grouped by consumer"><li class="wg"><div class="node cnode"><span class="logo lg-github" aria-hidden="true">GH</span>',
    );
    expect(html).toContain(
      '<li class="wrow"><span class="ent-t"><span><a class="ent-n" href="/a/1">acme/api</a> <span class="ctx">· branch main</span></span><span class="meta">never expires</span></span><span class="badge ok">Active</span></li>',
    );
    expect(html).toContain('<li class="wrow warn">');
    expect(html).toContain('<span class="wst">x<a href="/r">Renew</a></span>');
    expect(html).toContain(
      '<li class="wrow more"><a href="/m">+ 5 more accesses<span class="vh"> of GitHub Actions (acme)</span></a></li>',
    );
    expect(html).toContain('<li class="wg rest"><a class="node group" href="/matrix">');
    expect(html).toContain(
      '<div class="whub" aria-hidden="true"><div class="node is-on"><span class="logo lg-slack" aria-hidden="true">S</span><span class="nm">Slack</span><span class="meta">/proxy/slack</span></div></div>',
    );
    expect(html).toContain(
      '<div class="wfoot"><span>Buildkite has no access.</span><a class="btn sm ghost" href="/new">Give access</a></div>',
    );
  });

  it('shows the ghost when no consumer has access', () => {
    const html = render(
      <WhoCanUse
        label="l"
        token={{ name: 'Slack 2', logo: 'slack', path: '/proxy/slack-2' }}
        groups={[]}
        empty={{ title: 'No consumer access yet', children: <p class="ask">Ask</p> }}
      />,
    );
    expect(html).toContain(
      '<div class="wmap is-empty"><div class="wghost"><h3>No consumer access yet</h3><p class="ask">Ask</p></div>',
    );
  });
});

describe('Kpis columns', () => {
  it('renders the compact 2 × 2 block', () => {
    expect(render(<Kpis columns={2} items={[{ label: 'Requests', value: 2140 }]} />)).toMatch(
      /^<dl class="kpis c2">/,
    );
  });
});

describe('NeedsAttention decision item', () => {
  const html = render(
    <NeedsAttention
      layout="list"
      items={[
        {
          who: {
            id: 'sam',
            avatar: (
              <span class="avatar lg pending" aria-hidden="true">
                SI
              </span>
            ),
            name: 'sam@acme.dev',
            status: <span class="badge info">Pending approval</span>,
            meta: 'Sam Ito',
          },
          approve: {
            action: '/admin/users/usr_sam/decide',
            subject: 'sam@acme.dev',
            legend: 'Approve as',
            hidden: { _csrf: 't' },
            roles: [
              { value: 'viewer', label: 'Viewer' },
              { value: 'owner', label: 'Owner…', dialog: 'dlg-owner' },
            ],
            reject: {
              action: '/admin/users/usr_sam/decide',
              srSuffix: 'sam@acme.dev',
              hidden: { _csrf: 't' },
            },
          },
        },
      ]}
    />,
  );

  it('names the item by the person, a heading with the status', () => {
    expect(html).toContain(
      '<li aria-labelledby="sam"><div class="att-who"><span class="avatar lg pending" aria-hidden="true">SI</span><div><h3 id="sam">sam@acme.dev <span class="badge info">Pending approval</span></h3><p class="meta">Sam Ito</p></div></div>',
    );
  });

  it('groups the role buttons under a legend, Owner opens its dialog', () => {
    expect(html).toContain(
      '<form method="post" action="/admin/users/usr_sam/decide"><input type="hidden" name="_csrf" value="t"/><fieldset><legend>Approve as</legend><div class="btn-row"><button class="btn sm secondary" type="submit" name="role" value="viewer"><span class="vh">Approve sam@acme.dev as </span>Viewer</button>',
    );
    expect(html).toContain(
      '<button class="btn sm secondary" type="button" command="show-modal" commandfor="dlg-owner" popovertarget="dlg-owner">',
    );
  });

  it('rejects in a separate form', () => {
    expect(html).toContain(
      '<form class="reject" method="post" action="/admin/users/usr_sam/decide"><input type="hidden" name="_csrf" value="t"/><button class="btn sm danger" type="submit" name="decision" value="reject">Reject<span class="vh"> sam@acme.dev</span></button></form>',
    );
  });
});

describe('Chart scale', () => {
  it('ends the y axis on a gridline above the tallest bar', () => {
    const html = render(
      <Chart
        id="c"
        title="t"
        description="d"
        bars={[{ label: 'Mon', allowed: 7700, denied: 0, errors: 0 }]}
      />,
    );
    expect(html).toContain('>8,000</text>');
    // the zero label and every other time label can be hidden on a phone column (CSS)
    expect(html).toContain('<text class="axis y0"');
    // the tallest bar stays under the top gridline (y 16 is the top of the plot)
    const heights = [...html.matchAll(/class="b-allowed"[^>]* y="([\d.]+)"/g)].map((m) =>
      Number(m[1]),
    );
    expect(Math.min(...heights)).toBeGreaterThan(16);
  });
});

describe('Pipeline meta', () => {
  it('keeps each " · " fact of a text line unbroken', () => {
    const html = render(
      <Pipeline stages={[{ label: 'Upstream OK', value: 1, meta: '96.9 % · p95 212 ms' }]} />,
    );
    expect(html).toContain(
      '<span class="meta"><span class="nowrap">96.9 % ·</span><span class="nowrap">p95 212 ms</span></span>',
    );
  });
});
