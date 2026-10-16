// The give-access page form (d-components "Give access: stepper + live summary"), built from the
// forms components. Used by the LiveForm page; `p` keeps ids and radio names unique on a page.
import {
  Badge,
  CheckPresets,
  Field,
  FieldSet,
  FixedBar,
  FormStep,
  Input,
  LiveForm,
  LivePhrase,
  LiveSummary,
  Picks,
  RadioCards,
  Reveal,
  RiskAcceptance,
  RiskSwitch,
  RowPicker,
  SelectedCount,
  Stepper,
  SubmitRow,
  SummaryFoot,
  SummaryRow,
  SummaryWire,
} from '@tokengate/ui';
import {
  consumers,
  contexts,
  environments,
  expiries,
  logos,
  repositories,
  slackOperations,
} from './data';

export function GiveAccessForm(props: { p: string; context?: string }) {
  const p = props.p;
  return (
    <LiveForm
      method="get"
      rail={
        <LiveSummary
          id={`${p}-sum`}
          title="This access"
          description="Follows the choices in this form."
        >
          <SummaryRow
            logo={
              <LivePhrase
                field={1}
                decorative
                phrases={{ 1: logos.github, 2: logos.gitlab, 3: logos.buildkite }}
                empty={logos.unknown}
              />
            }
            title={
              <LivePhrase
                field={1}
                phrases={{
                  1: 'GitHub Actions (acme)',
                  2: 'GitLab CI (platform)',
                  3: 'Buildkite (acme)',
                }}
                empty="Choose a consumer"
              />
            }
            meta={
              <>
                <LivePhrase
                  field={2}
                  phrases={{
                    1: <span class="v">acme/api</span>,
                    2: <span class="v">acme/web</span>,
                    3: <span class="v">acme/infra</span>,
                    4: <span class="v">acme/docs</span>,
                    5: 'the repository you enter',
                  }}
                />
                <LivePhrase
                  field={3}
                  phrases={{
                    1: (
                      <>
                        {' · environment '}
                        <LivePhrase
                          field={4}
                          phrases={{
                            1: <span class="v">production</span>,
                            2: <span class="v">staging</span>,
                            3: <span class="v">preview</span>,
                            4: 'you enter',
                          }}
                        />
                      </>
                    ),
                    2: ' · the branch you enter',
                    3: ' · any protected ref',
                    4: <span class="t-warn"> · pull requests (risk)</span>,
                  }}
                />
              </>
            }
          />
          <SummaryWire />
          <SummaryRow
            glyph="→"
            title="May call"
            meta={
              <LivePhrase
                field={5}
                phrases={{
                  1: (
                    <>
                      Post messages
                      <br />
                    </>
                  ),
                  2: (
                    <>
                      Update and delete messages
                      <br />
                    </>
                  ),
                  3: (
                    <>
                      Upload files
                      <br />
                    </>
                  ),
                  4: (
                    <>
                      Read channel list
                      <br />
                    </>
                  ),
                }}
                empty={<span class="t-bad">No operation chosen</span>}
              />
            }
          />
          <SummaryWire />
          <SummaryRow logo={logos.slack} title="Slack" meta="gate.acme.dev/proxy/slack" mono />
          <SummaryFoot>
            Expires{' '}
            <LivePhrase
              field={6}
              as="b"
              phrases={{
                1: 'never',
                2: 'in 7 days',
                3: 'in 30 days',
                4: 'in 90 days',
                5: 'on the date you choose',
              }}
            />
            . <RiskSwitch safe="No risks." risk="1 risk to accept before Give access." />
          </SummaryFoot>
        </LiveSummary>
      }
    >
      <FixedBar
        label="Token"
        logo={logos.slackSm}
        name="Slack"
        meta="/proxy/slack"
        status={
          <Badge tone="ok" glyph="✓">
            Secret set
          </Badge>
        }
        change={{ href: '?change=token', context: 'token' }}
      />
      <Stepper>
        <FormStep n={1} title="Consumer" live={1} id={`${p}-consumer`}>
          <RowPicker name={`${p}-consumer`} options={consumers} value="gha-acme" />
          <a class="btn ghost sm" href="?new=consumer">
            + Add a new consumer
          </a>
        </FormStep>
        <FormStep
          n={2}
          kind="group"
          id={`${p}-jobs`}
          title="Which jobs"
          description={
            <>
              Inherited from GitHub Actions (acme): organization{' '}
              <span class="mono">acme (1234567)</span>. Only its repositories can match.
            </>
          }
        >
          <FieldSet
            id={`${p}-repo`}
            legend="Repository"
            live={2}
            hint="Repositories this consumer used before, most used first. The ID keeps working after a rename."
          >
            <RowPicker name={`${p}-repo`} options={repositories} value="89012345" />
          </FieldSet>
          <Reveal field={2} option={5}>
            <Field
              id={`${p}-repo-new`}
              label="Repository name (ID)"
              neededFor="Another repository"
              hint="Owner/name, a space, then the numeric repository ID in brackets."
            >
              <Input name="repository" mono placeholder="acme/api (89012345)" />
            </Field>
          </Reveal>
          <FieldSet id={`${p}-ctx`} legend="When can its jobs use the token?" live={3}>
            <RadioCards
              name={`${p}-ctx`}
              options={contexts}
              value={props.context ?? 'environment'}
            />
          </FieldSet>
          <Reveal field={3} option={1}>
            <FieldSet
              id={`${p}-env`}
              legend="Environment"
              neededFor="Environment"
              live={4}
              hint={
                <>
                  Exact name from the job's <code>environment:</code> key.
                </>
              }
            >
              <Picks name={`${p}-env`} options={environments} value="production" />
            </FieldSet>
            <Reveal field={4} option={4} box={false}>
              <Field id={`${p}-env-new`} label="Environment name">
                <Input name="environment" mono placeholder="production" />
              </Field>
            </Reveal>
          </Reveal>
          <Reveal field={3} option={2}>
            <Field
              id={`${p}-branch`}
              label="Branch"
              neededFor="Branch"
              hint="Without refs/heads/. A trailing * matches a prefix: release/*."
            >
              <Input
                name="branch"
                mono
                placeholder="main"
                suggestionsLabel="Used before"
                suggestions={[{ value: 'main', href: '?branch=main' }]}
              />
            </Field>
          </Reveal>
        </FormStep>
        <FormStep
          n={3}
          title="Allowed operations"
          live={5}
          countScope
          id={`${p}-ops`}
          description="Presets for the Slack Web API. Other calls are denied and show up in Requests."
        >
          <CheckPresets name={`${p}-ops`} options={slackOperations} value={['post']} />
          <SelectedCount total={4} />
        </FormStep>
        <FormStep n={4} title="Expires" live={6} id={`${p}-exp`}>
          <Picks name={`${p}-exp`} options={expiries} value="never" />
          <Reveal field={6} option={5} box={false}>
            <Field
              id={`${p}-date`}
              label="Last day"
              neededFor="On a date"
              hint="Access stops at the end of this day (UTC)."
            >
              <Input type="date" width="date" name="expires_on" />
            </Field>
          </Reveal>
        </FormStep>
      </Stepper>
      <RiskAcceptance
        id={`${p}-risk`}
        title="Accept 1 risk to save this access"
        risks={[
          {
            label: 'Pull request into',
            text: 'pull_request jobs run the code proposed in the pull request, and that code gets the Slack token.',
          },
        ]}
        confirm="I accept this risk for acme/api → Slack"
      />
      <SubmitRow hint="After saving you get the workflow snippet for these jobs.">
        <button class="btn primary" type="submit">
          Give access
        </button>
        <a class="btn secondary" href="?cancel">
          Cancel
        </a>
      </SubmitRow>
    </LiveForm>
  );
}

