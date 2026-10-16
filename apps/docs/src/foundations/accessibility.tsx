import { Panel, Tray } from '@tokengate/ui';
import type { Foundation } from './types';

export const accessibility: Foundation = {
  slug: 'accessibility',
  title: 'Accessibility',
  summary:
    'WCAG 2.2 AA in light and dark, with no client JavaScript. Components wire ids and ARIA from their props, so the accessible version is the default.',
  render: () => (
    <>
      <Tray id="dx-a-checklist" title="Checklist for every component and page">
        <Panel variant="pad">
          <ul class="dx-list">
            <li>
              Contrast: text ≥ 4.5:1, control borders, dots and the focus ring ≥ 3:1, in both
              schemes. Use the tokens only.
            </li>
            <li>Status is always text; color and glyphs only add to it.</li>
            <li>
              Focus is visible on every link, button, input, <code>summary</code> and radio card:
              3px <code>--focus</code> ring with a 2px offset.
            </li>
            <li>Every control has a visible label. No icon-only buttons.</li>
            <li>
              Targets are at least 24×24 with 8px gaps; regular controls are 40px tall, small ones
              32px.
            </li>
            <li>
              Pages reflow to one column at 320px with no page-level horizontal scroll. Wide tables
              and the matrix scroll inside a labelled, focusable region or stack into cards.
            </li>
            <li>
              One <code>main</code> per page, reached by the skip link; one H1; headings step down
              without gaps.
            </li>
            <li>
              Hints and errors are tied to their input with <code>aria-describedby</code>; only ids
              that are rendered are listed.
            </li>
            <li>
              Forced colors: panels, badges and chips keep a border; the current nav item and tab
              keep an outline.
            </li>
          </ul>
        </Panel>
      </Tray>
      <Tray
        id="dx-a-nojs"
        title="Interaction without JavaScript"
        description="The CSP has no script-src. These are the only techniques."
      >
        <Panel variant="pad">
          <ul class="dx-list">
            <li>
              Links and GET/POST forms; tabs and views are links with <code>aria-current</code>.
            </li>
            <li>
              <code>&lt;details&gt;</code> for disclosures, <code>&lt;details name&gt;</code> for
              exclusive accordions.
            </li>
            <li>
              <code>&lt;dialog&gt;</code> opened with{' '}
              <code>&lt;button type="button" commandfor="id" command="show-modal"&gt;</code>.
            </li>
            <li>
              Menus with <code>popover</code> / <code>popovertarget</code>. Never open a dialog from
              a popover.
            </li>
            <li>
              Live form state with <code>:has()</code>, <code>:checked</code> and{' '}
              <code>:user-invalid</code>. Never put <code>required</code> on a field in a hidden
              branch.
            </li>
            <li>
              <code>&lt;datalist&gt;</code> for suggestions, with the values also visible as choices
              or a suggestion line.
            </li>
            <li>
              Copy with <code>user-select: all</code> on IDs and snippets. Secrets are never
              revealed or copied.
            </li>
          </ul>
        </Panel>
      </Tray>
    </>
  ),
};
