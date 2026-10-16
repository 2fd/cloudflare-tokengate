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
        <ErrorSummary
          id="es-tok"
          autofocus={false}
          title="The token was not saved"
          description="Your secret is kept for 15 minutes, so you do not need to paste it again."
          errors={[{ target: 'sl-cred', message: 'Slack rejected the secret: invalid_auth' }]}
        />
      ),
      code: `<ErrorSummary title="The token was not saved"
  description="Your secret is kept for 15 minutes, so you do not need to paste it again."
  errors={[{ target: 'credential', message: 'Slack rejected the secret: invalid_auth' }]} />`,
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
          type: 'readonly { target: string; message: Child }[]',
          required: true,
          description: 'In page order. target is the control id; for a FieldSet use `${id}-1`.',
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
        { name: 'headingLevel', type: '2 | 3', default: '2', description: 'Heading level.' },
        { name: 'class', type: 'string', description: 'Extra classes.' },
      ],
    },
  ],
  accessibility: [
    'role="alert" and autofocus on a tabindex="-1" container: it is announced and focused on load, without JS, so keyboard and screen reader users start at the problems.',
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
