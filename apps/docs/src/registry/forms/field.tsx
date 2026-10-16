import { Field, FieldError, FieldSet, Input, Picks, Select, Textarea } from '@tokengate/ui';
import type { ComponentDoc } from '../types';
import { expiries } from './data';

export const field: ComponentDoc = {
  slug: 'field',
  name: 'Field',
  related: ['FieldSet', 'FieldError'],
  summary:
    'A labelled control with its hint and inline error, wired for assistive tech: label, hint, error, control, note.',
  usage: {
    when: [
      <>
        Every text input, select and textarea: <code>Field</code> gives the control its id,{' '}
        <code>aria-describedby</code> and <code>aria-invalid</code>.
      </>,
      <>
        A question answered by a group of choices (radio cards, rows, picks, presets):{' '}
        <code>FieldSet</code>, with the question as its legend.
      </>,
      'Stack fields in a .fields container: 24px between fields, 8px between label, hint and control.',
    ],
    whenNot: [
      <>
        A value the page already knows: derive it, or show it as a <code>FixedBar</code> or{' '}
        <code>Inherit</code> line.
      </>,
      <>
        A single checkbox: <code>Checkbox</code> carries its own label.
      </>,
    ],
  },
  examples: [
    {
      title: 'Label, hint and control',
      description: 'The hint says in words what to enter. It comes before the control.',
      layout: 'stack',
      render: () => (
        <div class="fields">
          <Field id="fd-name" label="Name" hint="Shown in lists and in the audit log.">
            <Input name="name" value="Slack" />
          </Field>
        </div>
      ),
      code: `<div class="fields">
  <Field id="name" label="Name" hint="Shown in lists and in the audit log.">
    <Input name="name" value="Slack" />
  </Field>
</div>`,
    },
    {
      title: 'Optional and needed for',
      description:
        'Fields are required unless marked. “(needed for …)” marks a field that only one choice needs.',
      layout: 'stack',
      render: () => (
        <div class="fields">
          <Field id="fd-note" label="Note" optional>
            <Textarea name="note" placeholder="Why this access exists" />
          </Field>
          <Field
            id="fd-branch"
            label="Branch"
            neededFor="Branch"
            hint="Without refs/heads/. A trailing * matches a prefix: release/*."
          >
            <Input name="branch" mono placeholder="main" />
          </Field>
        </div>
      ),
      code: `<Field id="note" label="Note" optional>
  <Textarea name="note" placeholder="Why this access exists" />
</Field>
<Field id="branch" label="Branch" neededFor="Branch"
  hint="Without refs/heads/. A trailing * matches a prefix: release/*.">
  <Input name="branch" mono placeholder="main" />
</Field>`,
    },
    {
      title: 'Inline error',
      description:
        'The server re-renders the form with the error above the control. The control gets aria-invalid and a 2px red border; the error is read with it.',
      layout: 'stack',
      render: () => (
        <div class="fields">
          <Field
            id="fd-cred"
            label="Bot token"
            hint="In Slack: OAuth & Permissions › Bot User OAuth Token. Starts with xoxb-."
            error="This does not look like a bot token. It must start with xoxb-."
          >
            <Input name="credential" secret value="xoxp-123" placeholder="xoxb-0000…" />
          </Field>
        </div>
      ),
      code: `<Field id="credential" label="Bot token"
  hint="In Slack: OAuth & Permissions › Bot User OAuth Token. Starts with xoxb-."
  error="This does not look like a bot token. It must start with xoxb-.">
  <Input name="credential" secret value="xoxp-123" placeholder="xoxb-0000…" />
</Field>`,
    },
    {
      title: 'Note after the control',
      description:
        'A note describes the control too: a kept draft after a failed check, or what a derived value means.',
      layout: 'stack',
      render: () => (
        <div class="fields">
          <Field
            id="fd-draft"
            label="Bot token"
            error="Slack answered invalid_auth to GET /auth.test: the token was revoked, or it belongs to another workspace."
            note="Secret kept for 15 minutes (…9fQa, 51 characters). Leave this field empty to use it, or enter another."
          >
            <Input name="credential" secret placeholder="xoxb-0000…" />
          </Field>
          <Field id="fd-path" label="Proxy path" note="Derived from the name. Read-only.">
            <Input mono value="/proxy/slack" readonly />
          </Field>
        </div>
      ),
      code: `<Field id="credential" label="Bot token"
  error="Slack answered invalid_auth to GET /auth.test: …"
  note="Secret kept for 15 minutes (…9fQa, 51 characters). Leave this field empty to use it, or enter another.">
  <Input name="credential" secret placeholder="xoxb-0000…" />
</Field>
<Field id="path" label="Proxy path" note="Derived from the name. Read-only.">
  <Input mono value="/proxy/slack" readonly />
</Field>`,
    },
    {
      title: 'Select in a field',
      layout: 'stack',
      render: () => (
        <div class="fields">
          <Field id="fd-region" label="Upstream region" hint="Seven or more options: a select.">
            <Select
              name="region"
              value="eu-west-1"
              options={[
                { value: 'us-east-1', label: 'us-east-1' },
                { value: 'us-west-2', label: 'us-west-2' },
                { value: 'eu-west-1', label: 'eu-west-1' },
                { value: 'eu-central-1', label: 'eu-central-1' },
                { value: 'ap-south-1', label: 'ap-south-1' },
                { value: 'ap-northeast-1', label: 'ap-northeast-1' },
                { value: 'sa-east-1', label: 'sa-east-1' },
              ]}
            />
          </Field>
        </div>
      ),
      code: `<Field id="region" label="Upstream region" hint="Seven or more options: a select.">
  <Select name="region" value="eu-west-1" options={regions} />
</Field>`,
    },
    {
      title: 'FieldSet: a question with choices',
      description:
        'The legend is the question. Hint and error describe the fieldset; the choices take input ids from it (exp-1, exp-2 …).',
      layout: 'stack',
      render: () => (
        <div class="fields">
          <FieldSet id="fd-exp" legend="Expires" hint="Access stops at the end of the day (UTC).">
            <Picks name="fd-exp" options={expiries} value="never" />
          </FieldSet>
          <FieldSet id="fd-exp2" legend="Expires" error="Choose when the access expires.">
            <Picks name="fd-exp2" options={expiries} />
          </FieldSet>
        </div>
      ),
      code: `<FieldSet id="exp" legend="Expires" hint="Access stops at the end of the day (UTC).">
  <Picks name="exp" options={expiries} value="never" />
</FieldSet>
<FieldSet id="exp" legend="Expires" error="Choose when the access expires.">
  <Picks name="exp" options={expiries} />
</FieldSet>`,
    },
    {
      title: 'FieldError on its own',
      description: 'For a control written by hand: the same line, with its hidden “Error:” prefix.',
      render: () => <FieldError id="fd-own-error">Enter a repository name and its ID.</FieldError>,
      code: `<FieldError id="repo-error">Enter a repository name and its ID.</FieldError>`,
    },
  ],
  props: [
    {
      component: 'Field',
      props: [
        {
          name: 'id',
          type: 'string',
          required: true,
          description: (
            <>
              Id of the control. Hint, error and note get <code>{'${id}-hint'}</code>,{' '}
              <code>{'${id}-error'}</code>, <code>{'${id}-note'}</code>.
            </>
          ),
        },
        {
          name: 'label',
          type: 'Child',
          required: true,
          description: 'Visible label (label for=id).',
        },
        { name: 'optional', type: 'boolean', description: 'Adds “(optional)” after the label.' },
        {
          name: 'neededFor',
          type: 'string',
          description: 'Adds “(needed for …)”: a field only one choice needs.',
        },
        { name: 'hint', type: 'Child', description: 'Hint in words, before the control.' },
        {
          name: 'error',
          type: 'Child',
          description: 'Inline error, above the control. Sets aria-invalid on the control.',
        },
        {
          name: 'note',
          type: 'Child',
          description: 'Line after the control that also describes it.',
        },
        { name: 'class', type: 'string', description: 'Extra classes on the .field div.' },
        {
          name: 'children',
          type: 'Child',
          required: true,
          description: 'One Input, Select or Textarea. It reads its id and ARIA from the Field.',
        },
      ],
    },
    {
      component: 'FieldSet',
      props: [
        {
          name: 'id',
          type: 'string',
          required: true,
          description: (
            <>
              Id of the fieldset. Choices inside get input ids <code>{'${id}-1'}</code>,{' '}
              <code>{'${id}-2'}</code> …
            </>
          ),
        },
        { name: 'legend', type: 'Child', required: true, description: 'The question.' },
        { name: 'optional', type: 'boolean', description: 'Adds “(optional)” after the legend.' },
        { name: 'neededFor', type: 'string', description: 'Adds “(needed for …)”.' },
        {
          name: 'hint',
          type: 'Child',
          description: 'Hint under the legend; describes the fieldset.',
        },
        { name: 'error', type: 'Child', description: 'Inline error above the choices.' },
        {
          name: 'live',
          type: '1 | 2 | 3 | 4 | 5 | 6',
          description: 'Live-form field slot (.sfN). See LiveForm.',
        },
        {
          name: 'countScope',
          type: 'boolean',
          description: 'Counts the checked boxes inside for a SelectedCount.',
        },
        { name: 'class', type: 'string', description: 'Extra classes on the fieldset.' },
        { name: 'children', type: 'Child', required: true, description: 'The choices.' },
      ],
    },
    {
      component: 'FieldError',
      props: [
        { name: 'id', type: 'string', required: true, description: 'Referenced by the control.' },
        { name: 'children', type: 'Child', required: true, description: 'The error, in words.' },
      ],
    },
  ],
  accessibility: [
    'The label is a real label for the control; the legend names the group of choices.',
    'aria-describedby lists only the parts that are rendered: hint, error, note, in that order.',
    'An error sets aria-invalid="true"; its line starts with a hidden “Error:” and a decorative ✕, so color is never the only signal.',
    'Fields are required unless they say “(optional)”, so most labels stay short.',
  ],
  do: [
    'Write the hint in words, and the exact format in the placeholder (acme/api (89012345)).',
    'Use the same words in the inline error and in the ErrorSummary entry.',
    'Keep one control per Field.',
  ],
  dont: [
    'Do not use a placeholder as the label.',
    'Do not mark every field “(required)”; mark the optional ones.',
    'Do not put a FieldSet inside a Field.',
  ],
  classes: ['fields', 'field', 'opt', 'hint', 'field-error', 'vh'],
};
