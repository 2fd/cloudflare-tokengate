import { Field, FieldSet, Input, LiveForm, More, RowPicker, Reveal, SubBox } from '@tokengate/ui';
import type { ComponentDoc } from '../types';
import { repositories } from './data';

export const reveal: ComponentDoc = {
  slug: 'reveal',
  name: 'Reveal',
  related: ['SubBox', 'More'],
  summary:
    'Conditional fields: a gray box shown only while one option is checked (Reveal), a plain gray box (SubBox), and a “More …” disclosure.',
  usage: {
    when: [
      <>
        Fields that one choice needs: “Another repository” reveals the repository field. Inside a{' '}
        <code>LiveForm</code>.
      </>,
      <>
        Rarely needed fields, closed by default: <code>More</code>.
      </>,
      <>
        A side note next to a form, or fields that belong together: <code>SubBox</code>.
      </>,
    ],
    whenNot: [
      'Fields everyone fills in: show them.',
      'A whole other form: a type card or another page.',
    ],
  },
  examples: [
    {
      title: 'Reveal on a choice',
      description:
        'Pick “Another repository”: option 5 of field 2 shows the box. The field inside says “(needed for …)” and is never required; the server validates it.',
      layout: 'stack',
      render: () => (
        <LiveForm method="get">
          <FieldSet id="rv-repo" legend="Repository" live={2}>
            <RowPicker name="rv-repo" options={repositories} value="89012345" />
          </FieldSet>
          <Reveal field={2} option={5}>
            <Field
              id="rv-repo-new"
              label="Repository name (ID)"
              neededFor="Another repository"
              hint="Owner/name, a space, then the numeric repository ID in brackets."
            >
              <Input name="repository" mono placeholder="acme/api (89012345)" />
            </Field>
          </Reveal>
        </LiveForm>
      ),
      code: `<LiveForm method="post" action="/admin/issuer-access-rules">
  <FieldSet id="repo" legend="Repository" live={2}>
    <RowPicker name="repo" options={repositories} value="89012345" />
  </FieldSet>
  <Reveal field={2} option={5}>
    <Field id="repo-new" label="Repository name (ID)" neededFor="Another repository"
      hint="Owner/name, a space, then the numeric repository ID in brackets.">
      <Input name="repository" mono placeholder="acme/api (89012345)" />
    </Field>
  </Reveal>
</LiveForm>`,
    },
    {
      title: 'Reveal already open',
      description:
        'Re-rendered with “Another repository” checked and an error in the revealed field.',
      layout: 'stack',
      render: () => (
        <LiveForm method="get">
          <FieldSet id="rv-repo2" legend="Repository" live={2}>
            <RowPicker name="rv-repo2" options={repositories} value="other" />
          </FieldSet>
          <Reveal field={2} option={5}>
            <Field
              id="rv-repo2-new"
              label="Repository name (ID)"
              neededFor="Another repository"
              error="Enter the owner/name and the numeric ID in brackets: acme/api (89012345)."
            >
              <Input name="repository" mono value="acme/api" />
            </Field>
          </Reveal>
        </LiveForm>
      ),
      code: `<RowPicker name="repo" options={repositories} value="other" />
<Reveal field={2} option={5}>
  <Field id="repo-new" label="Repository name (ID)" neededFor="Another repository"
    error="Enter the owner/name and the numeric ID in brackets: acme/api (89012345).">
    <Input name="repository" mono value="acme/api" />
  </Field>
</Reveal>`,
    },
    {
      title: 'More constraints',
      description: 'Closed by default; open it when a field inside has a value or an error.',
      layout: 'stack',
      render: () => (
        <>
          <More summary="More constraints" meta="workflow pin">
            <SubBox>
              <Field
                id="rv-wf"
                label="Workflow"
                optional
                hint="The workflow file at a ref, as in the job's job_workflow_ref claim."
              >
                <Input
                  name="workflow"
                  mono
                  placeholder="acme/api/.github/workflows/deploy.yml@refs/heads/main"
                />
              </Field>
            </SubBox>
          </More>
          <More summary="More constraints" meta="1 set" open>
            <SubBox>
              <Field id="rv-wf2" label="Workflow" optional>
                <Input
                  name="workflow"
                  mono
                  value="acme/api/.github/workflows/deploy.yml@refs/heads/main"
                />
              </Field>
            </SubBox>
          </More>
        </>
      ),
      code: `<More summary="More constraints" meta="workflow pin">
  <SubBox>
    <Field id="workflow" label="Workflow" optional
      hint="The workflow file at a ref, as in the job's job_workflow_ref claim.">
      <Input name="workflow" mono placeholder="acme/api/.github/workflows/deploy.yml@refs/heads/main" />
    </Field>
  </SubBox>
</More>
<More summary="More constraints" meta="1 set" open>…</More>`,
    },
    {
      title: 'SubBox as a side note',
      layout: 'stack',
      render: () => (
        <SubBox as="aside" labelledBy="rv-next-h">
          <h3 id="rv-next-h">When you save</h3>
          <ol>
            <li>
              <b>tokengate calls Slack</b> <code>GET /auth.test</code> with the secret and expects{' '}
              <code>"ok": true</code>.
            </li>
            <li>
              <b>The secret is sealed</b> with key <code>k2</code> and never shown again.
            </li>
          </ol>
        </SubBox>
      ),
      code: `<SubBox as="aside" labelledBy="next-h">
  <h3 id="next-h">When you save</h3>
  <ol>
    <li><b>tokengate calls Slack</b> <code>GET /auth.test</code> with the secret …</li>
    <li><b>The secret is sealed</b> with key <code>k2</code> and never shown again.</li>
  </ol>
</SubBox>`,
    },
  ],
  props: [
    {
      component: 'Reveal',
      props: [
        {
          name: 'field',
          type: 'LiveSlot (1–8)',
          required: true,
          description: 'Field slot whose choice shows it.',
        },
        {
          name: 'option',
          type: 'number',
          required: true,
          description: 'Option number (1–12) that shows it.',
        },
        {
          name: 'box',
          type: 'boolean',
          default: 'true',
          description: 'Gray .subbox around the branch.',
        },
        { name: 'class', type: 'string', description: 'Extra classes.' },
        {
          name: 'children',
          type: 'Child',
          required: true,
          description: 'Conditional fields, never required.',
        },
      ],
    },
    {
      component: 'SubBox',
      props: [
        {
          name: 'as',
          type: "'div' | 'aside'",
          default: "'div'",
          description: 'aside for a side note.',
        },
        { name: 'labelledBy', type: 'string', description: 'Heading id that names an aside.' },
        { name: 'class', type: 'string', description: 'Extra classes.' },
        { name: 'children', type: 'Child', required: true, description: 'Content.' },
      ],
    },
    {
      component: 'More',
      props: [
        { name: 'summary', type: 'Child', required: true, description: 'Disclosure label.' },
        { name: 'meta', type: 'Child', description: 'What is set inside, in regular weight.' },
        { name: 'open', type: 'boolean', description: 'Open on load.' },
        { name: 'class', type: 'string', description: 'Extra classes.' },
        { name: 'children', type: 'Child', required: true, description: 'Rarely needed fields.' },
      ],
    },
  ],
  accessibility: [
    'A hidden branch is display:none: it is not read, not focusable, and its fields are skipped by Tab.',
    'Rendering a required control inside a Reveal throws, because the browser would block the submit on a field nobody can see.',
    '“(needed for …)” tells people why the field appeared.',
    'More is a native details element: Enter or Space opens it, and its state is announced.',
  ],
  do: [
    'Name the choice that needs the field in neededFor.',
    'Open More when it holds a value or an error.',
  ],
  dont: ['Do not hide fields most people need.', 'Do not nest a More inside a More.'],
  classes: ['rv1…rv6', 'data-o', 'subbox', 'more', 'more-b'],
};
