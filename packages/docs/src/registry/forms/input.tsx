import { Field, Input, Textarea } from '@tokengate/ui';
import type { ComponentDoc } from '../types';

export const input: ComponentDoc = {
  slug: 'input',
  name: 'Input',
  related: ['Textarea'],
  summary:
    'A 40px text input: mono for exact values and secrets, with an exact-format placeholder and datalist suggestions.',
  usage: {
    when: [
      'Free text, last in the input order: after deriving, preselecting and picking from a list failed.',
      'IDs, paths, URLs and secrets: mono, with autocomplete, spellcheck and autocapitalize off.',
      <>
        A value that has known candidates: <code>suggestions</code> renders a datalist and a visible
        line of links.
      </>,
      <>
        Longer text (a note, a JSON body): <code>Textarea</code>.
      </>,
    ],
    whenNot: [
      <>
        A value from a list the server knows: <code>RowPicker</code>, <code>RadioCards</code> or{' '}
        <code>Picks</code>.
      </>,
      <>
        A lookup with its own button (“Find a request”): <code>FieldInline</code>.
      </>,
    ],
  },
  examples: [
    {
      title: 'Text and mono',
      description:
        'Mono is for exact values. The placeholder is an example of the exact format, never the label.',
      layout: 'stack',
      render: () => (
        <div class="fields">
          <Field id="in-name" label="Name">
            <Input name="name" placeholder="Slack 2" />
          </Field>
          <Field
            id="in-repo"
            label="Repository name (ID)"
            hint="Owner/name, a space, then the numeric repository ID in brackets."
          >
            <Input name="repository" mono placeholder="acme/api (89012345)" />
          </Field>
        </div>
      ),
      code: `<Field id="name" label="Name">
  <Input name="name" placeholder="Slack 2" />
</Field>
<Field id="repo" label="Repository name (ID)"
  hint="Owner/name, a space, then the numeric repository ID in brackets.">
  <Input name="repository" mono placeholder="acme/api (89012345)" />
</Field>`,
    },
    {
      title: 'Secret',
      description:
        'A password input in mono that password managers ignore, so they never offer to save an API key as a login.',
      layout: 'stack',
      render: () => (
        <div class="fields">
          <Field
            id="in-key"
            label="Project API key"
            hint="From platform.openai.com › API keys. Starts with sk-proj-."
          >
            <Input name="credential" secret placeholder="sk-proj-XXXXXXXXXXXXXXXXXXXX" />
          </Field>
        </div>
      ),
      code: `<Field id="key" label="Project API key"
  hint="From platform.openai.com › API keys. Starts with sk-proj-.">
  <Input name="credential" secret placeholder="sk-proj-XXXXXXXXXXXXXXXXXXXX" />
</Field>`,
    },
    {
      title: 'Suggestions',
      description:
        'Values used before: all go in the datalist; those with a link also show under the input. A link reloads the form with the value filled in, without JS.',
      layout: 'stack',
      render: () => (
        <div class="fields">
          <Field
            id="in-branch"
            label="Branch"
            hint="Without refs/heads/. A trailing * matches a prefix: release/*."
          >
            <Input
              name="branch"
              mono
              placeholder="main"
              suggestionsLabel="Used before"
              suggestions={[
                { value: 'main', href: '?branch=main' },
                { value: 'release/*', href: '?branch=release/*' },
                { value: 'develop' },
              ]}
            />
          </Field>
        </div>
      ),
      code: `<Field id="branch" label="Branch"
  hint="Without refs/heads/. A trailing * matches a prefix: release/*.">
  <Input name="branch" mono placeholder="main" suggestionsLabel="Used before"
    suggestions={[
      { value: 'main', href: '?branch=main' },
      { value: 'release/*', href: '?branch=release/*' },
      { value: 'develop' },
    ]} />
</Field>`,
    },
    {
      title: 'States',
      description: 'Read-only (gray, a derived value), disabled, and invalid (2px red border).',
      layout: 'stack',
      render: () => (
        <div class="fields">
          <Field id="in-path" label="Proxy path" hint="Derived from the name.">
            <Input mono value="/proxy/slack" readonly />
          </Field>
          <Field id="in-off" label="Upstream URL" hint="Set by the Slack type.">
            <Input mono value="https://slack.com/api" disabled />
          </Field>
          <Field id="in-bad" label="Slug" error="Use lowercase letters, digits and dashes.">
            <Input mono value="Slack_2" />
          </Field>
        </div>
      ),
      code: `<Field id="path" label="Proxy path" hint="Derived from the name.">
  <Input mono value="/proxy/slack" readonly />
</Field>
<Field id="upstream" label="Upstream URL" hint="Set by the Slack type.">
  <Input mono value="https://slack.com/api" disabled />
</Field>
<Field id="slug" label="Slug" error="Use lowercase letters, digits and dashes.">
  <Input mono value="Slack_2" />
</Field>`,
    },
    {
      title: 'Date',
      description: 'A native date input, 12rem wide.',
      layout: 'stack',
      render: () => (
        <div class="fields">
          <Field id="in-date" label="Last day" hint="Access stops at the end of this day (UTC).">
            <Input type="date" width="date" name="expires_on" min="2026-10-15" />
          </Field>
        </div>
      ),
      code: `<Field id="last-day" label="Last day" hint="Access stops at the end of this day (UTC).">
  <Input type="date" width="date" name="expires_on" min="2026-10-15" />
</Field>`,
    },
    {
      title: 'Textarea',
      description: 'Grows with its content from 5rem. Mono for JSON or headers.',
      layout: 'stack',
      render: () => (
        <div class="fields">
          <Field
            id="in-desc"
            label="Description"
            optional
            hint="Which account the secret belongs to and who owns it."
          >
            <Textarea
              name="description"
              placeholder='Bot "deploy-bot" in workspace acme; owner: platform team'
            />
          </Field>
          <Field id="in-body" label="Test request body" optional>
            <Textarea name="body" mono value={'{"channel": "C0123456", "text": "deploy done"}'} />
          </Field>
        </div>
      ),
      code: `<Field id="desc" label="Description" optional
  hint="Which account the secret belongs to and who owns it.">
  <Textarea name="description" placeholder='Bot "deploy-bot" in workspace acme; owner: platform team' />
</Field>
<Field id="body" label="Test request body" optional>
  <Textarea name="body" mono value={'{"channel": "C0123456", "text": "deploy done"}'} />
</Field>`,
    },
  ],
  props: [
    {
      component: 'Input',
      props: [
        {
          name: 'id',
          type: 'string',
          description: 'Defaults to the Field’s id. One of the two is required.',
        },
        { name: 'name', type: 'string', description: 'Form field name.' },
        {
          name: 'type',
          type: "'text' | 'password' | 'url' | 'email' | 'search' | 'date' | 'number' | 'tel'",
          default: "'text'",
          description: 'Native input type.',
        },
        { name: 'value', type: 'string | number', description: 'Current value (escaped).' },
        { name: 'placeholder', type: 'string', description: 'An example of the exact format.' },
        {
          name: 'mono',
          type: 'boolean',
          description: 'Mono type; autocomplete, spellcheck and autocapitalize off.',
        },
        {
          name: 'secret',
          type: 'boolean',
          description: 'Password type, mono, ignored by password managers.',
        },
        { name: 'readonly', type: 'boolean', description: 'Gray, for a derived value.' },
        { name: 'disabled', type: 'boolean', description: 'Not editable and not submitted.' },
        {
          name: 'required',
          type: 'boolean',
          description: 'Native required. Never inside a Reveal (it throws).',
        },
        {
          name: 'pattern, minlength, maxlength, min, max, step, inputmode, autocomplete',
          type: 'native',
          description: 'Passed to the input.',
        },
        { name: 'width', type: "'date'", description: '12rem wide (.w-date).' },
        { name: 'invalid', type: 'boolean', description: 'Defaults to the Field’s error state.' },
        {
          name: 'describedBy',
          type: 'string',
          description: 'Defaults to the Field’s hint, error and note ids.',
        },
        {
          name: 'suggestions',
          type: 'readonly { value: string; href?: string }[]',
          description: 'Datalist values; those with href also show as links under the input.',
        },
        {
          name: 'suggestionsLabel',
          type: 'Child',
          default: "'Suggestions'",
          description: 'Words before the links.',
        },
        { name: 'class', type: 'string', description: 'Extra classes on the input.' },
      ],
    },
    {
      component: 'Textarea',
      props: [
        { name: 'id', type: 'string', description: 'Defaults to the Field’s id.' },
        { name: 'name', type: 'string', description: 'Form field name.' },
        { name: 'value', type: 'string', description: 'Current text (escaped).' },
        { name: 'placeholder', type: 'string', description: 'An example.' },
        { name: 'rows, maxlength', type: 'number', description: 'Passed to the textarea.' },
        { name: 'mono', type: 'boolean', description: 'Mono type, no spellcheck.' },
        { name: 'readonly, disabled', type: 'boolean', description: 'States.' },
        { name: 'required', type: 'boolean', description: 'Never inside a Reveal.' },
        {
          name: 'invalid, describedBy',
          type: 'boolean, string',
          description: 'Default to the Field’s.',
        },
        { name: 'class', type: 'string', description: 'Extra classes.' },
      ],
    },
  ],
  accessibility: [
    'Inside a Field the input is labelled, described by the rendered hint, error and note, and aria-invalid when there is an error.',
    'A secret is a password input, so it is never shown on screen or read aloud as text.',
    'The datalist is native: browsers and screen readers offer its values as suggestions; the visible line has real links.',
    'The invalid border is 2px and the error is also in words, so color is not the only signal.',
  ],
  do: [
    'Use mono for anything copied or compared exactly.',
    'Put the exact format in the placeholder and the explanation in the hint.',
    'Offer values used before as suggestions, most used first.',
  ],
  dont: [
    'Do not show a stored secret in an input; keep a draft and say so in a note.',
    'Do not put required on a field inside a Reveal.',
    'Do not use a free-text input for a value the server can list.',
  ],
  classes: ['input', 'mono', 'w-date', 'suggest'],
};
