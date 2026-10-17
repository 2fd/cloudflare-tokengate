import { CheckPresets, FieldSet, LiveForm, SelectedCount } from '@tokengate/ui';
import type { ComponentDoc } from '../types';
import { slackOperations } from './data';

export const checkPresets: ComponentDoc = {
  slug: 'check-presets',
  name: 'CheckPresets',
  related: ['SelectedCount'],
  summary:
    'Checkbox presets: named groups of API calls, each with its endpoints in mono, and a CSS-only count.',
  usage: {
    when: [
      'Choose what a consumer may call: presets of a token type (“Post messages”, “Upload files”).',
      'Several independent yes/no options of the same kind, each with a technical detail.',
    ],
    whenNot: [
      <>
        One option: <code>Checkbox</code>.
      </>,
      <>
        One of several: <code>RadioCards</code> or <code>Picks</code>.
      </>,
    ],
  },
  examples: [
    {
      title: 'Presets with their calls',
      description: 'The default preset says so. Checked rows get the accent-soft background.',
      layout: 'stack',
      render: () => (
        <FieldSet
          id="cp-ops"
          legend="Allowed operations"
          hint="Other calls are denied and show up in Requests."
        >
          <CheckPresets name="cp-ops" options={slackOperations} value={['post']} />
        </FieldSet>
      ),
      code: `<FieldSet id="ops" legend="Allowed operations" hint="Other calls are denied and show up in Requests.">
  <CheckPresets name="operations" value={['post']} options={[
    { value: 'post', title: 'Post messages', note: '(default)', code: 'POST /chat.postMessage' },
    { value: 'edit', title: 'Update and delete messages', code: 'POST /chat.update · POST /chat.delete' },
    { value: 'upload', title: 'Upload files', code: 'POST /files.getUploadURLExternal' },
    { value: 'channels', title: 'Read channel list', code: 'GET /conversations.list' },
  ]} />
</FieldSet>`,
    },
    {
      title: 'Selected count',
      description:
        'Inside a LiveForm, a FieldSet with countScope counts its checked boxes with a CSS counter: try it.',
      layout: 'stack',
      render: () => (
        <LiveForm method="get">
          <FieldSet id="cp-count" legend="Allowed operations" countScope>
            <CheckPresets name="cp-count" options={slackOperations} value={['post', 'upload']} />
            <SelectedCount total={4} />
          </FieldSet>
        </LiveForm>
      ),
      code: `<LiveForm method="post" action="/admin/access">
  <FieldSet id="ops" legend="Allowed operations" countScope>
    <CheckPresets name="operations" options={operations} value={['post', 'upload']} />
    <SelectedCount total={4} />
  </FieldSet>
</LiveForm>`,
    },
    {
      title: 'Disabled preset with a tag',
      layout: 'stack',
      render: () => (
        <FieldSet id="cp-off" legend="Allowed operations">
          <CheckPresets
            name="cp-off"
            value={['post']}
            options={[
              slackOperations[0] as (typeof slackOperations)[number],
              {
                value: 'admin',
                title: 'Manage the workspace',
                code: 'POST /admin.*',
                disabled: true,
                tag: <span class="risktag">Owners only</span>,
              },
            ]}
          />
        </FieldSet>
      ),
      code: `<CheckPresets name="operations" value={['post']} options={[
  { value: 'post', title: 'Post messages', note: '(default)', code: 'POST /chat.postMessage' },
  { value: 'admin', title: 'Manage the workspace', code: 'POST /admin.*', disabled: true,
    tag: <span class="risktag">Owners only</span> },
]} />`,
    },
  ],
  props: [
    {
      component: 'CheckPresets',
      props: [
        {
          name: 'name',
          type: 'string',
          required: true,
          description: 'Checkbox name shared by every preset.',
        },
        {
          name: 'options',
          type: 'readonly CheckPreset[]',
          required: true,
          description: (
            <code>{'{ value, title, note?, code?, tag?, risk?, disabled?, checked?, o? }'}</code>
          ),
        },
        { name: 'value', type: 'readonly string[]', description: 'Checked values.' },
        {
          name: 'id',
          type: 'string',
          description: 'Input id prefix; defaults to the FieldSet’s id.',
        },
        { name: 'class', type: 'string', description: 'Extra classes on .ops.' },
      ],
    },
    {
      component: 'SelectedCount',
      props: [
        {
          name: 'total',
          type: 'number',
          required: true,
          description: 'Number of boxes (“of 4 selected”).',
        },
        { name: 'class', type: 'string', description: 'Extra classes on the line.' },
      ],
    },
  ],
  accessibility: [
    'Native checkboxes in labels; each row is one click target with a focus ring.',
    'The endpoint line is part of the label, so it is read with the preset.',
    'The count is a CSS counter and hidden from assistive tech: screen readers read each box’s state instead.',
  ],
  do: [
    'Name presets for what they let the consumer do.',
    'Check the default preset on a new access.',
  ],
  dont: [
    'Do not use SelectedCount outside a LiveForm with countScope: it shows no number there.',
    'Do not list raw endpoints without a name.',
  ],
  classes: ['ops', 'op', 't', 'muted', 'count-scope', 'opsn'],
};
