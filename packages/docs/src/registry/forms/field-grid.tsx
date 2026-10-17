import { Field, FieldGrid, Input } from '@tokengate/ui';
import type { ComponentDoc } from '../types';

export const fieldGrid: ComponentDoc = {
  slug: 'field-grid',
  name: 'FieldGrid',
  summary: 'Up to three short fields in one row (Name · Slug · Expires), one column below 48rem.',
  usage: {
    when: [
      'Optional details that belong together and are short: name, slug and expiry of a token.',
    ],
    whenNot: [
      'Required fields or long values: one Field per row, in order.',
      'Choices: a FieldSet with radio cards or picks.',
    ],
  },
  examples: [
    {
      title: 'Three optional fields',
      layout: 'stack',
      render: () => (
        <FieldGrid>
          <Field id="fg-name" label="Name" optional>
            <Input name="name" placeholder="Slack" />
          </Field>
          <Field id="fg-slug" label="Slug" optional hint="In the proxy URL.">
            <Input name="slug" mono placeholder="slack" />
          </Field>
          <Field id="fg-exp" label="Expires" optional>
            <Input name="credential_expires_at" type="date" />
          </Field>
          <Field id="fg-note" label="Note" optional class="span-all">
            <Input name="note" placeholder="Why this token exists" />
          </Field>
        </FieldGrid>
      ),
      code: `<FieldGrid>
  <Field id="name" label="Name" optional><Input name="name" placeholder="Slack" /></Field>
  <Field id="slug" label="Slug" optional hint="In the proxy URL."><Input name="slug" mono placeholder="slack" /></Field>
  <Field id="expires" label="Expires" optional><Input name="credential_expires_at" type="date" /></Field>
  <Field id="note" label="Note" optional class="span-all"><Input name="note" /></Field>
</FieldGrid>`,
    },
  ],
  props: [
    {
      component: 'FieldGrid',
      props: [
        { name: 'class', type: 'string', description: 'Extra classes on .fgrid.' },
        {
          name: 'children',
          type: 'Child',
          required: true,
          description: 'Short Fields; one with class="span-all" takes the whole row.',
        },
      ],
    },
  ],
  accessibility: [
    'The fields stay in reading order: left to right, then the next row.',
    'Each Field keeps its own label, hint and error.',
  ],
  do: ['Keep it to short, optional values.'],
  dont: ['Do not put a required field in the middle of a row, where it is easy to miss.'],
  classes: ['fgrid', 'span-all', 'field'],
};
