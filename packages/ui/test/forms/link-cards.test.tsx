import { describe, expect, it } from 'vitest';
import { LinkCards } from '../../src';
import { render } from '../render';

describe('LinkCards', () => {
  it('renders one link per card with logo, meta, description and chevron', () => {
    expect(
      render(
        <LinkCards
          label="Token types"
          cards={[
            {
              href: '/admin/tokens/new?type=slack',
              title: 'Slack Web API',
              meta: '2 tokens',
              description: 'slack.com/api · bot token',
              logo: 'slack',
            },
          ]}
        />,
      ),
    ).toBe(
      '<ul class="tcards plain" aria-label="Token types"><li><a class="tcard" href="/admin/tokens/new?type=slack"><span class="logo lg-slack" aria-hidden="true">S</span><span class="t">Slack Web API<span class="faint"> · 2 tokens</span></span><span class="d">slack.com/api · bot token</span><span class="go" aria-hidden="true">›</span></a></li></ul>',
    );
  });

  it('renders a card without logo or description, and the class', () => {
    expect(render(<LinkCards class="x" cards={[{ href: '/a', title: 'Custom API' }]} />)).toBe(
      '<ul class="tcards plain x"><li><a class="tcard" href="/a"><span class="t">Custom API</span><span class="go" aria-hidden="true">›</span></a></li></ul>',
    );
  });

  it('escapes titles and hrefs', () => {
    const html = render(<LinkCards cards={[{ href: '/a?"b', title: '<b>' }]} />);
    expect(html).toContain('href="/a?&quot;b"');
    expect(html).toContain('&lt;b&gt;');
  });
});
