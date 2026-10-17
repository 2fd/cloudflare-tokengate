import { LiveForm, RiskAcceptance } from '@tokengate/ui';
import type { ComponentDoc } from '../types';

const prRisk = {
  label: 'Pull request into',
  text: 'pull_request jobs run the code proposed in the pull request, and that code gets the Slack token.',
};

export const riskAcceptance: ComponentDoc = {
  slug: 'risk-acceptance',
  name: 'RiskAcceptance',
  summary:
    'A warn block right before the submit row: the risks of the choices, and one checkbox that accepts them.',
  usage: {
    when: [
      'A choice is allowed but risky: pull request jobs, self-hosted runners, a long expiry.',
      'In a LiveForm it shows only while a risk option is checked; elsewhere, render it when the server sees a risk.',
    ],
    whenNot: [
      'A choice that is not allowed: disable the option and say why.',
      'A destructive action: a confirm dialog.',
    ],
  },
  examples: [
    {
      title: 'One risk',
      layout: 'stack',
      render: () => (
        <RiskAcceptance
          id="ra-one"
          title="Accept 1 risk to save this access"
          risks={[prRisk]}
          confirm="I accept this risk for acme/api → Slack"
        />
      ),
      code: `<RiskAcceptance id="risk" title="Accept 1 risk to save this access"
  risks={[{ label: 'Pull request into',
    text: 'pull_request jobs run the code proposed in the pull request, and that code gets the Slack token.' }]}
  confirm="I accept this risk for acme/api → Slack" />`,
    },
    {
      title: 'Two risks, not accepted',
      description:
        'The server refused the save: the error is above the box, and the box is aria-invalid.',
      layout: 'stack',
      render: () => (
        <RiskAcceptance
          id="ra-two"
          title="Accept 2 risks to save this access"
          risks={[
            prRisk,
            {
              label: 'Self-hosted runners',
              text: 'any runner registered to acme can request the token.',
            },
          ]}
          confirm="I accept these risks for acme/web → Slack"
          error="Accept the risks, or pick safer options above."
        />
      ),
      code: `<RiskAcceptance id="risk" title="Accept 2 risks to save this access"
  risks={[prRisk, { label: 'Self-hosted runners', text: 'any runner registered to acme can request the token.' }]}
  confirm="I accept these risks for acme/web → Slack"
  error="Accept the risks, or pick safer options above." />`,
    },
    {
      title: 'Accepted, custom hint',
      layout: 'stack',
      render: () => (
        <RiskAcceptance
          id="ra-ok"
          title="Accept 1 risk to save this access"
          risks={[prRisk]}
          confirm="I accept this risk for acme/api → Slack"
          checked
          hint="The access page shows “⚠ Risk accepted” with your name."
        />
      ),
      code: `<RiskAcceptance id="risk" title="Accept 1 risk to save this access" risks={[prRisk]}
  confirm="I accept this risk for acme/api → Slack" checked
  hint="The access page shows “⚠ Risk accepted” with your name." />`,
    },
    {
      title: 'Server-computed, required',
      description:
        'always: the server computed the risk (a copy, the row editor, validator warnings), so the block shows inside a LiveForm without a checked risky option. Only then can the box be required: it is always visible, so it never blocks a submit it hides. There is no default hint.',
      layout: 'stack',
      render: () => (
        <LiveForm layout="fields" action="/admin/access/copy">
          <RiskAcceptance
            id="ra-srv"
            title="Accept 1 risk to copy this access"
            risks={[prRisk]}
            confirm="I accept this risk for acme/web → Slack"
            always
            required
          />
        </LiveForm>
      ),
      code: `<LiveForm layout="fields" action="/admin/access/copy">
  <RiskAcceptance id="risk" title="Accept 1 risk to copy this access" risks={[prRisk]}
    confirm="I accept this risk for acme/web → Slack" always required />
</LiveForm>`,
    },
  ],
  props: [
    {
      component: 'RiskAcceptance',
      props: [
        {
          name: 'id',
          type: 'string',
          required: true,
          description: 'Heading `${id}-h`, box `${id}-ack`, error `${id}-error`.',
        },
        {
          name: 'title',
          type: 'Child',
          required: true,
          description: '“Accept N risks to …”; a ⚠ is added.',
        },
        {
          name: 'risks',
          type: 'readonly { label: Child; text: Child }[]',
          required: true,
          description: 'One item per risk: the choice and what can go wrong.',
        },
        {
          name: 'confirm',
          type: 'Child',
          required: true,
          description: 'Checkbox label naming what is accepted.',
        },
        {
          name: 'name',
          type: 'string',
          default: "'acknowledge_warnings'",
          description: 'Checkbox name.',
        },
        { name: 'value', type: 'string', default: "'1'", description: 'Checkbox value.' },
        { name: 'checked', type: 'boolean', description: 'Keep it checked on a re-render.' },
        {
          name: 'hint',
          type: 'Child | null',
          default: "'Or pick a safer option above; …' (none with always)",
          description: 'Line under the box; null hides it.',
        },
        {
          name: 'always',
          type: 'boolean',
          description:
            'Shown without a checked risky option (.riskacc.always): for risks the server computed.',
        },
        {
          name: 'required',
          type: 'boolean',
          description:
            'required on the box. Only with always (a type error otherwise); never inside a Reveal (it throws).',
        },
        {
          name: 'error',
          type: 'Child',
          description: 'Server error when the risk was not accepted.',
        },
        {
          name: 'headingLevel',
          type: '2 | 3 | 4',
          default: '2',
          description: 'Heading level (2: in the form, under the page H1).',
        },
        { name: 'class', type: 'string', description: 'Extra classes.' },
      ],
    },
  ],
  accessibility: [
    'A group labelled by its heading; the ⚠ glyph is hidden and the heading says “risk” in words.',
    'The box is never required unless always, so a hidden block never blocks the submit; the server refuses a risky save without it and re-renders with the error. An always block is visible, so its box may be required.',
    'The error describes the box and sets aria-invalid; link to `${id}-ack` from the ErrorSummary.',
    'Warn text and background meet 4.5:1 in both schemes.',
  ],
  do: ['Name the exact access in the checkbox label.', 'Place it directly before the submit row.'],
  dont: [
    'Do not use it for actions that cannot be undone.',
    'Do not accept risks with a single page-wide checkbox for several accesses.',
  ],
  classes: ['riskacc', 'always', 'check', 'hint', 'field-error'],
};
