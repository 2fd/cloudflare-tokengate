import { describe, expect, it } from 'vitest';
import { EmptyState, Feed, FeedDay, FeedItem, Time, ZeroState } from '../../src';
import { render } from '../render';

const avatar = (
  <span class="avatar" aria-hidden="true">
    MC
  </span>
);

describe('Feed', () => {
  it('is an ordered list, compact in the rail', () => {
    expect(render(<Feed>x</Feed>)).toBe('<ol class="feed">x</ol>');
    expect(
      render(
        <Feed compact class="x">
          x
        </Feed>,
      ),
    ).toBe('<ol class="feed compact x">x</ol>');
  });
});

describe('FeedItem', () => {
  it('renders a one-line sentence without meta', () => {
    expect(
      render(
        <FeedItem avatar={avatar} time={<Time datetime="2026-10-15T09:12Z">09:12</Time>}>
          <b>Maya Chen</b> gave access
        </FeedItem>,
      ),
    ).toBe(
      '<li><span class="avatar" aria-hidden="true">MC</span><span class="s"><b>Maya Chen</b> gave access</span>' +
        '<time datetime="2026-10-15T09:12Z">09:12</time></li>',
    );
  });

  it('stacks the sentence, the meta line and the details', () => {
    const html = render(
      <FeedItem
        class="x"
        avatar={avatar}
        time="t"
        meta={<code>grant.update</code>}
        details={<details class="disc">d</details>}
      >
        Diego Ruiz extended it
      </FeedItem>,
    );
    expect(html).toBe(
      '<li class="x"><span class="avatar" aria-hidden="true">MC</span><div class="s"><p>Diego Ruiz extended it</p>' +
        '<p class="meta"><code>grant.update</code></p><details class="disc">d</details></div>t</li>',
    );
  });

  it('escapes the sentence', () => {
    expect(
      render(
        <FeedItem avatar="" time="">
          {'<img src=x>'}
        </FeedItem>,
      ),
    ).toContain('&lt;img src=x&gt;');
  });
});

describe('FeedDay', () => {
  it('is a heading with the day class', () => {
    expect(render(<FeedDay>Today, 15 Oct</FeedDay>)).toBe('<h3 class="day">Today, 15 Oct</h3>');
    expect(
      render(
        <FeedDay headingLevel={4} class="x">
          2 Oct
        </FeedDay>,
      ),
    ).toBe('<h4 class="day x">2 Oct</h4>');
  });
});

describe('EmptyState', () => {
  it('renders the hidden glyph, the heading, the text and the actions', () => {
    expect(
      render(
        <EmptyState
          icon="consumer"
          title="No consumer can use a token yet"
          description="Add issuer access rule."
          actions={
            <a class="btn primary" href="/admin/issuer-access-rules/new">
              Give access
            </a>
          }
        />,
      ),
    ).toBe(
      '<div class="empty"><span class="glyph" aria-hidden="true"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1.5"></rect><rect x="14" y="14" width="7" height="7" rx="1.5"></rect><path d="M10 6.5h4a3 3 0 0 1 3 3V14"></path></svg></span>' +
        '<h3>No consumer can use a token yet</h3><p>Add issuer access rule.</p>' +
        '<div class="btn-row"><a class="btn primary" href="/admin/issuer-access-rules/new">Give access</a></div></div>',
    );
  });

  it('renders just the title at another level, with a class', () => {
    expect(render(<EmptyState title="No requests" headingLevel={2} class="x" />)).toBe(
      '<div class="empty x"><h2>No requests</h2></div>',
    );
    expect(render(<EmptyState title="t" headingLevel={4} />)).toBe(
      '<div class="empty"><h4>t</h4></div>',
    );
  });
});

describe('ZeroState', () => {
  it('is one muted line', () => {
    expect(render(<ZeroState class="x">No denied calls in the last 24 hours.</ZeroState>)).toBe(
      '<p class="oneline x">No denied calls in the last 24 hours.</p>',
    );
  });
});
