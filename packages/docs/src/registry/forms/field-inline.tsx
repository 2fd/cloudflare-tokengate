import { FieldInline } from '@tokengate/ui';
import type { ComponentDoc } from '../types';

export const fieldInline: ComponentDoc = {
  slug: 'field-inline',
  name: 'FieldInline',
  summary:
    'A one-line form: a leading label, a mono input and a trailing button in one 40px box. A GET lookup or a one-field POST action.',
  usage: {
    when: [
      'Find one thing by its exact ID: “Find a request” by request ID or a pasted log line (GET, a search landmark).',
      'A one-field action: “Add organizations” on a consumer page (POST, with its _csrf in hidden).',
    ],
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
          formLabel="Find a request"
          action="/admin/requests"
          value="req_01JB8Z5K2Q7W3N4M6P8R9T0V1X"
        />
      ),
      code: `<FieldInline id="find" label="Request ID" name="request" submit="Find"
  formLabel="Find a request" action="/admin/requests"
  value="req_01JB8Z5K2Q7W3N4M6P8R9T0V1X" />`,
    },
    {
      title: 'A one-field POST action',
      description:
        'method="post": not a search landmark. The CSRF token goes in hidden, and describedBy points the input at its hint.',
      layout: 'stack',
      render: () => (
        <div class="field">
          <span class="lbl" id="fi-add-l">
            Add organizations
          </span>
          <FieldInline
            id="fi-add"
            label="Organization"
            name="orgs"
            submit="Add"
            method="post"
            labelledBy="fi-add-l"
            action="/admin/consumers/github-acme/orgs"
            hidden={{ _csrf: 'csrf-token' }}
            describedBy="fi-add-h"
            placeholder="acme-labs"
          />
          <span class="hint" id="fi-add-h">
            The GitHub login or numeric ID of the organization, one per line.
          </span>
        </div>
      ),
      code: `<span class="lbl" id="add-l">Add organizations</span>
<FieldInline id="add-org" label="Organization" name="orgs" submit="Add"
  method="post" labelledBy="add-l" action="/admin/consumers/github-acme/orgs"
  hidden={{ _csrf: csrf }} describedBy="add-org-h" placeholder="acme-labs" />
<span class="hint" id="add-org-h">The GitHub login or numeric ID …</span>`,
    },
    {
      title: 'Find a request, invalid ID',
      description:
        'The server rejected the lookup: it re-renders with the value kept and the error line above the box, so the 40px box keeps its shape. The input is aria-invalid and described by the error.',
      layout: 'stack',
      render: () => (
        <FieldInline
          id="fi-bad"
          label="Request ID"
          name="request"
          submit="Find"
          formLabel="Find a request, invalid ID"
          action="/admin/requests"
          value="req_nope"
          error="Enter a request ID that starts with req_, or paste the log line."
        />
      ),
      code: `<FieldInline id="find" label="Request ID" name="request" submit="Find"
  formLabel="Find a request" action="/admin/requests" value="req_nope"
  error="Enter a request ID that starts with req_, or paste the log line." />`,
    },
    {
      title: 'Add a host, with constraints',
      description:
        'A POST with native constraints: the browser checks required, pattern and maxlength before the server does; inputmode and enterkeyhint pick the keyboard.',
      layout: 'stack',
      render: () => (
        <FieldInline
          id="fi-host"
          label="Host"
          name="host"
          submit="Add"
          method="post"
          formLabel="Add an upstream host"
          action="/admin/settings/upstream-hosts"
          hidden={{ _csrf: 'csrf-token', _action: 'add' }}
          required
          pattern="[a-z0-9.-]+"
          maxlength={253}
          inputmode="url"
          enterkeyhint="done"
          placeholder="api.example.com"
        />
      ),
      code: `<FieldInline id="host" label="Host" name="host" submit="Add" method="post"
  formLabel="Add an upstream host" action="/admin/settings/upstream-hosts"
  hidden={{ _csrf: csrf, _action: 'add' }} required pattern="[a-z0-9.-]+"
  maxlength={253} inputmode="url" enterkeyhint="done" placeholder="api.example.com" />`,
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
        {
          name: 'type',
          type: "'text' | 'search' | 'url'",
          default: "'text'",
          description: 'Input type; text renders no attribute.',
        },
        {
          name: 'pattern, minlength, maxlength, required',
          type: 'native',
          description: 'Native constraints, passed to the input.',
        },
        {
          name: 'inputmode',
          type: "'text' | 'url' | 'search'",
          description: 'Virtual keyboard layout.',
        },
        {
          name: 'enterkeyhint',
          type: "'go' | 'search' | 'send' | 'done'",
          description: 'Label of the Enter key on virtual keyboards.',
        },
        { name: 'invalid', type: 'boolean', description: 'Sets aria-invalid; implied by error.' },
        {
          name: 'error',
          type: 'Child',
          description:
            'The server’s error: a line before the form (`${id}-error`) that describes the input. Keep the submitted value.',
        },
        { name: 'submit', type: 'Child', required: true, description: 'Button text.' },
        {
          name: 'labelledBy',
          type: 'string',
          description: 'Id of the visible title that names the form.',
        },
        {
          name: 'formLabel',
          type: 'string',
          description: 'Name of the form when there is no title.',
        },
        {
          name: 'describedBy',
          type: 'string',
          description:
            'Ids of elements that describe the input: a hint under the box. After the error.',
        },
        { name: 'action', type: 'string', description: 'Where the form goes.' },
        {
          name: 'hidden',
          type: 'HiddenFields',
          description:
            'Hidden fields at the top of the form: _csrf for a POST, kept filters for a GET.',
        },
        {
          name: 'method',
          type: "'get' | 'post'",
          default: "'get'",
          description: 'GET: a lookup. POST: a one-field action.',
        },
        {
          name: 'search',
          type: 'boolean',
          default: 'true for GET',
          description: 'A GET lookup is a search landmark (role="search"). Never with POST.',
        },
        { name: 'class', type: 'string', description: 'Extra classes on the form.' },
      ],
    },
  ],
  accessibility: [
    'A GET lookup is a search landmark (role="search"); a POST action is a plain form. Both are named by the visible title (labelledBy) or formLabel.',
    'describedBy connects the input to its hint under the box.',
    'An error renders as a line before the form; the input is aria-invalid and described by the error first, then by describedBy.',
    'The leading label is a real label for the input.',
    'The whole box shows the focus ring while the input has focus.',
  ],
  do: [
    'Accept the whole log line as well as the bare ID, and extract it on the server.',
    'Send the _csrf token of a POST in hidden, and an _action there too: the button has no name or value.',
    'Keep the submitted value when you re-render with an error.',
  ],
  dont: ['Do not use it for multi-field filters.', 'Do not leave the button without words.'],
  classes: ['field-inline', 'lbl', 'btn', 'secondary', 'field-error'],
};
