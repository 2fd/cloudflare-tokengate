import { ErrorSummary, Field, FieldSet, Input, Picks } from '@tokengate/ui';
import type { ComponentDoc } from '../types';
import { expiries } from './data';

export const errorSummary: ComponentDoc = {
  slug: 'error-summary',
  name: 'ErrorSummary',
  summary:
    'The GOV.UK error summary: a bad callout at the top of a re-rendered form, focused on load, with one link per field error.',
  usage: {
    when: [
      'The server rejected a submit: re-render the same page with the values kept, an ErrorSummary first, and the inline errors.',
      'Always render it with the list of errors; it renders nothing when the list is empty.',
    ],
    whenNot: [
      'One problem that is not about a field (an upstream check failed): a bad callout with what to do next.',
      'A success: a notice.',
    ],
  },
  examples: [
    {
      title: 'Two field errors',
      description:
        'Each link moves to its field; the words match the inline errors. In a page it takes focus on load; on this docs page autofocus is off so the page does not jump.',
      layout: 'stack',
      render: () => (
        <>
          <ErrorSummary
            id="es-add"
            autofocus={false}
            errors={[
              {
                target: 'es-repo',
                message: 'Enter the repository as owner/name (ID): acme/api (89012345)',
              },
              { target: 'es-exp-1', message: 'Choose when the access expires' },
            ]}
          />
          <div class="fields">
            <Field
              id="es-repo"
              label="Repository name (ID)"
              error="Enter the repository as owner/name (ID): acme/api (89012345)"
            >
              <Input name="repository" mono value="acme/api" />
            </Field>
            <FieldSet id="es-exp" legend="Expires" error="Choose when the access expires">
              <Picks name="es-exp" options={expiries} />
            </FieldSet>
          </div>
        </>
      ),
      code: `<ErrorSummary errors={[
  { target: 'repo', message: 'Enter the repository as owner/name (ID): acme/api (89012345)' },
  { target: 'exp-1', message: 'Choose when the access expires' },
]} />
<div class="fields">
  <Field id="repo" label="Repository name (ID)"
    error="Enter the repository as owner/name (ID): acme/api (89012345)">
    <Input name="repository" mono value="acme/api" />
  </Field>
  <FieldSet id="exp" legend="Expires" error="Choose when the access expires">
    <Picks name="exp" options={expiries} />
  </FieldSet>
</div>`,
    },
    {
      title: 'With a title and a description',
      description: 'Say what was not saved and what is kept.',
      layout: 'stack',
      render: () => (
        <>
          <ErrorSummary
            id="es-tok"
            autofocus={false}
            title="The token was not saved"
            description="Your secret is kept for 15 minutes, so you do not need to paste it again."
            errors={[{ target: 'es-cred', message: 'Slack rejected the secret: invalid_auth' }]}
          />
          <div class="fields">
            <Field
              id="es-cred"
              label="Bot token"
              error="Slack rejected the secret: invalid_auth"
              note="Secret kept for 15 minutes (…9fQa). Leave this field empty to use it, or enter another."
            >
              <Input name="credential" secret placeholder="xoxb-0000…" />
            </Field>
          </div>
        </>
      ),
      code: `<ErrorSummary title="The token was not saved"
  description="Your secret is kept for 15 minutes, so you do not need to paste it again."
  errors={[{ target: 'credential', message: 'Slack rejected the secret: invalid_auth' }]} />
…
<Field id="credential" label="Bot token" error="Slack rejected the secret: invalid_auth"
  note="Secret kept for 15 minutes (…9fQa). Leave this field empty to use it, or enter another.">
  <Input name="credential" secret placeholder="xoxb-0000…" />
</Field>`,
    },
    {
      title: 'Form-level error (no link)',
      description:
        'An error that is not about one field (the upstream check failed, a row that is not on the page) has no target: it is plain text, not a link.',
      layout: 'stack',
      render: () => (
        <ErrorSummary
          id="es-form"
          autofocus={false}
          title="The access was not saved"
          errors={[
            { message: 'GitHub did not answer the permission check. Try again in a minute.' },
            { target: 'es-repo', message: 'Enter the repository as owner/name (ID)' },
          ]}
        />
      ),
      code: `<ErrorSummary title="The access was not saved" errors={[
  { message: 'GitHub did not answer the permission check. Try again in a minute.' },
  { target: 'repo', message: 'Enter the repository as owner/name (ID)' },
]} />`,
    },
    {
      title: 'No errors',
      description: 'An empty list renders nothing, so a form page can always include it.',
      render: () => (
        <>
          <ErrorSummary errors={[]} />
          <span class="hint">(nothing rendered)</span>
        </>
      ),
      code: `<ErrorSummary errors={[]} />`,
    },
  ],
  props: [
    {
      component: 'ErrorSummary',
      props: [
        {
          name: 'errors',
          type: 'readonly { target?: string; message: Child }[]',
          required: true,
          description:
            'In page order. target is the control id; for a FieldSet use `${id}-1`. Without a target the entry is plain text (a form-level error).',
        },
        { name: 'title', type: 'Child', default: "'There is a problem'", description: 'Heading.' },
        { name: 'description', type: 'Child', description: 'Sentence under the heading.' },
        {
          name: 'id',
          type: 'string',
          default: "'error-summary'",
          description: 'Id; heading `${id}-h`.',
        },
        { name: 'autofocus', type: 'boolean', default: 'true', description: 'Focus it on load.' },
        {
          name: 'role',
          type: "'alert' | 'group'",
          default: "'group'",
          description:
            'group: focus on load already announces it. alert: only with autofocus={false}, or it is announced twice.',
        },
        { name: 'headingLevel', type: '2 | 3 | 4', default: '2', description: 'Heading level.' },
        { name: 'class', type: 'string', description: 'Extra classes.' },
      ],
    },
  ],
  accessibility: [
    'autofocus on a tabindex="-1" container labelled by its heading: it is focused and announced on load, without JS, so keyboard and screen reader users start at the problems.',
    'role="group" by default, not alert: the focus already announces it, and alert together with autofocus announces it twice. Use role="alert" only for a summary rendered with autofocus={false}.',
    'An entry without a target is plain text: a link must lead somewhere, and a form-level error has no field.',
    'Labelled by its heading; the ✕ glyph is hidden.',
    'Each entry is a link to the control: activating it moves focus there (for a group, to its first option).',
    'Link text matches the inline error, so people recognise the field when they get there.',
  ],
  do: [
    'Put it first in the page, above the form, after the header.',
    'List every error, in the order of the fields.',
    'Keep the values the person entered.',
  ],
  dont: [
    'Do not show it before a submit.',
    'Do not write different words than the inline errors.',
    'Do not use two on one page.',
  ],
  classes: ['callout', 'bad', 'errsum', 'gl', 'body'],
};
