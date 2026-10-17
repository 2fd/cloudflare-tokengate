import { Field, FieldSet, Input, Or, RowPicker } from '@tokengate/ui';
import type { ComponentDoc } from '../types';
import { consumers, repositories } from './data';

export const rowPicker: ComponentDoc = {
  slug: 'row-picker',
  name: 'RowPicker',
  related: ['Or'],
  summary:
    'Existing values as a list of radio rows, most used first, with a logo and a usage count.',
  usage: {
    when: [
      'Pick one of the values the server already knows: a consumer, a repository the consumer used before.',
      'End with a generic row (“Another repository”) that reveals a free-text field.',
    ],
    whenNot: [
      <>
        2–6 fixed options with explanations: <code>RadioCards</code>.
      </>,
      <>
        No known values yet: a free-text <code>Input</code> with an exact-format placeholder.
      </>,
    ],
  },
  examples: [
    {
      title: 'With logos',
      description: 'Consumers of the install, most used first.',
      layout: 'stack',
      render: () => (
        <FieldSet id="rp-consumer" legend="Consumer">
          <RowPicker name="rp-consumer" options={consumers} value="gha-acme" />
        </FieldSet>
      ),
      code: `<FieldSet id="consumer" legend="Consumer">
  <RowPicker name="consumer" value="gha-acme" options={[
    { value: 'gha-acme', title: 'GitHub Actions (acme)', meta: 'most used · 6 accesses',
      logo: 'github' },
    { value: 'gitlab-platform', title: 'GitLab CI (platform)', meta: '2 accesses', logo: … },
    { value: 'buildkite-acme', title: 'Buildkite (acme)', meta: '1 access', logo: … },
  ]} />
</FieldSet>`,
    },
    {
      title: 'Mono values with an ID, and a generic row',
      description:
        'Repository names in mono with the numeric ID muted. The last row has no meta and leads to a free-text field.',
      layout: 'stack',
      render: () => (
        <FieldSet
          id="rp-repo"
          legend="Repository"
          hint="Repositories this consumer used before, most used first. The ID keeps working after a rename."
        >
          <RowPicker name="rp-repo" options={repositories} value="89012345" />
        </FieldSet>
      ),
      code: `<FieldSet id="repo" legend="Repository"
  hint="Repositories this consumer used before, most used first. The ID keeps working after a rename.">
  <RowPicker name="repo" value="89012345" options={[
    { value: '89012345', title: 'acme/api', mono: true, detail: '(89012345)', meta: '3 accesses' },
    …
    { value: 'other', title: 'Another repository' },
  ]} />
</FieldSet>`,
    },
    {
      title: 'Disabled row',
      layout: 'stack',
      render: () => (
        <FieldSet id="rp-off" legend="Repository">
          <RowPicker
            name="rp-off"
            value="89012345"
            options={[
              {
                value: '89012345',
                title: 'acme/api',
                mono: true,
                detail: '(89012345)',
                meta: '3 accesses',
              },
              {
                value: '89012346',
                title: 'acme/web',
                mono: true,
                detail: '(89012346)',
                meta: 'already has Slack',
                disabled: true,
              },
            ]}
          />
        </FieldSet>
      ),
      code: `<RowPicker name="repo" value="89012345" options={[
  { value: '89012345', title: 'acme/api', mono: true, detail: '(89012345)', meta: '3 accesses' },
  { value: '89012346', title: 'acme/web', mono: true, detail: '(89012346)',
    meta: 'already has Slack', disabled: true },
]} />`,
    },
    {
      title: 'Known list, OR, generic value',
      description: 'The divider separates the known values from typing one in.',
      layout: 'stack',
      render: () => (
        <>
          <FieldSet id="rp-or" legend="Consumer">
            <RowPicker name="rp-or" options={consumers.slice(0, 2)} />
          </FieldSet>
          <Or />
          <Field id="rp-or-new" label="New consumer name">
            <Input name="new_consumer" placeholder="GitHub Actions (platform)" />
          </Field>
        </>
      ),
      code: `<FieldSet id="consumer" legend="Consumer">
  <RowPicker name="consumer" options={consumers} />
</FieldSet>
<Or />
<Field id="new-consumer" label="New consumer name">
  <Input name="new_consumer" placeholder="GitHub Actions (platform)" />
</Field>`,
    },
  ],
  props: [
    {
      component: 'RowPicker',
      props: [
        { name: 'name', type: 'string', required: true, description: 'Radio group name.' },
        {
          name: 'options',
          type: 'readonly RowPick[]',
          required: true,
          description: (
            <>
              <code>
                {'{ value, title, mono?, detail?, meta?, logo?, risk?, disabled?, checked?, o? }'}
              </code>
              . Rows without a logo get .nologo.
            </>
          ),
        },
        { name: 'value', type: 'string', description: 'The checked value.' },
        {
          name: 'id',
          type: 'string',
          description: 'Input id prefix; defaults to the FieldSet’s id.',
        },
        { name: 'required', type: 'boolean', description: 'Never inside a Reveal (it throws).' },
        {
          name: 'invalid',
          type: 'boolean',
          description:
            'The server rejected the group (the FieldSet or FormStep shows the error): the first enabled row gets aria-invalid, the ErrorSummary link target.',
        },
        { name: 'class', type: 'string', description: 'Extra classes on .rlist.' },
      ],
    },
    {
      component: 'Or',
      props: [
        { name: 'label', type: 'string', default: "'OR'", description: 'The divider word.' },
        { name: 'class', type: 'string', description: 'Extra classes.' },
      ],
    },
  ],
  accessibility: [
    'Each row is a label around a native radio; arrow keys move between rows.',
    'Logos are decorative (aria-hidden); the name is the text.',
    'The usage count is part of the label, so it is read with the value.',
    'The OR divider is hidden from assistive tech; the options are read in order.',
  ],
  do: [
    'Order rows by use, most used first, and say it in the hint.',
    'Show the stable ID next to a name that can change.',
  ],
  dont: [
    'Do not list values the person cannot pick; disable them and say why in the meta.',
    'Do not mix logo and no-logo rows in one list without reason.',
  ],
  classes: ['rlist', 'row-pick', 'nologo', 't', 'meta', 'muted', 'or'],
};
