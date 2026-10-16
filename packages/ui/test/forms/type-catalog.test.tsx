import { describe, expect, it } from 'vitest';
import { CatalogGroup, TypeCard, TypeCatalog } from '../../src';
import { render } from '../render';

const slack = (
  <span class="logo lg-slack" aria-hidden="true">
    S
  </span>
);

describe('TypeCatalog', () => {
  it('renders a labelled section with the catalog tray', () => {
    expect(
      render(
        <TypeCatalog
          id="types"
          title="Which API does this token unlock?"
          description="Ready-made types set the URL."
        >
          x
        </TypeCatalog>,
      ),
    ).toBe(
      '<section id="types" aria-labelledby="types-h"><div class="cat-list"><div class="tray-h"><div class="t"><h2 id="types-h">Which API does this token unlock?</h2><p>Ready-made types set the URL.</p></div></div>x</div></section>',
    );
    expect(
      render(
        <TypeCatalog id="t" title="T" headingLevel={3} class="x">
          x
        </TypeCatalog>,
      ),
    ).toContain(
      '<section class="x" id="t" aria-labelledby="t-h"><div class="cat-list"><div class="tray-h"><div class="t"><h3 class="h2" id="t-h">T</h3>',
    );
  });
});

describe('TypeCard', () => {
  it('renders an exclusive card whose body is the type form', () => {
    expect(
      render(
        <TypeCard
          name="token-type"
          id="type-slack"
          logo={slack}
          title="Slack Web API"
          description="slack.com/api · bot token xoxb-…"
          open
          action="/admin/tokens"
        >
          x
        </TypeCard>,
      ),
    ).toBe(
      '<details class="type-card" name="token-type" id="type-slack" open=""><summary><span class="logo lg-slack" aria-hidden="true">S</span><span><b>Slack Web API</b><small>slack.com/api · bot token xoxb-…</small></span><span class="sel" aria-hidden="true">✓ Selected</span><span class="chev" aria-hidden="true">›</span></summary><form class="type-body fields" method="post" action="/admin/tokens">x</form></details>',
    );
  });

  it('renders a closed card with a div body, the form layout and the class', () => {
    const html = render(
      <TypeCard name="n" id="c" logo={slack} title="Custom API" layout="form-layout" class="x">
        x
      </TypeCard>,
    );
    expect(html).toMatch(/^<details class="type-card x" name="n" id="c"><summary>/);
    expect(html).toContain('<div class="type-body form-layout">x</div>');
  });

  it('escapes the title', () => {
    expect(
      render(
        <TypeCard name="n" id="c" logo={slack} title="<b>">
          x
        </TypeCard>,
      ),
    ).toContain('<b>&lt;b&gt;</b>');
  });
});

describe('CatalogGroup', () => {
  it('renders a group heading', () => {
    expect(render(<CatalogGroup>Chat</CatalogGroup>)).toBe('<h3 class="cat-group">Chat</h3>');
    expect(
      render(
        <CatalogGroup level={4} class="x">
          AI
        </CatalogGroup>,
      ),
    ).toBe('<h4 class="cat-group x">AI</h4>');
  });
});
