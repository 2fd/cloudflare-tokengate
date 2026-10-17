import { describe, expect, it } from 'vitest';
import { DangerRow, DangerZone, Disclosure } from '../../src';
import { render } from '../render';

describe('DangerZone', () => {
  const html = render(
    <DangerZone id="danger" class="x">
      <DangerRow
        title="Disable Slack"
        description="Calls stop at once."
        action={
          <button class="btn secondary" type="submit">
            Disable
          </button>
        }
      />
      <DangerRow title="Delete Slack" action="b" class="y" />
    </DangerZone>,
  );

  it('is a labelled danger-zone tray with one flush panel', () => {
    expect(html).toMatch(
      /^<section class="tray danger-zone x" id="danger" aria-labelledby="danger-h">/,
    );
    expect(html).toContain('<h2 id="danger-h">Danger zone</h2>');
    expect(html).toContain('<div class="panel flush"><div class="dz-row">');
  });

  it('renders rows as h3 + consequence, then the action', () => {
    expect(html).toContain(
      '<div class="dz-row"><div><h3>Disable Slack</h3><p>Calls stop at once.</p></div><button class="btn secondary" type="submit">Disable</button></div>',
    );
    expect(html).toContain('<div class="dz-row y"><div><h3>Delete Slack</h3></div>b</div>');
  });

  it('takes another title', () => {
    expect(
      render(
        <DangerZone id="d" title="Remove">
          x
        </DangerZone>,
      ),
    ).toContain('<h2 id="d-h">Remove</h2>');
  });

  it('shows a description under the title, and none by default', () => {
    expect(
      render(
        <DangerZone id="d" description="Stop Tom from using the console.">
          x
        </DangerZone>,
      ),
    ).toContain(
      '<div class="t"><h2 id="d-h">Danger zone</h2><p>Stop Tom from using the console.</p></div>',
    );
    expect(html).toContain('<div class="t"><h2 id="danger-h">Danger zone</h2></div>');
  });
});

describe('Disclosure', () => {
  it('renders a closed disc with a hint', () => {
    expect(
      render(
        <Disclosure summary="Advanced trust settings" hint="issuer, audience">
          body
        </Disclosure>,
      ),
    ).toBe(
      '<details class="disc"><summary>Advanced trust settings <span class="hint">issuer, audience</span></summary><div class="disc-b">body</div></details>',
    );
  });

  it('renders the more variant open, with id, name and classes', () => {
    expect(
      render(
        <Disclosure
          variant="more"
          summary="More constraints"
          hint="workflow pin"
          open
          id="m"
          name="g"
          class="x"
        >
          f
        </Disclosure>,
      ),
    ).toBe(
      '<details class="more x" id="m" name="g" open=""><summary>More constraints <span class="meta">workflow pin</span></summary><div class="more-b">f</div></details>',
    );
  });
});
