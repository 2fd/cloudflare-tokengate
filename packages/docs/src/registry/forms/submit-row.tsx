import { SubmitRow } from '@tokengate/ui';
import type { ComponentDoc } from '../types';

export const submitRow: ComponentDoc = {
  slug: 'submit-row',
  name: 'SubmitRow',
  summary:
    'The last row of a form: the primary submit, then Cancel or a second submit, then a hint.',
  usage: {
    when: [
      'The end of every form.',
      'A second way to submit after a failed check (“Save without a passing check”).',
    ],
    whenNot: ['Page actions: they go in the page header.', 'Dialog buttons: the dialog footer.'],
  },
  examples: [
    {
      title: 'Primary, Cancel, hint',
      layout: 'stack',
      render: () => (
        <SubmitRow hint="After saving you get the workflow snippet for these jobs.">
          <button class="btn primary" type="submit">
            Give access
          </button>
          <a class="btn secondary" href="?cancel">
            Cancel
          </a>
        </SubmitRow>
      ),
      code: `<SubmitRow hint="After saving you get the workflow snippet for these jobs.">
  <button class="btn primary" type="submit">Give access</button>
  <a class="btn secondary" href="/admin/credentials/slack">Cancel</a>
</SubmitRow>`,
    },
    {
      title: 'Two submits after a failed check',
      description: 'The id is the target of the error callout link “Check again or save anyway”.',
      layout: 'stack',
      render: () => (
        <SubmitRow
          id="sr-act"
          hint="Saving without a passing check stores the secret as it is. The token page shows “Check failed” until a test passes."
        >
          <button class="btn primary" type="submit">
            Check again and save
          </button>
          <button class="btn secondary" type="submit" name="save_anyway" value="1">
            Save without a passing check
          </button>
        </SubmitRow>
      ),
      code: `<SubmitRow id="actions"
  hint="Saving without a passing check stores the secret as it is. The token page shows “Check failed” until a test passes.">
  <button class="btn primary" type="submit">Check again and save</button>
  <button class="btn secondary" type="submit" name="save_anyway" value="1">Save without a passing check</button>
</SubmitRow>`,
    },
    {
      title: 'Submit with a help link',
      layout: 'stack',
      render: () => (
        <SubmitRow>
          <button class="btn primary" type="submit">
            Check and save Slack
          </button>
          <a href="?help=bot-token">How to get a bot token</a>
        </SubmitRow>
      ),
      code: `<SubmitRow>
  <button class="btn primary" type="submit">Check and save Slack</button>
  <a href="/docs/tokens/slack#bot-token">How to get a bot token</a>
</SubmitRow>`,
    },
  ],
  props: [
    {
      component: 'SubmitRow',
      props: [
        {
          name: 'hint',
          type: 'Child',
          description: 'Line under the buttons: what happens after saving.',
        },
        { name: 'id', type: 'string', description: 'Target of a link to the actions.' },
        { name: 'class', type: 'string', description: 'Extra classes.' },
        {
          name: 'children',
          type: 'Child',
          required: true,
          description: 'Primary first, then the others.',
        },
      ],
    },
  ],
  accessibility: [
    'The primary submit comes first in the DOM and on screen, so it is the first button reached with Tab.',
    'Button labels name the outcome (“Give access”), never “OK” or “Submit”.',
    'The hint is plain text under the buttons; it is read in order after them.',
  ],
  do: ['Exactly one primary button per form.', 'Name the outcome on the button.'],
  dont: ['Do not put Cancel first.', 'Do not use an icon-only button.'],
  classes: ['submit-row', 'hint', 'btn', 'primary', 'secondary'],
};
