// GroupRow and RailFoot.
import { describe, expect, it } from 'vitest';
import { GroupRow, RailFoot } from '../../src';
import { render } from '../render';

describe('GroupRow', () => {
  it('is a row-group header spanning the table, with an action', () => {
    expect(
      render(
        <GroupRow
          colspan={3}
          actions={
            <a class="btn ghost sm" href="#">
              + Give access
            </a>
          }
          class="x"
        >
          <span class="mono">acme/api</span>
        </GroupRow>,
      ),
    ).toBe(
      '<tr class="grp x"><th colspan="3" scope="rowgroup"><span class="grp-in"><span><span class="mono">acme/api</span></span><a class="btn ghost sm" href="#">+ Give access</a></span></th></tr>',
    );
  });
});

describe('RailFoot', () => {
  it('is the last line of a rail panel', () => {
    expect(render(<RailFoot>link</RailFoot>)).toBe('<p class="rail-foot">link</p>');
  });
});
