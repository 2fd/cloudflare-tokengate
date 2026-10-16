import { FieldInline } from '@tokengate/ui';
import type { ComponentDoc } from '../types';

export const fieldInline: ComponentDoc = {
  slug: 'field-inline',
  name: 'FieldInline',
  summary:
    'A one-line lookup form: a leading label, a mono input and a trailing button in one 40px box.',
  usage: {
    when: ['Find one thing by its exact ID: “Find a request” by request ID or a pasted log line.'],
    whenNot: [
      'Filtering a table: a filter bar.',
      <>
        A field in a larger form: <code>Field</code> with an <code>Input</code>.
      </>,
    ],
  },
  examples: [
    {
      title: 'Under a visible title',
      description: 'The search landmark is named by the title above it.',
      layout: 'stack',
      render: () => (
        <div class="field">
          <span class="lbl" id="fi-find-l">
            Find a request
          </span>
          <FieldInline
            id="fi-find"
            label="Request ID"
            name="request"
            submit="Find"
            labelledBy="fi-find-l"
            action="/admin/requests"
            placeholder="req_01JB8Z5K2Q7W3N4M6P8R9T0V1X"
          />
          <span class="hint">Paste a request ID or the whole log line from CI.</span>
        </div>
      ),
      code: `<div class="field">
  <span class="lbl" id="find-l">Find a request</span>
  <FieldInline id="find" label="Request ID" name="request" submit="Find"
    labelledBy="find-l" action="/admin/requests"
    placeholder="req_01JB8Z5K2Q7W3N4M6P8R9T0V1X" />
  <span class="hint">Paste a request ID or the whole log line from CI.</span>
</div>`,
    },
    {
      title: 'With a value',
      description: 'The page re-renders with the searched ID in the box.',
      layout: 'stack',
      render: () => (
        <FieldInline
          id="fi-find2"
          label="Request ID"
          name="request"
          submit="Find"
          searchLabel="Find a request"
          action="/admin/requests"
          value="req_01JB8Z5K2Q7W3N4M6P8R9T0V1X"
        />
      ),
      code: `<FieldInline id="find" label="Request ID" name="request" submit="Find"
  searchLabel="Find a request" action="/admin/requests"
  value="req_01JB8Z5K2Q7W3N4M6P8R9T0V1X" />`,
    },
  ],
  props: [
    {
      component: 'FieldInline',
      props: [
        { name: 'id', type: 'string', required: true, description: 'Id of the input.' },
        {
          name: 'label',
          type: 'Child',
          required: true,
          description: 'Leading label inside the box.',
        },
        { name: 'name', type: 'string', required: true, description: 'Query parameter name.' },
        { name: 'value', type: 'string', description: 'Current value (escaped).' },
        { name: 'placeholder', type: 'string', description: 'An example of the exact format.' },
        { name: 'submit', type: 'Child', required: true, description: 'Button text.' },
        {
          name: 'labelledBy',
          type: 'string',
          description: 'Id of the visible title that names the search.',
        },
        {
          name: 'searchLabel',
          type: 'string',
          description: 'Name of the search when there is no title.',
        },
        { name: 'action', type: 'string', description: 'Where the form goes.' },
        { name: 'method', type: "'get' | 'post'", default: "'get'", description: 'Form method.' },
        { name: 'class', type: 'string', description: 'Extra classes on the form.' },
      ],
    },
  ],
  accessibility: [
    'A search landmark (role="search"), named by the visible title or searchLabel.',
    'The leading label is a real label for the input.',
    'The whole box shows the focus ring while the input has focus.',
  ],
  do: ['Accept the whole log line as well as the bare ID, and extract it on the server.'],
  dont: ['Do not use it for multi-field filters.', 'Do not leave the button without words.'],
  classes: ['field-inline', 'lbl', 'btn', 'secondary'],
};
