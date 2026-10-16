import { describe, expect, it } from 'vitest';
import { Checklist, ChecklistProgress, SplitView } from '../../src';
import { render } from '../render';

describe('Checklist', () => {
  const html = render(
    <Checklist
      class="x"
      steps={[
        {
          state: 'done',
          title: 'Sign in with Cloudflare Access',
          why: 'You are signed in as Maya Chen, Owner.',
          action: { href: '/never', label: 'Never shown' },
        },
        {
          state: 'next',
          title: 'Add a service token',
          why: 'tokengate keeps the secret; CI jobs never see it.',
          action: { href: '/admin/tokens/new', label: 'Add token' },
          quick: [
            { href: '/admin/tokens/new?type=slack', label: 'Slack', logo: { brand: 'slack' } },
            { href: '/admin/tokens/new?type=custom', label: 'Other API' },
          ],
          quickLabel: 'Token types',
        },
        {
          state: 'todo',
          title: 'Add a service consumer and give it access',
          why: 'Trust your CI system.',
          action: { href: '/admin/consumers/new', label: 'Add consumer' },
        },
      ]}
    />,
  );

  it('marks done and next steps and numbers the rest', () => {
    expect(
      html.startsWith(
        '<ol class="checklist x"><li class="is-done"><span class="no" aria-hidden="true">✓</span><h3>Sign in with Cloudflare Access <span class="badge ok"><span aria-hidden="true">✓ </span>Done</span></h3>',
      ),
    ).toBe(true);
    expect(html).toContain(
      '<li class="is-next"><span class="no" aria-hidden="true">2</span><h3>Add a service token <span class="badge">To do</span></h3><p class="why">tokengate keeps the secret; CI jobs never see it.</p>',
    );
    expect(html).toContain('<li><span class="no" aria-hidden="true">3</span>');
  });

  it('gives only the next step the primary button and done steps none', () => {
    expect(html.match(/btn primary/g)).toHaveLength(1);
    expect(html).toContain(
      '<div class="acts"><a class="btn primary" href="/admin/tokens/new">Add token</a></div>',
    );
    expect(html).toContain('<a class="btn secondary" href="/admin/consumers/new">Add consumer</a>');
    expect(html).not.toContain('Never shown');
  });

  it('renders quick links as a named nav', () => {
    expect(html).toContain(
      '<div class="wide"><nav class="quick" aria-label="Token types"><a class="q" href="/admin/tokens/new?type=slack"><span class="logo xs lg-slack" aria-hidden="true">S</span>Slack</a><a class="q" href="/admin/tokens/new?type=custom">Other API</a></nav></div>',
    );
  });
});

describe('ChecklistProgress', () => {
  it('draws a hidden bar and says the count', () => {
    expect(render(<ChecklistProgress done={1} total={3} class="x" />)).toBe(
      '<span class="progress x" aria-hidden="true"><i class="on"></i><i></i><i></i></span><span class="meta">1 of 3 done</span>',
    );
  });
});

describe('SplitView', () => {
  const html = render(
    <SplitView
      id="rq"
      label="Requests, newest first"
      title="POST /chat.postMessage"
      meta="req_01JB8Z5K2Q7W3N4M6P8R9T0V1X · 14:03:22 UTC"
      actions={
        <a class="btn sm secondary" href="/admin/requests/req_1">
          Open
        </a>
      }
      listFooter="Showing 1–25 of 8,214"
      class="x"
      items={[
        {
          href: '?req=req_1',
          title: 'POST /chat.postMessage',
          outcome: { tone: 'bad', word: 'Denied', code: '403' },
          time: '14:03:22',
          datetime: '2026-10-15T14:03:22Z',
          meta: 'acme/web → slack',
          current: true,
        },
        {
          href: '?req=req_2',
          title: 'POST /v1/chat/completions',
          outcome: { tone: 'ok', word: 'Allowed' },
        },
        { href: '?req=req_3', title: '<script>' },
      ]}
    >
      <p>Detail</p>
    </SplitView>,
  );

  it('renders the list as a named nav of links with the current one marked', () => {
    expect(
      html.startsWith(
        '<div class="split x" id="rq"><nav class="split-list" aria-label="Requests, newest first"><ol class="split-items"><li><a class="split-item" href="?req=req_1" aria-current="page">',
      ),
    ).toBe(true);
    expect(html.match(/aria-current/g)).toHaveLength(1);
  });

  it('shows outcome, code and time on the first line', () => {
    expect(html).toContain(
      '<span class="split-top"><span class="res bad"><span class="dot bad" aria-hidden="true"></span>Denied <span class="code">403</span></span><time class="time" datetime="2026-10-15T14:03:22Z">14:03:22</time></span><span class="split-t mono">POST /chat.postMessage</span><span class="meta">acme/web → slack</span>',
    );
    expect(html).toContain(
      '<span class="res ok"><span class="dot" aria-hidden="true"></span>Allowed</span>',
    );
    expect(html).toContain(
      '<a class="split-item" href="?req=req_3"><span class="split-t mono">&lt;script&gt;</span></a>',
    );
  });

  it('labels the pane with its heading and renders the detail', () => {
    expect(html).toContain('<div class="split-f">Showing 1–25 of 8,214</div></nav>');
    expect(html).toContain(
      '<section class="split-pane" aria-labelledby="rq-h"><div class="split-h"><div class="t"><h2 id="rq-h">POST /chat.postMessage</h2><p class="meta">req_01JB8Z5K2Q7W3N4M6P8R9T0V1X · 14:03:22 UTC</p></div><div class="end"><a class="btn sm secondary" href="/admin/requests/req_1">Open</a></div></div><div class="split-b"><p>Detail</p></div></section></div>',
    );
  });

  it('takes heading level 3', () => {
    const h3 = render(<SplitView id="s" label="l" title="t" level={3} items={[]} />);
    expect(h3).toContain('<h3 id="s-h">t</h3>');
  });
});