export const giveAccessCode = `<LiveForm method="post" action="/admin/access" rail={
  <LiveSummary id="sum" title="This access" description="Follows the choices in this form.">
    <SummaryRow
      logo={<LivePhrase field={1} decorative phrases={{ 1: githubLogo, 2: gitlabLogo, 3: buildkiteLogo }} empty={unknownLogo} />}
      title={<LivePhrase field={1} phrases={{ 1: 'GitHub Actions (acme)', 2: 'GitLab CI (platform)', 3: 'Buildkite (acme)' }} empty="Choose a consumer" />}
      meta={<>
        <LivePhrase field={2} phrases={{ 1: <span class="v">acme/api</span>, …, 5: 'the repository you enter' }} />
        <LivePhrase field={3} phrases={{
          1: <> · environment <LivePhrase field={4} phrases={{ 1: <span class="v">production</span>, … }} /></>,
          2: ' · the branch you enter', 3: ' · any protected ref',
          4: <span class="t-warn"> · pull requests (risk)</span>,
        }} />
      </>} />
    <SummaryWire />
    <SummaryRow glyph="→" title="May call" meta={
      <LivePhrase field={5} phrases={{ 1: <>Post messages<br /></>, … }}
        empty={<span class="t-bad">No operation chosen</span>} />} />
    <SummaryWire />
    <SummaryRow logo={slackLogo} title="Slack" meta="gate.acme.dev/proxy/slack" mono />
    <SummaryFoot>
      Expires <LivePhrase field={6} as="b" phrases={{ 1: 'never', 2: 'in 7 days', … }} />.{' '}
      <RiskSwitch safe="No risks." risk="1 risk to accept before Give access." />
    </SummaryFoot>
  </LiveSummary>
}>
  <FixedBar label="Token" logo={slackLogo} name="Slack" meta="/proxy/slack"
    status={<Badge tone="ok" glyph="✓">Secret set</Badge>}
    change={{ href: '/admin/access/new', context: 'token' }} />
  <Stepper>
    <FormStep n={1} title="Consumer" live={1} id="consumer">
      <RowPicker name="consumer" options={consumers} value="gha-acme" />
      <a class="btn ghost sm" href="/admin/consumers/new">+ Add a new consumer</a>
    </FormStep>
    <FormStep n={2} kind="group" id="jobs" title="Which jobs" description={…}>
      <FieldSet id="repo" legend="Repository" live={2} hint="…">
        <RowPicker name="repo" options={repositories} value="89012345" />
      </FieldSet>
      <Reveal field={2} option={5}>
        <Field id="repo-new" label="Repository name (ID)" neededFor="Another repository" hint="…">
          <Input name="repository" mono placeholder="acme/api (89012345)" />
        </Field>
      </Reveal>
      <FieldSet id="ctx" legend="When can its jobs use the token?" live={3}>
        <RadioCards name="ctx" options={contexts} value="environment" />
      </FieldSet>
      <Reveal field={3} option={1}>
        <FieldSet id="env" legend="Environment" neededFor="Environment" live={4} hint={…}>
          <Picks name="env" options={environments} value="production" />
        </FieldSet>
        <Reveal field={4} option={4} box={false}>
          <Field id="env-new" label="Environment name"><Input name="environment" mono placeholder="production" /></Field>
        </Reveal>
      </Reveal>
      <Reveal field={3} option={2}>
        <Field id="branch" label="Branch" neededFor="Branch" hint="…">
          <Input name="branch" mono placeholder="main" suggestions={[{ value: 'main', href: '?branch=main' }]} />
        </Field>
      </Reveal>
    </FormStep>
    <FormStep n={3} title="Allowed operations" live={5} countScope id="ops" description="…">
      <CheckPresets name="operations" options={operations} value={['post']} />
      <SelectedCount total={4} />
    </FormStep>
    <FormStep n={4} title="Expires" live={6} id="exp">
      <Picks name="exp" options={expiries} value="never" />
      <Reveal field={6} option={5} box={false}>
        <Field id="date" label="Last day" neededFor="On a date" hint="…">
          <Input type="date" width="date" name="expires_on" />
        </Field>
      </Reveal>
    </FormStep>
  </Stepper>
  <RiskAcceptance id="risk" title="Accept 1 risk to save this access"
    risks={[{ label: 'Pull request into', text: 'pull_request jobs run the code proposed …' }]}
    confirm="I accept this risk for acme/api → Slack" />
  <SubmitRow hint="After saving you get the workflow snippet for these jobs.">
    <button class="btn primary" type="submit">Give access</button>
    <a class="btn secondary" href="/admin/tokens/slack">Cancel</a>
  </SubmitRow>
</LiveForm>`;
