import { describe, expect, it } from 'vitest';
import { Checklist, ChecklistProgress } from '../../src';
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
        '<ol class="checklist x"><li class="is-done"><span class="no" aria-hidden="true">✓</span><h3>Sign in with Cloudflare Access <span class="badge ok"><span aria-hidden="true">✓</span>Done</span></h3>',
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
