import {
  Badge,
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
import { expiries, logos, tiles } from './data';
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
      code: `<LiveForm method="post" action="/admin/issuer-access-rules" rail={
  <LiveSummary id="sum" title="This access">
    <SummaryRow logo="openai" title="OpenAI" meta="gate.acme.dev/proxy/openai" mono />
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
      title: 'Nested live form without a rail',
      description:
        'layout="fields": the form column alone, without .form-layout, so a live form inside a detail column or a disclosure (the edit and copy forms) reserves no empty rail column at 80rem and wider. The :has() contract still applies: pick 90 days and the risk block shows.',
      layout: 'stack',
      render: () => (
        <LiveForm
          layout="fields"
          action="/admin/issuer-access-rules/1"
          hidden={{ _csrf: 'csrf-token' }}
        >
          <FieldSet id="lfn-exp" legend="Expires" live={1}>
            <Picks
              name="lfn-exp"
              value="30d"
              options={expiries.map((pick) =>
                pick.value === '90d' ? { ...pick, risk: true } : pick,
              )}
            />
          </FieldSet>
          <RiskAcceptance
            id="lfn-risk"
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
              Save
            </button>
          </div>
        </LiveForm>
      ),
      code: `<LiveForm layout="fields" action="/admin/issuer-access-rules/1" hidden={{ _csrf: csrf }}>
  <FieldSet id="exp" legend="Expires" live={1}>
    <Picks name="exp" value="30d" options={[…, { value: '90d', label: '90 days', risk: true }, …]} />
  </FieldSet>
  <RiskAcceptance id="risk" title="Accept 1 risk to save this access" risks={[…]}
    confirm="I accept this risk for GitHub Actions (acme) → OpenAI" />
  <div><button class="btn primary" type="submit">Save</button></div>
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
                logoSlot={
                  <LivePhrase field={2} decorative phrases={{ 1: tiles.github, 2: tiles.gitlab }} />
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
  logoSlot={<LivePhrase field={2} decorative phrases={{ 1: githubLogo, 2: gitlabLogo }} />}
  title={<LivePhrase field={2} phrases={{ 1: 'GitHub Actions (acme)', 2: 'GitLab CI (platform)' }} />}
  meta={<span class="v">acme/api</span>} />`,
    },
    {
      title: 'Plan of an empty install',
      description:
        'variant="plan": the same rows in their own tray, without a form or a rail, the wires dashed: what is not built yet. The icon tile is the tokengate gate.',
      layout: 'stack',
      render: () => (
        <div class="dx-rail">
          <LiveSummary
            id="lf-plan"
            variant="plan"
            title="What you are building"
            description="The map on this page fills in as you finish each step."
          >
            <SummaryRow
              logo="github"
              title={
                <>
                  Credential access rule <Badge>Step 2</Badge>
                </>
              }
              meta="for example GitHub Actions"
            />
            <SummaryWire />
            <SummaryRow
              icon="gate"
              title="tokengate"
              meta="Checks every call against an issuer access rule (step 3)"
            />
            <SummaryWire />
            <SummaryRow
              logo="slack"
              title={
                <>
                  Credential <Badge>Step 1</Badge>
                </>
              }
              meta="for example Slack or OpenAI. The upstream secret stays here."
            />
          </LiveSummary>
        </div>
      ),
      code: `<LiveSummary id="plan" variant="plan" title="What you are building"
  description="The map on this page fills in as you finish each step.">
  <SummaryRow logo="github" title={<>Credential access rule <Badge>Step 2</Badge></>} meta="for example GitHub Actions" />
  <SummaryWire />
  <SummaryRow icon="gate" title="tokengate" meta="Checks every call against an issuer access rule (step 3)" />
  <SummaryWire />
  <SummaryRow logo="slack" title={<>Credential <Badge>Step 1</Badge></>} meta="…" />
</LiveSummary>`,
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
          name: 'layout',
          type: "'form-layout' | 'fields'",
          default: "'form-layout'",
          description:
            'form-layout: the column and its rail (.form-layout). fields: the column alone, for a live form inside a detail column or a disclosure.',
        },
        {
          name: 'rail',
          type: 'Child',
          description:
            'The LiveSummary: right of the form at >= 80rem (sticky), under it below. Not with layout="fields" (it throws).',
        },
        {
          name: 'hidden',
          type: 'HiddenFields',
          description: 'Hidden fields at the top of the form (_csrf, ids).',
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
          type: '2 | 3 | 4',
          default: '2',
          description: 'Heading level of the title.',
        },
        {
          name: 'variant',
          type: "'rail' | 'plan'",
          default: "'rail'",
          description:
            'rail: the sticky rail of a LiveForm. plan: the summary alone in its own tray, dashed wires (a plan of what is not built yet).',
        },
        {
          name: 'class',
          type: 'string',
          description: 'Extra classes on the aside (the tray for plan).',
        },
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
        { name: 'logo', type: 'LogoSpec', description: 'Brand tile (32px), decorative.' },
        {
          name: 'logoSlot',
          type: 'Child',
          description:
            'A custom decorative node instead of logo: a decorative LivePhrase of logos.',
        },
        {
          name: 'icon',
          type: 'IconName',
          description: 'Icon in a gray tile when there is no logo (the tokengate gate).',
        },
        {
          name: 'glyph',
          type: 'string',
          default: "'→'",
          description: 'Glyph in the gray tile when there is no logo or icon.',
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
          type: 'LiveSlot (1–8)',
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
    'Logo phrases are decorative; the credential access rule name phrase carries the meaning.',
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
    'sf1…sf8',
    'sv1…sv8',
    'rv1…rv8',
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
    'plan',
  ],
};
