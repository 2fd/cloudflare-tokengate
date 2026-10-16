import {
  FieldSet,
  LiveForm,
  LivePhrase,
  LiveSummary,
  Picks,
  RadioCards,
  RiskAcceptance,
  RiskSwitch,
  SummaryFoot,
  SummaryRow,
  SummaryWire,
} from '@tokengate/ui';
import type { ComponentDoc } from '../types';
import { expiries, logos } from './data';
import { GiveAccessForm, giveAccessCode } from './give-access';

export const liveForm: ComponentDoc = {
  slug: 'live-form',
  name: 'LiveForm',
  related: ['LiveSummary', 'SummaryRow', 'SummaryWire', 'SummaryFoot', 'LivePhrase', 'RiskSwitch'],
  summary:
    'A form whose summary rail, hidden branches and risk block follow its choices with generic :has() rules: no JS, no per-page CSS.',
  usage: {
    when: [
      'The give-access page: one page, numbered steps, a summary of the access being made.',
      'Any form where a choice reveals fields (Reveal) or a risky choice needs acceptance (RiskAcceptance).',
    ],
    whenNot: [
      'A short form with no conditional fields: a plain form with .fields.',
      'A multi-page wizard: tokengate keeps a task on one page.',
    ],
  },
  examples: [
    {
      title: 'Give access',
      description:
        'The real component: pick GitLab CI, Another repository, Branch or Pull request into, uncheck every operation, or pick On a date, and the summary, the branches and the risk block follow. The server renders the preselected options checked, so the first paint is already right.',
      layout: 'frame',
      render: () => (
        <div class="page">
          <GiveAccessForm p="lf" />
        </div>
      ),
      code: giveAccessCode,
    },
    {
      title: 'Risky choice preselected',
      description:
        'Re-rendered after a submit with Pull request into: the risk block is already visible and the summary says so.',
      layout: 'frame',
      render: () => (
        <div class="page">
          <GiveAccessForm p="lr" context="pull_request" />
        </div>
      ),
      code: `<RadioCards name="ctx" options={contexts} value="pull_request" />`,
    },
    {
      title: 'The contract, small',
      description:
        'Field 1 (live={1}) has options 1–4 by position. LivePhrase field={1} shows the phrase of the checked option, or empty while nothing is checked. Option 4 is risky: it shows the RiskAcceptance and flips the RiskSwitch.',
      layout: 'frame',
      render: () => (
        <div class="page">
          <LiveForm
            method="get"
            rail={
              <LiveSummary id="lc-sum" title="This access">
                <SummaryRow
                  logo={logos.openai}
                  title="OpenAI"
                  meta="gate.acme.dev/proxy/openai"
                  mono
                />
                <SummaryWire />
                <SummaryRow
                  glyph="⌛"
                  title="Expires"
                  meta={
                    <LivePhrase
                      field={1}
                      phrases={{
                        1: 'never',
                        2: 'in 7 days',
                        3: 'in 30 days',
                        4: 'in 90 days',
                        5: 'on a date',
                      }}
                      empty="choose when"
                    />
                  }
                />
                <SummaryFoot>
                  <RiskSwitch safe="No risks." risk="1 risk to accept." />
                </SummaryFoot>
              </LiveSummary>
            }
          >
            <FieldSet id="lc-exp" legend="Expires" live={1}>
              <Picks
                name="lc-exp"
                options={expiries.map((pick) =>
                  pick.value === '90d' ? { ...pick, risk: true } : pick,
                )}
              />
            </FieldSet>
            <RiskAcceptance
              id="lc-risk"
              title="Accept 1 risk to save this access"
              risks={[
                {
                  label: '90 days',
                  text: 'the OpenAI project key stays usable for a quarter without a review.',
                },
              ]}
              confirm="I accept this risk for GitHub Actions (acme) → OpenAI"
            />
            <div>
              <button class="btn primary" type="submit">
                Give access
              </button>
            </div>
          </LiveForm>
        </div>
      ),
      code: `<LiveForm method="post" action="/admin/access" rail={
  <LiveSummary id="sum" title="This access">
    <SummaryRow logo={openaiLogo} title="OpenAI" meta="gate.acme.dev/proxy/openai" mono />
    <SummaryWire />
    <SummaryRow glyph="⌛" title="Expires" meta={
      <LivePhrase field={1} empty="choose when"
        phrases={{ 1: 'never', 2: 'in 7 days', 3: 'in 30 days', 4: 'in 90 days', 5: 'on a date' }} />} />
    <SummaryFoot><RiskSwitch safe="No risks." risk="1 risk to accept." /></SummaryFoot>
  </LiveSummary>
}>
  <FieldSet id="exp" legend="Expires" live={1}>
    <Picks name="exp" options={[…, { value: '90d', label: '90 days', risk: true }, …]} />
  </FieldSet>
  <RiskAcceptance id="risk" title="Accept 1 risk to save this access"
    risks={[{ label: '90 days', text: 'the OpenAI project key stays usable for a quarter without a review.' }]}
    confirm="I accept this risk for GitHub Actions (acme) → OpenAI" />
  <div><button class="btn primary" type="submit">Give access</button></div>
</LiveForm>`,
    },
    {
      title: 'Summary parts',
      description:
        'Rows joined by wires, and the foot line. Outside a LiveForm a LivePhrase shows every phrase, so use the parts inside one.',
      layout: 'stack',
      render: () => (
        <LiveForm method="get">
          <FieldSet id="lp-kind" legend="Consumer kind" live={2}>
            <RadioCards
              name="lp-kind"
              value="gh"
              options={[
                { value: 'gh', title: 'GitHub Actions', description: 'OIDC from GitHub' },
                { value: 'gl', title: 'GitLab CI', description: 'OIDC from GitLab' },
              ]}
            />
          </FieldSet>
          <div class="panel">
            <div class="lsum">
              <SummaryRow
                logo={
                  <LivePhrase field={2} decorative phrases={{ 1: logos.github, 2: logos.gitlab }} />
                }
                title={
                  <LivePhrase
                    field={2}
                    phrases={{ 1: 'GitHub Actions (acme)', 2: 'GitLab CI (platform)' }}
                  />
                }
                meta={<span class="v">acme/api</span>}
              />
            </div>
          </div>
        </LiveForm>
      ),
      code: `<FieldSet id="kind" legend="Consumer kind" live={2}>
  <RadioCards name="kind" value="gh" options={kinds} />
</FieldSet>
<SummaryRow
  logo={<LivePhrase field={2} decorative phrases={{ 1: githubLogo, 2: gitlabLogo }} />}
  title={<LivePhrase field={2} phrases={{ 1: 'GitHub Actions (acme)', 2: 'GitLab CI (platform)' }} />}
  meta={<span class="v">acme/api</span>} />`,
    },
  ],
  props: [
    {
      component: 'LiveForm',
      props: [
        { name: 'method', type: "'post' | 'get'", default: "'post'", description: 'Form method.' },
        { name: 'action', type: 'string', description: 'Where the form posts.' },
        { name: 'id', type: 'string', description: 'Id of the form.' },
        {
          name: 'rail',
          type: 'Child',
          description: 'The LiveSummary: right of the form at >= 80rem (sticky), under it below.',
        },
        { name: 'class', type: 'string', description: 'Extra classes on the form.' },
        {
          name: 'children',
          type: 'Child',
          required: true,
          description:
            'The form column, 32px between blocks: FixedBar, Stepper, RiskAcceptance, SubmitRow.',
        },
      ],
    },
    {
      component: 'LiveSummary',
      props: [
        {
          name: 'id',
          type: 'string',
          required: true,
          description: 'The rail is labelled by `${id}-h`.',
        },
        {
          name: 'title',
          type: 'Child',
          required: true,
          description: 'Rail title (“This access”).',
        },
        { name: 'description', type: 'Child', description: 'Line under the title.' },
        {
          name: 'headingLevel',
          type: '2 | 3',
          default: '2',
          description: 'Heading level of the title.',
        },
        { name: 'class', type: 'string', description: 'Extra classes on the aside.' },
        {
          name: 'children',
          type: 'Child',
          required: true,
          description: 'SummaryRow, SummaryWire, SummaryFoot.',
        },
      ],
    },
    {
      component: 'SummaryRow',
      props: [
        {
          name: 'logo',
          type: 'Child',
          description: 'Logo tile (aria-hidden), or a decorative LivePhrase of logos.',
        },
        {
          name: 'glyph',
          type: 'string',
          default: "'→'",
          description: 'Glyph in a gray tile when there is no logo.',
        },
        { name: 'title', type: 'Child', required: true, description: 'Bold line.' },
        { name: 'meta', type: 'Child', description: 'Second line.' },
        { name: 'mono', type: 'boolean', description: 'Mono second line (URLs).' },
        { name: 'class', type: 'string', description: 'Extra classes.' },
      ],
    },
    {
      component: 'SummaryWire',
      props: [{ name: 'class', type: 'string', description: 'Extra classes.' }],
    },
    {
      component: 'SummaryFoot',
      props: [
        { name: 'class', type: 'string', description: 'Extra classes.' },
        {
          name: 'children',
          type: 'Child',
          required: true,
          description: 'Expiry and the RiskSwitch.',
        },
      ],
    },
    {
      component: 'LivePhrase',
      props: [
        {
          name: 'field',
          type: '1 | 2 | 3 | 4 | 5 | 6',
          required: true,
          description: 'Field slot (FieldSet / FormStep live).',
        },
        {
          name: 'phrases',
          type: 'Readonly<Record<number, Child>>',
          required: true,
          description: 'Phrase per option number (1–12, the position in the options list).',
        },
        {
          name: 'empty',
          type: 'Child',
          description: 'Shown while nothing in the field is checked.',
        },
        {
          name: 'as',
          type: "'span' | 'b'",
          default: "'span'",
          description: 'Element of the slot.',
        },
        { name: 'decorative', type: 'boolean', description: 'aria-hidden: a phrase of logos.' },
        { name: 'class', type: 'string', description: 'Extra classes.' },
      ],
    },
    {
      component: 'RiskSwitch',
      props: [
        {
          name: 'risk',
          type: 'Child',
          required: true,
          description: 'Shown while a risky option is checked (warn).',
        },
        { name: 'safe', type: 'Child', required: true, description: 'Shown otherwise.' },
      ],
    },
  ],
  accessibility: [
    'Everything is server-rendered text, so it is escaped, translatable, and readable with CSS off.',
    'Hidden phrases and branches are display:none, so screen readers read only the visible ones, the same as sighted people.',
    'The summary repeats the form; it is not a live region, so it does not interrupt while people choose.',
    'No required inside a Reveal: the browser cannot focus a hidden required field and would block the submit. The server validates the branch.',
    'Logo phrases are decorative; the consumer name phrase carries the meaning.',
  ],
  do: [
    'Render the preselected options checked, so the first paint matches the choices.',
    'Number options by position (1–12) and keep phrases in the same order.',
    'Validate every revealed field on the server and re-render with ErrorSummary.',
  ],
  dont: [
    'Do not write per-page CSS for a summary: use the six field slots.',
    'Do not put required on a field in a Reveal (it throws).',
    'Do not use more than 12 options in a live field.',
  ],
  classes: [
    'lform',
    'form-layout',
    'stack',
    'rail',
    'sf1…sf6',
    'sv1…sv6',
    'rv1…rv6',
    'data-o',
    'data-risk',
    'lsum',
    'lsum-row',
    'lsum-wire',
    'lsum-foot',
    'ico',
    'v',
    'if-risk',
    'if-norisk',
    'count-scope',
    'opsn',
  ],
};
