import {
  CheckPresets,
  FieldSet,
  FormStep,
  Inherit,
  Picks,
  RowPicker,
  Stepper,
} from '@tokengate/ui';
import type { ComponentDoc } from '../types';
import { consumers, expiries, repositories, slackOperations } from './data';

export const stepper: ComponentDoc = {
  slug: 'stepper',
  name: 'Stepper',
  related: ['FormStep'],
  summary:
    'Numbered sections of one form on one page, joined by a line: each step is one decision.',
  usage: {
    when: [
      'A form with 3–5 decisions in a fixed order: consumer, which jobs, operations, expiry.',
      'Each step is a question (fieldset step) or a few related fields under a heading (group step).',
    ],
    whenNot: [
      'One or two fields: a plain .fields stack.',
      'Steps on separate pages: keep the task on one page with a summary rail.',
    ],
  },
  examples: [
    {
      title: 'Fieldset and group steps',
      description:
        'Steps 1, 3 and 4 are one question each: the title is the legend, read as “Step 1: Consumer”. Step 2 holds several fields under a heading.',
      layout: 'stack',
      render: () => (
        <Stepper>
          <FormStep n={1} title="Credential access rule" id="sp-consumer">
            <RowPicker name="sp-consumer" options={consumers} value="gha-acme" />
            <a class="btn ghost sm" href="?new=consumer">
              + Add a new credential access rule
            </a>
          </FormStep>
          <FormStep
            n={2}
            kind="group"
            id="sp-jobs"
            title="Which jobs"
            description="Only repositories of the acme organization can match."
          >
            <FieldSet id="sp-repo" legend="Repository">
              <RowPicker name="sp-repo" options={repositories.slice(0, 2)} value="89012345" />
            </FieldSet>
          </FormStep>
          <FormStep
            n={3}
            title="Allowed operations"
            id="sp-ops"
            description="Presets for the Slack Web API."
          >
            <CheckPresets name="sp-ops" options={slackOperations.slice(0, 2)} value={['post']} />
          </FormStep>
          <FormStep n={4} title="Expires" id="sp-exp">
            <Picks name="sp-exp" options={expiries} value="never" />
          </FormStep>
        </Stepper>
      ),
      code: `<Stepper>
  <FormStep n={1} title="Credential access rule" id="consumer">
    <RowPicker name="consumer" options={consumers} value="gha-acme" />
    <a class="btn ghost sm" href="/admin/credential-access-rules/new">+ Add a new credential access rule</a>
  </FormStep>
  <FormStep n={2} kind="group" id="jobs" title="Which jobs"
    description="Only repositories of the acme organization can match.">
    <FieldSet id="repo" legend="Repository">
      <RowPicker name="repo" options={repositories} value="89012345" />
    </FieldSet>
  </FormStep>
  <FormStep n={3} title="Allowed operations" id="ops" description="Presets for the Slack Web API.">
    <CheckPresets name="operations" options={operations} value={['post']} />
  </FormStep>
  <FormStep n={4} title="Expires" id="exp">
    <Picks name="exp" options={expiries} value="never" />
  </FormStep>
</Stepper>`,
    },
    {
      title: 'Step with an error',
      description:
        'A fieldset step takes a hint and the server’s error, like a FieldSet: after the description, and both describe the fieldset. A group step holds Fields with their own errors.',
      layout: 'stack',
      render: () => (
        <Stepper>
          <FormStep
            n={3}
            title="Allowed operations"
            id="sp-ops-bad"
            description="Presets for the Slack Web API."
            hint="Pick every preset the workflow needs."
            error="Choose at least one operation"
          >
            <CheckPresets name="sp-ops-bad" options={slackOperations.slice(0, 2)} />
          </FormStep>
        </Stepper>
      ),
      code: `<FormStep n={3} title="Allowed operations" id="ops"
  description="Presets for the Slack Web API."
  hint="Pick every preset the workflow needs."
  error="Choose at least one operation">
  <CheckPresets name="operations" options={operations} />
</FormStep>`,
    },
    {
      title: 'Done and current',
      description:
        'For pages that track progress. Done steps read “Step 1, done:”; the current step has aria-current="step". The give-access page keeps every step equal.',
      layout: 'stack',
      render: () => (
        <Stepper>
          <FormStep
            n={1}
            kind="group"
            title="Token loaded"
            state="done"
            description="Slack · secret checked with GET /auth.test."
          >
            <Inherit>
              Saved as <b>Slack</b>: consumers call <span class="mono">/proxy/slack</span>
            </Inherit>
          </FormStep>
          <FormStep n={2} title="Add issuer access rule" state="current" id="sp-next">
            <RowPicker name="sp-next" options={consumers.slice(0, 2)} />
          </FormStep>
          <FormStep
            n={3}
            kind="group"
            title="Add the step to the workflow"
            description="The snippet appears after access is given."
          >
            <p class="hint">Nothing to do yet.</p>
          </FormStep>
        </Stepper>
      ),
      code: `<Stepper>
  <FormStep n={1} kind="group" title="Token loaded" state="done" description="Slack · secret checked …">
    <Inherit>Saved as <b>Slack</b>: consumers call <span class="mono">/proxy/slack</span></Inherit>
  </FormStep>
  <FormStep n={2} title="Add issuer access rule" state="current" id="next">
    <RowPicker name="next" options={consumers} />
  </FormStep>
  <FormStep n={3} kind="group" title="Add the step to the workflow" description="…">
    <p class="hint">Nothing to do yet.</p>
  </FormStep>
</Stepper>`,
    },
  ],
  props: [
    {
      component: 'Stepper',
      props: [
        { name: 'class', type: 'string', description: 'Extra classes on the ol.' },
        {
          name: 'children',
          type: 'Child',
          required: true,
          description: 'FormStep items in order.',
        },
      ],
    },
    {
      component: 'FormStep',
      props: [
        {
          name: 'n',
          type: 'number',
          required: true,
          description: 'Step number (circle and “Step N:”).',
        },
        { name: 'title', type: 'Child', required: true, description: 'Legend or heading.' },
        { name: 'description', type: 'Child', description: 'One line under the title.' },
        {
          name: 'hint',
          type: 'Child',
          description: 'Fieldset step: hint after the description (`${id}-hint`). Needs id.',
        },
        {
          name: 'error',
          type: 'Child',
          description:
            'Fieldset step: the server’s error, above the choices (`${id}-error`). Needs id.',
        },
        {
          name: 'kind',
          type: "'fieldset' | 'group'",
          default: "'fieldset'",
          description: 'One question (legend), or several fields under a heading.',
        },
        {
          name: 'headingLevel',
          type: '2 | 3 | 4',
          default: '2',
          description: 'Heading level of a group step.',
        },
        { name: 'state', type: "'current' | 'done'", description: 'Progress state.' },
        {
          name: 'live',
          type: 'LiveSlot (1–8)',
          description: 'Live-form field slot of a fieldset step.',
        },
        {
          name: 'countScope',
          type: 'boolean',
          description: 'Counts checked boxes for a SelectedCount.',
        },
        {
          name: 'id',
          type: 'string',
          description:
            'Fieldset step: id prefix of its choices. Group step: labelled by `${id}-h`.',
        },
        { name: 'class', type: 'string', description: 'Extra classes on the li.' },
        { name: 'children', type: 'Child', required: true, description: 'The step content.' },
      ],
    },
  ],
  accessibility: [
    'An ordered list: screen readers announce the number of steps.',
    'The number circle is decorative; the legend or heading starts with a hidden “Step N:”.',
    'A fieldset step groups its choices under the legend; a group step with an id is a labelled group.',
    'A fieldset step’s hint and error describe the fieldset (aria-describedby), as on a FieldSet.',
    'The current step has aria-current="step"; a done step says “done” in words.',
  ],
  do: ['Keep one decision per step.', 'Put the summary of all steps in a LiveSummary rail.'],
  dont: [
    'Do not split one task over several pages.',
    'Do not mark steps done on a form where every step stays editable.',
  ],
  classes: [
    'stepper',
    'fstep',
    'fstep-n',
    'fstep-b',
    'fstep-t',
    'is-current',
    'is-done',
    'hint',
    'field-error',
  ],
};
