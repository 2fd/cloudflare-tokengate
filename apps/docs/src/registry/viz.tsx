// Docs entries of the "viz" group (packages/ui/src/components/viz). One ComponentDoc per
// component page, in nav order. Only the viz group agent edits this file.
import {
  ArrowRow,
  Chart,
  Checklist,
  ChecklistProgress,
  ConnectionsMap,
  Delta,
  Kpis,
  Legend,
  Matrix,
  NeedsAttention,
  NextStep,
  Panel,
  Pipeline,
  ReasonBar,
  SplitView,
  Trace,
  Tray,
  type AttentionItem,
  type KpiItem,
  type PipelineStage,
  type Reason,
  type TraceStep,
} from '@tokengate/ui';
import type { ComponentDoc } from './types';
import {
  accesses,
  consumers,
  dayBars,
  hourBars,
  matrixColumns,
  matrixGroups,
  requestItems,
  scaleAccesses,
  scaleConsumers,
  scaleTokens,
  scaleTokensFocused,
  tokens,
  tokensFocusedOnPlatform,
} from './viz-data';

// --- Shared example data ----------------------------------------------------------------------

const attention: AttentionItem[] = [
  {
    level: 'warn',
    title: 'The secret of OpenAI expires on 21 Oct 2026 (in 6 days).',
    body: 'Its 1 consumer access stops working then.',
    actions: (
      <a class="btn sm secondary" href="/admin/tokens/openai#secret">
        Replace secret
      </a>
    ),
  },
  {
    level: 'warn',
    title: '1 person needs a decision.',
    body: (
      <>
        <b>Sam Ito</b> · sam@acme.dev · signed in first 25 min ago. Approve as:
      </>
    ),
    approve: {
      action: '/admin/users/usr_sam/decide',
      subject: 'sam@acme.dev',
      roles: [
        { value: 'viewer', label: 'Viewer' },
        { value: 'token_manager', label: 'Token manager' },
        { value: 'access_manager', label: 'Access manager' },
        { value: 'admin', label: 'Admin' },
      ],
      more: { href: '/admin/users/usr_sam', label: 'Owner or reject…' },
    },
  },
  {
    level: 'warn',
    title:
      'Access “Slack for platform/deploy-tools (environment production)” expires on 24 Oct 2026.',
    actions: (
      <a class="btn sm secondary" href="/admin/access/acc_07#expiry">
        Extend
      </a>
    ),
  },
  {
    level: 'info',
    title: 'Only one active owner.',
    body: 'Invite a second owner so the deployment stays manageable if that account is lost.',
    actions: (
      <a class="btn sm secondary" href="/admin/users/invite">
        Invite
      </a>
    ),
  },
];

const stages: PipelineStage[] = [
  {
    label: 'Received',
    value: 8214,
    meta: (
      <>
        <Delta direction="up">6 %</Delta> vs previous 24 h
      </>
    ),
    href: '/admin/requests',
    totals: [
      {
        label: 'Denied',
        count: 241,
        share: '2.9 %',
        delta: { direction: 'up', tone: 'bad', children: '41 %' },
        href: '/admin/requests?outcome=denied',
      },
      {
        label: 'Errors',
        count: 12,
        share: '0.15 %',
        href: '/admin/requests?outcome=error',
        kind: 'error',
      },
    ],
  },
  {
    label: 'Caller verified',
    value: 8032,
    meta: '97.8 % of received',
    href: '/admin/requests?stage=verified',
    drop: {
      count: 182,
      unit: 'not recognized',
      why: 'Unknown issuer: no service consumer trusts it.',
      href: '/admin/requests?reason=issuer_unknown',
    },
  },
  {
    label: 'Access matched',
    value: 7973,
    meta: '97.1 % of received',
    href: '/admin/requests?stage=matched',
    drop: {
      count: 59,
      unit: 'no access',
      why: 'Verified callers that no consumer access allows.',
      href: '/admin/requests?reason=no_matching_grant',
    },
  },
  {
    label: 'Upstream OK · allowed',
    value: 7961,
    meta: '96.9 % · p50 38 ms · p95 212 ms',
    href: '/admin/requests?outcome=allowed',
    drop: {
      count: 12,
      unit: 'upstream errors',
      why: 'OpenAI answered 502 (11), Anthropic timed out (1).',
      href: '/admin/requests?reason=upstream_5xx',
      kind: 'error',
    },
  },
];

const deniedReasons: Reason[] = [
  {
    count: 182,
    label: 'Unknown issuer: no service consumer trusts it',
    short: 'unknown issuer',
    meta: '1 caller',
  },
  {
    count: 59,
    label: 'No consumer access allows this call',
    short: 'no access',
    meta: '2 callers',
  },
];

const kpis: KpiItem[] = [
  {
    label: 'Requests',
    value: 8214,
    delta: { direction: 'up', children: '6 %' },
    meta: 'vs previous 24 h',
    link: { href: '/admin/requests', label: 'See requests →' },
  },
  {
    label: 'Denied',
    swatch: 'denied',
    value: 241,
    unit: '2.9 %',
    delta: { direction: 'up', tone: 'warn', children: '41 %' },
    meta: 'vs previous 24 h',
    link: { href: '/admin/requests?outcome=denied', label: 'See denied →' },
    worst: true,
  },
  { label: 'Errors', swatch: 'error', value: 12, unit: '0.15 %', meta: 'OpenAI 11 · Anthropic 1' },
  { label: 'Latency', value: 212, unit: 'ms p95', meta: 'p50 38 ms' },
];

const deniedTrace: TraceStep[] = [
  { state: 'pass', title: 'Caller verified', detail: 'GitHub Actions (acme)' },
  { state: 'pass', title: 'Token found', detail: '/proxy/slack → Slack' },
  {
    state: 'fail',
    status: 'Failed, stopped here',
    title: 'Access matched',
    detail: (
      <>
        acme/web · branch <mark>feature/login-redesign</mark>
      </>
    ),
  },
  { state: 'notrun', title: 'Upstream call', detail: 'Slack was not called' },
];

const giveAccess = (
  <NextStep
    title="Give access from this request."
    prefill={[
      { label: 'GitHub Actions (acme)', logo: { brand: 'github' } },
      { label: 'acme/web', mono: true },
      {
        label: (
          <>
            branch <span class="mono">feature/login-redesign</span>
          </>
        ),
      },
      { label: 'Slack', logo: { brand: 'slack' } },
    ]}
    actions={
      <>
        <a class="btn primary" href="/admin/access/new?from_request=req_01JB8Z5K2Q7W3N4M6P8R9T0V1X">
          Give access from this request
        </a>
        <a class="btn secondary" href="/admin/access?consumer=github-acme&amp;token=slack">
          Compare with existing accesses
        </a>
      </>
    }
  >
    The form opens with these values filled in; you choose only what is missing.
  </NextStep>
);

const viewSwitch = (current: 'map' | 'matrix') => (
  <nav class="seg sm" aria-label="View">
    <a href="/admin/access" aria-current={current === 'map' ? 'page' : undefined}>
      Map
    </a>
    <a href="/admin/access?view=matrix" aria-current={current === 'matrix' ? 'page' : undefined}>
      Matrix
    </a>
  </nav>
);

const rangeSwitch = (
  <nav class="seg sm" aria-label="Range">
    <a href="?range=24h" aria-current="page">
      24 hours
    </a>
    <a href="?range=7d">7 days</a>
    <a href="?range=30d">30 days</a>
  </nav>
);

const chartLegend = (
  <Legend
    decorative
    items={[
      { mark: 'allowed', label: 'Allowed' },
      { mark: 'denied', label: 'Denied' },
      { mark: 'error', label: 'Errors' },
    ]}
  />
);

const CLASS_PROP = { name: 'class', type: 'string', description: 'Extra classes on the root.' };

// --- Pages ------------------------------------------------------------------------------------

export const viz: readonly ComponentDoc[] = [
  {
    slug: 'needs-attention',
    name: 'NeedsAttention',
    summary:
      'One card per problem, worst first: its level, one sentence, the consequence and the fix in place.',
    usage: {
      when: [
        'The first block of the Overview: expiring secrets, people waiting for a role, expiring accesses, owner notes.',
        'A short list of decisions on a section page ("Needs your decision" on People), with the list layout.',
      ],
      whenNot: [
        <>
          A problem that blocks the whole install (keyring unavailable): use the health strip of the
          app shell.
        </>,
        <>
          The result of an action the user just took: use a notice (<code>.callout.notice</code>).
        </>,
      ],
    },
    examples: [
      {
        title: 'Overview row',
        description:
          'Four cards with 1px gap lines (2 per row below 80rem, 1 below 40rem). Inline fixes are small secondary buttons; approving a person is one click per role.',
        layout: 'stack',
        render: () => (
          <Tray
            id="na-ex"
            level={3}
            title="Needs attention"
            count={4}
            actions={<span class="meta">3 warnings · 1 note · health checks all OK</span>}
          >
            <Panel>
              <NeedsAttention items={attention} />
            </Panel>
          </Tray>
        ),
        code: `<Tray id="ov-attention" title="Needs attention" count={4}
  actions={<span class="meta">3 warnings · 1 note · health checks all OK</span>}>
  <Panel>
    <NeedsAttention items={[
      { level: 'warn',
        title: 'The secret of OpenAI expires on 21 Oct 2026 (in 6 days).',
        body: 'Its 1 consumer access stops working then.',
        actions: <a class="btn sm secondary" href="/admin/tokens/openai#secret">Replace secret</a> },
      { level: 'warn',
        title: '1 person needs a decision.',
        body: <><b>Sam Ito</b> · sam@acme.dev · signed in first 25 min ago. Approve as:</>,
        approve: {
          action: '/admin/users/usr_sam/decide',
          subject: 'sam@acme.dev',
          roles: [{ value: 'viewer', label: 'Viewer' }, { value: 'token_manager', label: 'Token manager' },
                  { value: 'access_manager', label: 'Access manager' }, { value: 'admin', label: 'Admin' }],
          more: { href: '/admin/users/usr_sam', label: 'Owner or reject…' } } },
      { level: 'warn', title: 'Access “Slack for platform/deploy-tools …” expires on 24 Oct 2026.',
        actions: <a class="btn sm secondary" href="/admin/access/acc_07#expiry">Extend</a> },
      { level: 'info', title: 'Only one active owner.',
        body: 'Invite a second owner so the deployment stays manageable if that account is lost.',
        actions: <a class="btn sm secondary" href="/admin/users/invite">Invite</a> },
    ]} />
  </Panel>
</Tray>`,
      },
      {
        title: 'Stacked list and the three levels',
        description:
          'layout="list" stacks the cards with a divider, for a narrow column or a section page. Levels: Warning (!), Note (i) and Error (✕).',
        layout: 'stack',
        render: () => (
          <Tray id="na-ex-list" level={3} title="To review" count={3}>
            <Panel>
              <NeedsAttention
                layout="list"
                items={[
                  {
                    level: 'bad',
                    title: 'Anthropic answered 401 to the last 3 calls.',
                    body: 'The secret was probably revoked upstream. Calls fail until you replace it.',
                    actions: (
                      <a class="btn sm secondary" href="/admin/tokens/anthropic#secret">
                        Replace secret
                      </a>
                    ),
                  },
                  {
                    level: 'warn',
                    title: 'Buildkite (acme) has been idle for 41 days.',
                    body: 'Its access to Slack (legacy) is inactive.',
                    actions: (
                      <a class="btn sm secondary" href="/admin/consumers/buildkite-acme">
                        Review consumer
                      </a>
                    ),
                  },
                  {
                    level: 'info',
                    title: 'Request logs are kept for 30 days.',
                    actions: (
                      <a class="btn sm secondary" href="/admin/retention">
                        Change retention
                      </a>
                    ),
                  },
                ]}
              />
            </Panel>
          </Tray>
        ),
        code: `<NeedsAttention layout="list" items={[
  { level: 'bad', title: 'Anthropic answered 401 to the last 3 calls.',
    body: 'The secret was probably revoked upstream. Calls fail until you replace it.',
    actions: <a class="btn sm secondary" href="/admin/tokens/anthropic#secret">Replace secret</a> },
  { level: 'warn', title: 'Buildkite (acme) has been idle for 41 days.', … },
  { level: 'info', title: 'Request logs are kept for 30 days.', … },
]} />`,
      },
    ],
    props: [
      {
        component: 'NeedsAttention',
        props: [
          {
            name: 'items',
            type: 'readonly AttentionItem[]',
            required: true,
            description: (
              <>
                Worst first. Each: <code>level</code> (<code>'warn' | 'info' | 'bad'</code>),{' '}
                <code>levelLabel?</code> (default Warning, Note, Error), <code>title</code>,{' '}
                <code>body?</code>, and either <code>actions?</code> (the inline fix) or{' '}
                <code>approve?</code>.
              </>
            ),
          },
          {
            name: 'items[].approve',
            type: 'AttentionApprove',
            description: (
              <>
                Approve-as-role form: <code>action</code> (POST), <code>subject</code> (named in
                every button), <code>roles</code> (<code>{'{ value, label }[]'}</code>),{' '}
                <code>name?</code> (default <code>role</code>), <code>hidden?</code> (CSRF token,
                ids) and <code>more?</code> (the link for Owner or reject).
              </>
            ),
          },
          {
            name: 'layout',
            type: "'cols' | 'list'",
            default: "'cols'",
            description: 'Card row with gap lines, or stacked rows.',
          },
          CLASS_PROP,
        ],
      },
    ],
    accessibility: [
      'The level is a word ("Warning"); the glyph tile is hidden from assistive tech.',
      'Each role button is named "Approve sam@acme.dev as Viewer": the visible role plus a hidden prefix, so the name contains the visible label.',
      'Approving is a plain POST form with one submit button per role: no script, works with the keyboard and without JavaScript.',
      'Put the list in a tray whose heading says "Needs attention" and the count; the list itself has no extra name.',
    ],
    do: [
      'Write the title as the fact and the date ("expires on 21 Oct 2026 (in 6 days)"), the body as the consequence.',
      'Offer the fix in place: one small secondary button, or the role buttons.',
      'Order by level, then by date.',
    ],
    dont: [
      'Do not use a primary button in a card: the page header keeps the one primary.',
      'Do not show more than 4 cards in the row; link the rest from the tray header.',
      'Do not put a confirmation step behind a role button: the role can be changed later.',
    ],
    classes: [
      'att',
      'cols',
      'att-lvl',
      'warn',
      'info',
      'bad',
      'g',
      'att-t',
      'att-b',
      'att-a',
      'roles',
      'linkish',
    ],
  },
  {
    slug: 'pipeline',
    name: 'Pipeline',
    summary:
      'Where calls went: four stages from Received to Upstream OK, with the calls lost at each step hanging below it.',
    usage: {
      when: [
        'The traffic block of the Overview: Received → Caller verified → Access matched → Upstream OK.',
        'Any funnel where every stage and every drop is a link to the filtered request list.',
      ],
      whenNot: ['Traffic over time: use Chart.', 'Numbers without a flow between them: use Kpis.'],
    },
    examples: [
      {
        title: 'Where calls went',
        description:
          'The Overview tray: the pipeline, the denied reasons under it and the series legend in the footer. Totals sit under the first stage; upstream errors use the warn tone.',
        layout: 'stack',
        render: () => (
          <>
            <Tray
              id="pp-ex"
              level={3}
              title="Where calls went"
              description={
                <>
                  8,214 calls in the last 24 hours. <b class="t-bad">241 were denied (2.9 %)</b>, up
                  41 % from the previous 24 hours.
                </>
              }
              actions={rangeSwitch}
              footer={
                <Legend
                  items={[
                    { mark: 'allowed', label: 'Allowed' },
                    { mark: 'denied', label: 'Denied' },
                    { mark: 'error', label: 'Errors' },
                  ]}
                />
              }
            >
              <Panel>
                <Pipeline stages={stages} />
              </Panel>
              <Panel variant="pad">
                <ReasonBar title="Denied by reason" reasons={deniedReasons} />
              </Panel>
            </Tray>
          </>
        ),
        code: `<Tray id="ov-pipe" title="Where calls went" description={…} actions={rangeSwitch}
  footer={<Legend items={[{ mark: 'allowed', label: 'Allowed' }, { mark: 'denied', label: 'Denied' },
                          { mark: 'error', label: 'Errors' }]} />}>
  <Panel>
    <Pipeline stages={[
      { label: 'Received', value: 8214, href: '/admin/requests',
        meta: <><Delta direction="up">6 %</Delta> vs previous 24 h</>,
        totals: [
          { label: 'Denied', count: 241, share: '2.9 %', href: '/admin/requests?outcome=denied',
            delta: { direction: 'up', tone: 'bad', children: '41 %' } },
          { label: 'Errors', count: 12, share: '0.15 %', href: '/admin/requests?outcome=error', kind: 'error' },
        ] },
      { label: 'Caller verified', value: 8032, meta: '97.8 % of received', href: '…',
        drop: { count: 182, unit: 'not recognized', why: 'Unknown issuer: no service consumer trusts it.',
                href: '/admin/requests?reason=issuer_unknown' } },
      { label: 'Access matched', value: 7973, meta: '97.1 % of received', href: '…',
        drop: { count: 59, unit: 'no access', why: 'Verified callers that no consumer access allows.', href: '…' } },
      { label: 'Upstream OK · allowed', value: 7961, meta: '96.9 % · p50 38 ms · p95 212 ms', href: '…',
        drop: { count: 12, unit: 'upstream errors', kind: 'error',
                why: 'OpenAI answered 502 (11), Anthropic timed out (1).', href: '…' } },
    ]} />
  </Panel>
  <Panel variant="pad"><ReasonBar title="Denied by reason" reasons={…} /></Panel>
</Tray>`,
      },
      {
        title: 'Quiet day, read only',
        description:
          'Stages without href are not links and have no link line; a stage without a drop leaves its slot empty.',
        layout: 'stack',
        render: () => (
          <Panel>
            <Pipeline
              label="Where calls went, last 24 hours"
              stages={[
                { label: 'Received', value: 412, meta: '0 denied, 0 errors' },
                { label: 'Caller verified', value: 412, meta: '100 % of received' },
                { label: 'Access matched', value: 412, meta: '100 % of received' },
                { label: 'Upstream OK · allowed', value: 412, meta: 'p50 41 ms · p95 180 ms' },
              ]}
            />
          </Panel>
        ),
        code: `<Panel>
  <Pipeline label="Where calls went, last 24 hours" stages={[
    { label: 'Received', value: 412, meta: '0 denied, 0 errors' },
    { label: 'Caller verified', value: 412, meta: '100 % of received' },
    { label: 'Access matched', value: 412, meta: '100 % of received' },
    { label: 'Upstream OK · allowed', value: 412, meta: 'p50 41 ms · p95 180 ms' },
  ]} />
</Panel>`,
      },
    ],
    props: [
      {
        component: 'Pipeline',
        props: [
          {
            name: 'stages',
            type: 'readonly PipelineStage[]',
            required: true,
            description: (
              <>
                In order; four fill a row. Each: <code>label</code>, <code>value</code> (numbers get
                separators), <code>meta?</code>, <code>href?</code>, <code>go?</code> (link line,
                default "See requests"), <code>drop?</code>, <code>totals?</code>.
              </>
            ),
          },
          {
            name: 'stages[].drop',
            type: 'PipelineDrop',
            description: (
              <>
                <code>count</code>, <code>unit</code>, <code>why</code>, <code>href?</code>,{' '}
                <code>go?</code> (default "See N requests"), <code>kind?</code> (
                <code>'denied'</code> red, <code>'error'</code> warn).
              </>
            ),
          },
          {
            name: 'stages[].totals',
            type: 'readonly PipelineTotal[]',
            description: (
              <>
                Under the first stage: <code>label</code>, <code>count</code>, <code>share?</code>,{' '}
                <code>delta?</code>, <code>href</code>, <code>kind?</code>.
              </>
            ),
          },
          {
            name: 'label',
            type: 'string',
            description: 'Accessible name of the list, when no tray title says it.',
          },
          CLASS_PROP,
        ],
      },
    ],
    accessibility: [
      'An ordered list: the order of the stages is the order of the checks.',
      'Each stage and drop is one link; its name reads the label, the number and the link line. The arrow after "See requests" is hidden.',
      'Arrows between stages and the drop stems are CSS, so nothing decorative is read.',
      'Below 40rem the stages stack with a ↓ between them (CSS content, not read).',
    ],
    do: [
      'Link every stage and drop to the request list filtered to it.',
      'Say why calls dropped in words ("Unknown issuer: no service consumer trusts it.").',
      'Put the reasons bar under the pipeline in the same tray.',
    ],
    dont: [
      'Do not show more than four stages.',
      'Do not color a stage: only drops carry red or warn.',
    ],
    classes: [
      'pipe',
      'pipe-step',
      'stage',
      'in',
      'out',
      'lbl',
      'big',
      'stage-go',
      'drop',
      'err',
      'drop-n',
      'drop-why',
      'drop-go',
      'pipe-tot',
      'tl',
    ],
  },
  {
    slug: 'kpis',
    name: 'Kpis',
    related: ['Delta'],
    summary:
      'A row of KPI tiles: label, big number with its unit, the change and a link to the list.',
    usage: {
      when: [
        'Headline numbers of a detail page (allowed requests of an access, token traffic).',
        'A summary row above a table, when each number links to a filtered list.',
      ],
      whenNot: [
        'Numbers that flow into each other (received → allowed): use Pipeline.',
        'A number inside a sentence: write the sentence.',
      ],
    },
    examples: [
      {
        title: 'Traffic tiles',
        description:
          'Only the worst tile takes the warn tone; marking two tiles worst tones the first only. Swatches match the chart series.',
        layout: 'stack',
        render: () => <Kpis items={kpis} />,
        code: `<Kpis items={[
  { label: 'Requests', value: 8214, delta: { direction: 'up', children: '6 %' },
    meta: 'vs previous 24 h', link: { href: '/admin/requests', label: 'See requests →' } },
  { label: 'Denied', swatch: 'denied', value: 241, unit: '2.9 %', worst: true,
    delta: { direction: 'up', tone: 'warn', children: '41 %' }, meta: 'vs previous 24 h',
    link: { href: '/admin/requests?outcome=denied', label: 'See denied →' } },
  { label: 'Errors', swatch: 'error', value: 12, unit: '0.15 %', meta: 'OpenAI 11 · Anthropic 1' },
  { label: 'Latency', value: 212, unit: 'ms p95', meta: 'p50 38 ms' },
]} />`,
      },
      {
        title: 'Two tiles in a tray',
        layout: 'stack',
        render: () => (
          <Tray id="kpi-ex-tray" level={3} title="Activity" description="Last 14 days">
            <Kpis
              items={[
                {
                  label: 'Allowed requests',
                  value: 4020,
                  meta: 'Last used 22 min ago · 0 denied',
                  link: {
                    href: '/admin/requests?access=acc_01',
                    label: 'See requests of this access',
                  },
                },
                {
                  label: 'Denied',
                  swatch: 'denied',
                  value: 0,
                  delta: { direction: 'none', children: '0 %' },
                  meta: 'vs previous 14 days',
                },
              ]}
            />
          </Tray>
        ),
        code: `<Tray id="acc-activity" title="Activity" description="Last 14 days">
  <Kpis items={[
    { label: 'Allowed requests', value: 4020, meta: 'Last used 22 min ago · 0 denied',
      link: { href: '/admin/requests?access=acc_01', label: 'See requests of this access' } },
    { label: 'Denied', swatch: 'denied', value: 0,
      delta: { direction: 'none', children: '0 %' }, meta: 'vs previous 14 days' },
  ]} />
</Tray>`,
      },
      {
        title: 'Delta',
        description: 'Neutral by default; bad or warn only when the change needs attention.',
        render: () => (
          <>
            <Delta direction="up">6 %</Delta>
            <Delta direction="down">3 %</Delta>
            <Delta direction="up" tone="bad">
              41 %
            </Delta>
            <Delta direction="up" tone="warn">
              41 %
            </Delta>
            <Delta direction="none">0 %</Delta>
          </>
        ),
        code: `<Delta direction="up">6 %</Delta>
<Delta direction="down">3 %</Delta>
<Delta direction="up" tone="bad">41 %</Delta>
<Delta direction="up" tone="warn">41 %</Delta>
<Delta direction="none">0 %</Delta>`,
      },
    ],
    props: [
      {
        component: 'Kpis',
        props: [
          {
            name: 'items',
            type: 'readonly KpiItem[]',
            required: true,
            description: (
              <>
                Each: <code>label</code>, <code>value</code> (numbers get separators),{' '}
                <code>unit?</code>, <code>swatch?</code> (
                <code>'allowed' | 'denied' | 'error' | 'bad'</code>), <code>delta?</code>,{' '}
                <code>meta?</code>, <code>extra?</code> (a small chart), <code>link?</code>,{' '}
                <code>worst?</code>.
              </>
            ),
          },
          CLASS_PROP,
        ],
      },
      {
        component: 'Delta',
        props: [
          {
            name: 'direction',
            type: "'up' | 'down' | 'none'",
            required: true,
            description: 'Read as "up", "down" or "no change"; the ▲ ▼ glyph is hidden.',
          },
          {
            name: 'tone',
            type: "'bad' | 'warn'",
            description: 'Only for bad news. Neutral gray otherwise.',
          },
          { name: 'class', type: 'string', description: 'Extra classes on the span.' },
          {
            name: 'children',
            type: 'Child',
            required: true,
            description: 'The amount, formatted: "6 %".',
          },
        ],
      },
    ],
    accessibility: [
      'A description list: each tile is a dt (the label) and its dd values, so the label is read with the number.',
      'The delta reads "up 6 %"; the arrow glyph is hidden.',
      'The warn tone is never the only signal: the label and the link say what is wrong.',
    ],
    do: [
      'Put the unit or share next to the number ("241 2.9 %"), not in the label.',
      'Link each tile to the list behind the number.',
    ],
    dont: [
      'Do not tone more than one tile.',
      'Do not show a delta without what it compares to ("vs previous 24 h").',
    ],
    classes: ['kpis', 'kpi', 'tone-warn', 'kpi-n', 'kpi-m', 'kpi-l', 'delta', 'bad', 'warn', 'sw'],
  },
  {
    slug: 'chart',
    name: 'Chart',
    related: ['ChartPatterns', 'Legend'],
    summary:
      'A server-computed stacked bar chart of allowed, denied and error requests, with its numbers as a table.',
    usage: {
      when: [
        'Requests over time: per hour for 24 hours, per day for 7 or 30 days.',
        'Anywhere the reader looks for a peak or a jump in denials.',
      ],
      whenNot: ['One total: use Kpis.', 'Shares of one total (denied by reason): use ReasonBar.'],
    },
    examples: [
      {
        title: 'Requests per hour',
        description:
          'The tray header states the finding; the legend there is decorative because the chart description names the series. Bars are stacked allowed (gray), errors (dotted) and denied (hatched); the running hour is lighter. ChartPatterns is rendered once on the page.',
        layout: 'stack',
        render: () => (
          <>
            <Tray
              id="ch-ex"
              level={3}
              title="Requests per hour"
              description="Peak 640 at 12:00. Denials jumped at 12:00 (48) and 13:00 (61). UTC; the last bar is so far."
              actions={chartLegend}
            >
              <Chart
                id="ch-ex-c"
                title="Requests per hour, last 24 hours"
                description="8,214 requests: 7,961 allowed, 241 denied, 12 errors. Peak 640 requests at 12:00. The 14:00 bar is so far."
                bars={hourBars}
              />
            </Tray>
          </>
        ),
        code: `<ChartPatterns />  {/* once per page */}
<Tray id="ov-chart" title="Requests per hour"
  description="Peak 640 at 12:00. Denials jumped at 12:00 (48) and 13:00 (61). UTC; the last bar is so far."
  actions={<Legend decorative items={[{ mark: 'allowed', label: 'Allowed' },
    { mark: 'denied', label: 'Denied' }, { mark: 'error', label: 'Errors' }]} />}>
  <Chart id="ov-chart-c" title="Requests per hour, last 24 hours"
    description="8,214 requests: 7,961 allowed, 241 denied, 12 errors. Peak 640 requests at 12:00. The 14:00 bar is so far."
    bars={[
      { label: '15:00', range: '15:00–16:00', allowed: 402, denied: 8, errors: 0 },
      …
      { label: '14:00', range: '14:00–15:00', allowed: 62, denied: 1, errors: 1, partial: true },
    ]} />
</Tray>`,
      },
      {
        title: 'Last 7 days',
        description:
          'Fewer bars stay bars (48 units at most). Every bar is labelled, there is no end label, and the table header says Day.',
        layout: 'stack',
        render: () => (
          <Tray
            id="ch-ex-week"
            level={3}
            title="Requests per day"
            description="Weekdays carry 7,000 to 7,700 calls; Wednesday is so far."
          >
            <Chart
              id="ch-ex-week-c"
              title="Requests per day, last 7 days"
              description="38,013 requests over 7 days. Denials rose from 98 on Thursday to 199 on Wednesday."
              bars={dayBars}
              tickEvery={1}
              endLabel=""
              columnLabel="Day"
            />
          </Tray>
        ),
        code: `<Chart id="tok-week" title="Requests per day, last 7 days"
  description="38,013 requests over 7 days. Denials rose from 98 on Thursday to 199 on Wednesday."
  bars={days} tickEvery={1} endLabel="" columnLabel="Day" />`,
      },
      {
        title: 'Legend marks',
        description:
          'Chart swatches, connections-map wires and matrix cells. The mark is hidden; the word is read.',
        layout: 'stack',
        render: () => (
          <>
            <Legend
              as="p"
              items={[
                { mark: 'allowed', label: 'Allowed' },
                { mark: 'denied', label: 'Denied' },
                { mark: 'error', label: 'Errors' },
                { mark: 'bad', label: 'Unknown issuer' },
              ]}
            />
            <Legend
              as="p"
              items={[
                { mark: 'wire', label: 'Active' },
                { mark: 'wire-warn', label: 'Needs attention' },
                { mark: 'wire-off', label: 'Inactive' },
                { mark: 'wire-on', label: 'Focused consumer' },
                { mark: 'wire-dim', label: 'Other consumers' },
              ]}
            />
            <Legend
              as="p"
              items={[
                { mark: 'cell', label: 'Active' },
                { mark: 'cell-warn', label: 'Expiring or risk' },
                { mark: 'cell-bad', label: 'Expired' },
                { mark: 'cell-off', label: 'Inactive' },
              ]}
            />
          </>
        ),
        code: `<Legend as="p" items={[{ mark: 'allowed', label: 'Allowed' }, { mark: 'denied', label: 'Denied' },
  { mark: 'error', label: 'Errors' }, { mark: 'bad', label: 'Unknown issuer' }]} />
<Legend as="p" items={[{ mark: 'wire', label: 'Active' }, { mark: 'wire-warn', label: 'Needs attention' },
  { mark: 'wire-off', label: 'Inactive' }, { mark: 'wire-on', label: 'Focused consumer' },
  { mark: 'wire-dim', label: 'Other consumers' }]} />
<Legend as="p" items={[{ mark: 'cell', label: 'Active' }, { mark: 'cell-warn', label: 'Expiring or risk' },
  { mark: 'cell-bad', label: 'Expired' }, { mark: 'cell-off', label: 'Inactive' }]} />`,
      },
    ],
    props: [
      {
        component: 'Chart',
        props: [
          {
            name: 'id',
            type: 'string',
            required: true,
            description: 'Prefix of the title and description ids. Unique on the page.',
          },
          {
            name: 'title',
            type: 'string',
            required: true,
            description: 'Accessible name; also names the numbers region.',
          },
          {
            name: 'description',
            type: 'string',
            required: true,
            description: 'The finding in a sentence or two: totals, peak, what changed.',
          },
          {
            name: 'bars',
            type: 'readonly ChartBar[]',
            required: true,
            description: (
              <>
                Oldest first. Each: <code>label</code>, <code>range?</code> (tooltip),{' '}
                <code>allowed</code>, <code>denied</code>, <code>errors</code>,{' '}
                <code>partial?</code> (still running: lighter, "so far").
              </>
            ),
          },
          {
            name: 'tickEvery',
            type: 'number',
            default: '3',
            description: 'Label every n-th bar on the x axis.',
          },
          {
            name: 'endLabel',
            type: 'string',
            default: "'now'",
            description: "Label at the right end of the axis; '' for none.",
          },
          {
            name: 'columnLabel',
            type: 'string',
            default: "'Hour (UTC)'",
            description: 'First column of the numbers table.',
          },
          {
            name: 'numbersLabel',
            type: 'string',
            default: "'Show the numbers'",
            description: 'Summary of the numbers disclosure.',
          },
          { name: 'class', type: 'string', description: 'Extra classes on the chart panel.' },
        ],
      },
      { component: 'ChartPatterns', props: [] },
      {
        component: 'Legend',
        props: [
          {
            name: 'items',
            type: 'readonly LegendItem[]',
            required: true,
            description: (
              <>
                <code>{'{ mark, label }'}</code>. Marks: <code>allowed</code>, <code>denied</code>,{' '}
                <code>error</code>, <code>bad</code>; <code>wire</code>, <code>wire-warn</code>,{' '}
                <code>wire-off</code>, <code>wire-on</code>, <code>wire-dim</code>;{' '}
                <code>cell</code>, <code>cell-warn</code>, <code>cell-bad</code>,{' '}
                <code>cell-off</code>.
              </>
            ),
          },
          {
            name: 'decorative',
            type: 'boolean',
            default: 'false',
            description: 'Hide the legend when the chart text already names the series.',
          },
          {
            name: 'as',
            type: "'span' | 'p'",
            default: "'span'",
            description: 'p for a legend that is a block of its own.',
          },
          CLASS_PROP,
        ],
      },
    ],
    accessibility: [
      'The chart is one image (role img) named by its title and described by its description: write the finding there, not "a bar chart".',
      'Every bar has a tooltip title with its numbers; the same numbers are a real table in the "Show the numbers" disclosure, in a focusable, named scroll region.',
      'Denied and errors differ by pattern (hatched, dotted), not only by color; a non-zero count is at least 2.5 units tall.',
      'Axis text is in viewBox units and grows on phones (24 units below 40rem) so it stays readable.',
    ],
    do: [
      'State the finding in the tray description ("Denials jumped at 12:00").',
      'Render ChartPatterns once on every page that shows a chart or a reasons bar.',
      'Mark the running period as partial.',
    ],
    dont: [
      'Do not draw a chart in the browser: there is no script; compute it on the server.',
      'Do not mix more than the three series.',
      'Do not leave out the numbers table.',
    ],
    classes: [
      'chart',
      'gridl',
      'axis',
      'bar',
      'so-far',
      'b-allowed',
      'b-denied',
      'b-error',
      'numbers',
      'legend',
      'sw',
      'allowed',
      'denied',
      'error',
      'hatch-bg',
      'hatch-ln',
      'dots-bg',
      'dots-dot',
    ],
  },
  {
    slug: 'reason-bar',
    name: 'ReasonBar',
    summary:
      'One 12px bar split by reason, then a row per reason with its swatch, count, words and share.',
    usage: {
      when: [
        'Denied requests by reason under the pipeline.',
        'Any total split into two to four named parts.',
      ],
      whenNot: ['Change over time: use Chart.', 'More than four parts: use a table.'],
    },
    examples: [
      {
        title: 'Denied by reason',
        description: 'Kinds follow the position: solid red, then hatched, then dotted.',
        layout: 'stack',
        render: () => (
          <>
            <Panel variant="pad">
              <ReasonBar title="Denied by reason" reasons={deniedReasons} />
            </Panel>
          </>
        ),
        code: `<Panel variant="pad">
  <ReasonBar title="Denied by reason" reasons={[
    { count: 182, label: 'Unknown issuer: no service consumer trusts it', short: 'unknown issuer', meta: '1 caller' },
    { count: 59, label: 'No consumer access allows this call', short: 'no access', meta: '2 callers' },
  ]} />
</Panel>`,
      },
      {
        title: 'Errors, explicit kinds, no heading',
        description: 'heading={false} when the tray title already says what is split.',
        layout: 'stack',
        render: () => (
          <Tray id="rb-ex-err" level={3} title="Upstream errors" count={12}>
            <Panel variant="pad">
              <ReasonBar
                title="Upstream errors by cause"
                heading={false}
                reasons={[
                  { count: 11, label: 'OpenAI answered 502', short: 'OpenAI 502', kind: 'error' },
                  {
                    count: 1,
                    label: 'Anthropic timed out after 30 s',
                    short: 'timeout',
                    kind: 'bad',
                  },
                ]}
              />
            </Panel>
          </Tray>
        ),
        code: `<ReasonBar title="Upstream errors by cause" heading={false} reasons={[
  { count: 11, label: 'OpenAI answered 502', short: 'OpenAI 502', kind: 'error' },
  { count: 1, label: 'Anthropic timed out after 30 s', short: 'timeout', kind: 'bad' },
]} />`,
      },
    ],
    props: [
      {
        component: 'ReasonBar',
        props: [
          {
            name: 'title',
            type: 'string',
            required: true,
            description: 'What is split; the heading and the start of the bar name.',
          },
          {
            name: 'reasons',
            type: 'readonly Reason[]',
            required: true,
            description: (
              <>
                Biggest first. Each: <code>count</code>, <code>label</code>, <code>short</code> (for
                the bar name), <code>meta?</code>, <code>kind?</code> (
                <code>'bad' | 'denied' | 'error'</code>).
              </>
            ),
          },
          {
            name: 'heading',
            type: 'boolean',
            default: 'true',
            description: 'Render the h3 with the total.',
          },
          { name: 'class', type: 'string', description: 'Extra classes on the svg.' },
        ],
      },
    ],
    accessibility: [
      'The bar is an image named with every count: "Denied by reason: 182 unknown issuer, 59 no access".',
      'The list under it carries the same numbers as text; swatches are hidden.',
      'Segments differ by pattern as well as color.',
    ],
    do: [
      'Write each reason as a sentence a person can act on.',
      'Keep the share column: it is hidden on phones only.',
    ],
    dont: [
      'Do not use it for one reason: say the number.',
      'Do not reorder reasons by kind; order by count.',
    ],
    classes: ['rbar', 'r-bad', 'r-hatch', 'r-err', 'reasons', 'sw', 'n', 'pct'],
  },
  {
    slug: 'connections-map',
    name: 'ConnectionsMap',
    summary:
      'Service consumers on the left, service tokens on the right, one server-drawn wire per consumer–token pair.',
    usage: {
      when: [
        'The "Tokens in use" tray of the Overview and the Map view of Consumer access (the same markup on both).',
        'Answering "who can call what" at a glance, with the last 24 hours of traffic on each token.',
      ],
      whenNot: [
        'Every access with its constraint: use Matrix (the map links to it).',
        'One consumer or one token: use a list of ArrowRow.',
      ],
    },
    examples: [
      {
        title: 'Shared data set',
        description:
          '3 consumers, 6 tokens, 9 accesses. The busiest consumer spans 4 rows so it sits across from its tokens; wires are the worst state of the pair. The list form is in the disclosure under the map. Below 64rem the wires drop out and the sides stack.',
        layout: 'stack',
        render: () => (
          <Tray
            id="cm-ex"
            level={3}
            title="Tokens in use"
            description="Who calls which token through tokengate, with the last 24 hours of traffic. Each line is a consumer access."
            actions={viewSwitch('map')}
          >
            <ConnectionsMap
              id="cm-ex-map"
              consumers={consumers}
              tokens={tokens}
              accesses={accesses}
              footer={
                <>
                  Refused before a token was chosen: <b class="t-bad">182</b> ·{' '}
                  <a href="/admin/requests?token=none">See them</a>
                </>
              }
            />
          </Tray>
        ),
        code: `<Tray id="ov-map" title="Tokens in use" description="…" actions={viewSwitch}>
  <ConnectionsMap id="ov-map-m"
    consumers={[{ id: 'github-acme', name: 'GitHub Actions (acme)', line: 'org acme (1234567)',
                  logo: { brand: 'github' } }, …]}
    tokens={[{ id: 'openai', name: 'OpenAI', slug: 'openai', logo: { brand: 'openai' },
               line: '⌛ Secret expires in 6 days', lineTone: 'warn',
               requests: 3902, denied: 21, errors: 11, lastUsed: '1 min ago' }, …]}
    accesses={[{ consumer: 'github-acme', token: 'openai', status: 'Active',
                 consumerLabel: 'GitHub Actions (acme) › acme/api', context: 'environment production',
                 operation: 'Chat completions' }, …]}
    footer={<>Refused before a token was chosen: <b class="t-bad">182</b> · <a href="/admin/requests?token=none">See them</a></>} />
</Tray>`,
      },
      {
        title: 'Focused on one consumer',
        description:
          'focus comes from ?focus=: the consumer and its tokens light up, its wires are drawn on top, the rest dims (still AA) and links to its own focus. The list shows only its accesses.',
        layout: 'stack',
        render: () => (
          <Tray
            id="cm-ex-focus"
            level={3}
            title="Tokens in use"
            description="Focused on GitLab CI (platform): 2 accesses."
            actions={viewSwitch('map')}
          >
            <ConnectionsMap
              id="cm-ex-focus-map"
              consumers={consumers}
              tokens={tokensFocusedOnPlatform}
              accesses={accesses}
              focus="gitlab-platform"
            />
          </Tray>
        ),
        code: `<ConnectionsMap id="acc-map" consumers={consumers} tokens={tokens} accesses={accesses}
  focus={c.req.query('focus')} />`,
      },
      {
        title: 'At scale',
        description:
          '14 consumers, 9 tokens. At most 7 rows per side: the 6 busiest and one group node that opens the matrix filtered to the rest, with a note above the map.',
        layout: 'stack',
        render: () => (
          <Tray
            id="cm-ex-scale"
            level={3}
            title="Tokens in use"
            description="31 accesses between 14 consumers and 9 tokens."
            actions={viewSwitch('map')}
          >
            <ConnectionsMap
              id="cm-ex-scale-map"
              consumers={scaleConsumers}
              tokens={scaleTokens}
              accesses={scaleAccesses}
            />
          </Tray>
        ),
        code: `<ConnectionsMap id="acc-map" consumers={consumers /* 14 */} tokens={tokens /* 9 */}
  accesses={accesses /* 31 */} />`,
      },
      {
        title: 'At scale, focused',
        description:
          'The focused consumer and every token it uses are always drawn, even outside the busiest 6.',
        layout: 'stack',
        render: () => (
          <Tray
            id="cm-ex-scale-focus"
            level={3}
            title="Tokens in use"
            description="Focused on GitLab CI (platform): 2 accesses."
            actions={viewSwitch('map')}
          >
            <ConnectionsMap
              id="cm-ex-scale-focus-map"
              consumers={scaleConsumers}
              tokens={scaleTokensFocused}
              accesses={scaleAccesses}
              focus="gitlab-platform"
            />
          </Tray>
        ),
        code: `<ConnectionsMap id="acc-map" consumers={consumers} tokens={tokens} accesses={accesses}
  focus="gitlab-platform" />`,
      },
    ],
    props: [
      {
        component: 'ConnectionsMap',
        props: [
          {
            name: 'id',
            type: 'string',
            required: true,
            description: 'Id of the map. Unique on the page.',
          },
          {
            name: 'consumers',
            type: 'readonly MapConsumer[]',
            required: true,
            description: (
              <>
                <code>id</code>, <code>name</code>, <code>logo</code>, <code>line?</code>,{' '}
                <code>idle?</code>, <code>weight?</code> (busyness; default its access count).
                Sorted busiest first.
              </>
            ),
          },
          {
            name: 'tokens',
            type: 'readonly MapToken[]',
            required: true,
            description: (
              <>
                <code>id</code>, <code>name</code>, <code>logo</code>, <code>slug?</code>,{' '}
                <code>line?</code>, <code>lineTone?</code>, <code>requests</code>,{' '}
                <code>denied</code>, <code>errors</code>, <code>lastUsed</code>, <code>idle?</code>,{' '}
                <code>tag?</code>. Sorted by requests.
              </>
            ),
          },
          {
            name: 'accesses',
            type: 'readonly MapAccess[]',
            required: true,
            description: (
              <>
                <code>consumer</code>, <code>token</code>, <code>status</code>, <code>tone?</code> (
                <code>ok</code> active, <code>warn</code>/<code>bad</code> attention,{' '}
                <code>off</code> inactive), and for the list: <code>consumerLabel?</code>,{' '}
                <code>context?</code>, <code>operation?</code>, <code>href?</code>.
              </>
            ),
          },
          {
            name: 'focus',
            type: 'string',
            description: 'Consumer id from ?focus=. Lights it and its tokens, dims the rest.',
          },
          {
            name: 'baseHref',
            type: 'string',
            default: "'/admin/access'",
            description:
              'Every link is built from it: ?consumer=, ?token=, ?focus=, ?view=matrix (&consumers=rest, &tokens=rest).',
          },
          {
            name: 'maxRows',
            type: 'number',
            default: '7',
            description: 'Scale rule: most rows per side; above it, maxRows − 1 nodes and a group.',
          },
          {
            name: 'focusLinks',
            type: 'number',
            default: '3',
            description: 'Consumers in the focus bar; 0 hides the bar.',
          },
          {
            name: 'footer',
            type: 'Child',
            description: 'Facts at the start of the footer, before the legend.',
          },
          { name: 'class', type: 'string', description: 'Extra classes on the .cmap.' },
        ],
      },
    ],
    accessibility: [
      'The map is a group named "Connections map. Every line is also listed as text below."; the wires are hidden, and the disclosure under it lists every access as an arrow row with its status word.',
      'Each node name is a link; counts read as "6 accesses", metrics as "21 denied", "1 min ago" as "last used 1 min ago", and every token says which consumers use it.',
      'The focused consumer link has aria-current; dimmed nodes keep AA contrast text.',
      'Status is in words on the token line ("⌛ Secret expires in 6 days"); the wire color only adds to it.',
    ],
    do: [
      'Render it from the same data on the Overview and on Consumer access.',
      'Write the token line as the reason the wire needs attention.',
      'Keep the Map | Matrix switch in the tray header.',
    ],
    dont: [
      'Do not hand-place nodes or wires: the server lays them out from the data.',
      'Do not raise maxRows: past 7 rows the wires stop being readable; the matrix shows all.',
    ],
    classes: [
      'cmap',
      'cmap-bar',
      'cmap-note',
      'cmap-col',
      'cmap-mid',
      'cmap-h',
      'tok-h',
      'hub',
      'nodes',
      'node',
      'cnode',
      'tnode',
      'idw',
      'nm',
      'nl',
      'cnt',
      'm',
      'keep',
      'x',
      'z',
      'idle',
      'group',
      'tag',
      'is-on',
      'dim',
      'rs2',
      'rs3',
      'rs4',
      'wires',
      'wire',
      'warn',
      'off',
      'on',
      'cmap-list',
    ],
  },
  {
    slug: 'matrix',
    name: 'Matrix',
    summary:
      'Consumers’ repositories down, tokens across, one cell per access; empty cells open the prefilled create form.',
    usage: {
      when: [
        'The Matrix view of Consumer access, and the target of the map’s group nodes.',
        'Finding a gap: which repository has no access to a token yet.',
      ],
      whenNot: [
        'Three consumers and a handful of tokens at a glance: ConnectionsMap reads faster.',
        'The accesses of one token: a table on the token page.',
      ],
    },
    examples: [
      {
        title: 'Access matrix',
        description:
          'Headers stay in view while the focusable region scrolls. Cells: status, short constraint, operations. Empty cells offer +.',
        layout: 'stack',
        render: () => (
          <>
            <Matrix
              label="Access matrix"
              corner="Consumer › repository"
              columns={matrixColumns}
              groups={matrixGroups}
              addHref={(row, column) =>
                `/admin/access/new?repo=${encodeURIComponent(row.label)}&token=${column.id}`
              }
            />
            <Legend
              as="p"
              items={[
                { mark: 'cell', label: 'Active' },
                { mark: 'cell-warn', label: 'Expiring or risk' },
                { mark: 'cell-bad', label: 'Expired' },
                { mark: 'cell-off', label: 'Inactive' },
              ]}
            />
          </>
        ),
        code: `<Matrix label="Access matrix" corner="Consumer › repository"
  columns={[{ id: 'slack', name: 'Slack', logo: { brand: 'slack' },
              href: '/admin/access?token=slack', meta: '3 accesses · 2,140 req' }, …]}
  groups={[{ name: 'GitHub Actions (acme)', logo: { brand: 'github' }, href: '/admin/consumers/github-acme',
             meta: 'org acme (1234567) · 6 accesses',
             rows: [{ label: 'acme/api', href: '/admin/access?repo=acme/api', meta: '3 accesses',
                      cells: { slack: { href: '/admin/access/acc_01', status: 'Active',
                                        constraint: 'env production', operations: '1 operation' }, … } }] }, …]}
  addHref={(row, column) => \`/admin/access/new?repo=\${encodeURIComponent(row.label)}&token=\${column.id}\`} />
<Legend as="p" items={[{ mark: 'cell', label: 'Active' }, { mark: 'cell-warn', label: 'Expiring or risk' },
  { mark: 'cell-bad', label: 'Expired' }, { mark: 'cell-off', label: 'Inactive' }]} />`,
      },
    ],
    props: [
      {
        component: 'Matrix',
        props: [
          {
            name: 'label',
            type: 'string',
            required: true,
            description: 'Accessible name of the scroll region.',
          },
          {
            name: 'corner',
            type: 'string',
            required: true,
            description: 'Header of the row-label column.',
          },
          {
            name: 'columns',
            type: 'readonly MatrixColumn[]',
            required: true,
            description: (
              <>
                Tokens: <code>id</code>, <code>name</code>, <code>href</code>, <code>logo?</code>,{' '}
                <code>meta?</code>.
              </>
            ),
          },
          {
            name: 'groups',
            type: 'readonly MatrixGroup[]',
            required: true,
            description: (
              <>
                Consumers: <code>name?</code>, <code>logo?</code>, <code>href?</code>,{' '}
                <code>meta?</code>, <code>rows</code>. A row: <code>label</code>, <code>href?</code>
                , <code>meta?</code>, <code>mono?</code> (default true), <code>cells</code> by
                column id.
              </>
            ),
          },
          {
            name: 'groups[].rows[].cells',
            type: 'Record<string, MatrixCell>',
            required: true,
            description: (
              <>
                <code>href</code>, <code>status</code>, <code>tone?</code> (
                <code>'ok' | 'warn' | 'bad' | 'off'</code>), <code>glyph?</code>,{' '}
                <code>constraint?</code>, <code>operations?</code>. A missing column is an empty
                cell.
              </>
            ),
          },
          {
            name: 'addHref',
            type: '(row, column, group) => string',
            required: true,
            description: 'The prefilled create form behind an empty cell.',
          },
          {
            name: 'addLabel',
            type: '(row, column) => string',
            default: '"Give {row} access to {column}"',
            description: 'Accessible name of an empty cell.',
          },
          { name: 'class', type: 'string', description: 'Extra classes on the .matrix region.' },
        ],
      },
    ],
    accessibility: [
      'A real table: column headers are the tokens, row headers the repositories, and each consumer is a row group header, so a screen reader announces "acme/api, Slack" with a cell.',
      'The scroll region is focusable and named, so keyboard users can scroll it.',
      'Empty cells are links named "Give acme/web access to Slack"; the + is hidden.',
      'Cell status is a word with a hidden glyph; tone and dashed border only add to it.',
    ],
    do: [
      'Write the constraint in its short form ("env production", "branch main").',
      'Link every column header to the token’s access list.',
    ],
    dont: [
      'Do not put actions other than the link in a cell.',
      'Do not drop the legend under the matrix.',
    ],
    classes: [
      'matrix',
      'mx',
      'colh',
      'top',
      'grp',
      'gin',
      'mcell',
      'warn',
      'bad',
      'off',
      's',
      'c',
      'o',
      'madd',
      'lg-sw',
    ],
  },
  {
    slug: 'checklist',
    name: 'Checklist',
    related: ['ChecklistProgress'],
    summary:
      'Get started: numbered steps with Done or To do, and the one primary button on the next step.',
    usage: {
      when: [
        'The Overview of an empty install: the checklist is the whole content until the first access exists.',
        'A short setup sequence where each step has one action.',
      ],
      whenNot: [
        'A multi-step form: use the stepper of the give-access form.',
        'A list of problems: use NeedsAttention.',
      ],
    },
    examples: [
      {
        title: 'Get started',
        description:
          'Done steps have no button; the next step has the primary one and quick links to start from; later steps are secondary.',
        layout: 'stack',
        render: () => (
          <Tray
            id="gs-ex"
            level={3}
            title="Get started"
            description="3 steps. Each takes about 2 minutes."
            actions={<ChecklistProgress done={1} total={3} />}
          >
            <Panel>
              <Checklist
                steps={[
                  {
                    state: 'done',
                    title: 'Sign in with Cloudflare Access',
                    why: 'You are signed in as Maya Chen, Owner.',
                  },
                  {
                    state: 'next',
                    title: 'Add a service token',
                    why: 'tokengate keeps the secret; CI jobs never see it.',
                    action: { href: '/admin/tokens/new', label: 'Add token' },
                    quickLabel: 'Token types',
                    quick: [
                      {
                        href: '/admin/tokens/new?type=slack',
                        label: 'Slack',
                        logo: { brand: 'slack' },
                      },
                      {
                        href: '/admin/tokens/new?type=openai',
                        label: 'OpenAI',
                        logo: { brand: 'openai' },
                      },
                      {
                        href: '/admin/tokens/new?type=anthropic',
                        label: 'Anthropic',
                        logo: { brand: 'anthropic' },
                      },
                      {
                        href: '/admin/tokens/new?type=github',
                        label: 'GitHub',
                        logo: { brand: 'github' },
                      },
                    ],
                  },
                  {
                    state: 'todo',
                    title: 'Add a service consumer and give it access',
                    why: 'Trust your CI system, then choose which jobs can use the token.',
                    action: { href: '/admin/consumers/new', label: 'Add consumer' },
                  },
                ]}
              />
            </Panel>
          </Tray>
        ),
        code: `<Tray id="ov-start" title="Get started" description="3 steps. Each takes about 2 minutes."
  actions={<ChecklistProgress done={1} total={3} />}>
  <Panel>
    <Checklist steps={[
      { state: 'done', title: 'Sign in with Cloudflare Access', why: 'You are signed in as Maya Chen, Owner.' },
      { state: 'next', title: 'Add a service token', why: 'tokengate keeps the secret; CI jobs never see it.',
        action: { href: '/admin/tokens/new', label: 'Add token' }, quickLabel: 'Token types',
        quick: [{ href: '/admin/tokens/new?type=slack', label: 'Slack', logo: { brand: 'slack' } }, …] },
      { state: 'todo', title: 'Add a service consumer and give it access',
        why: 'Trust your CI system, then choose which jobs can use the token.',
        action: { href: '/admin/consumers/new', label: 'Add consumer' } },
    ]} />
  </Panel>
</Tray>`,
      },
      {
        title: 'Progress',
        render: () => (
          <>
            <ChecklistProgress done={0} total={3} />
            <ChecklistProgress done={2} total={3} />
            <ChecklistProgress done={3} total={3} />
          </>
        ),
        code: `<ChecklistProgress done={0} total={3} />
<ChecklistProgress done={2} total={3} />
<ChecklistProgress done={3} total={3} />`,
      },
    ],
    props: [
      {
        component: 'Checklist',
        props: [
          {
            name: 'steps',
            type: 'readonly ChecklistStep[]',
            required: true,
            description: (
              <>
                <code>state</code> (<code>'done' | 'next' | 'todo'</code>), <code>title</code>,{' '}
                <code>why</code>, <code>action?</code> (<code>{'{ href, label }'}</code>; primary on
                next, hidden when done), <code>quick?</code>, <code>quickLabel?</code>.
              </>
            ),
          },
          CLASS_PROP,
        ],
      },
      {
        component: 'ChecklistProgress',
        props: [
          { name: 'done', type: 'number', required: true, description: 'Steps done.' },
          { name: 'total', type: 'number', required: true, description: 'All steps.' },
          { name: 'class', type: 'string', description: 'Extra classes on the bar.' },
        ],
      },
    ],
    accessibility: [
      'An ordered list of steps with h3 titles; the state is the badge word (Done, To do), the number circle is hidden.',
      'The progress bar is hidden; the sentence "1 of 3 done" is read.',
      'Quick links are a nav named by quickLabel.',
    ],
    do: ['Mark exactly one step next.', 'Say why each step matters in one line.'],
    dont: ['Do not give a done step a button.', 'Do not use more than one primary button.'],
    classes: [
      'checklist',
      'is-done',
      'is-next',
      'no',
      'why',
      'acts',
      'wide',
      'quick',
      'q',
      'progress',
      'on',
    ],
  },
  {
    slug: 'trace',
    name: 'Trace',
    related: ['NextStep'],
    summary:
      'The checks a request went through, in order, with the outcome of each; then the next step that fixes it.',
    usage: {
      when: [
        'A request detail: where the call stopped and why.',
        'Explaining a decision step by step (an access flow with a risky condition, the join policy).',
      ],
      whenNot: ['Totals over many requests: use Pipeline.', 'A form with steps: use the stepper.'],
    },
    examples: [
      {
        title: 'Denied request and the give-access loop',
        description:
          'mark highlights the failing claim. NextStep offers the fix with the values the form will open with.',
        layout: 'stack',
        render: () => (
          <Panel variant="pad">
            <Trace label="Where the call stopped" steps={deniedTrace} />
            {giveAccess}
          </Panel>
        ),
        code: `<Panel variant="pad">
  <Trace label="Where the call stopped" steps={[
    { state: 'pass', title: 'Caller verified', detail: 'GitHub Actions (acme)' },
    { state: 'pass', title: 'Token found', detail: '/proxy/slack → Slack' },
    { state: 'fail', status: 'Failed, stopped here', title: 'Access matched',
      detail: <>acme/web · branch <mark>feature/login-redesign</mark></> },
    { state: 'notrun', title: 'Upstream call', detail: 'Slack was not called' },
  ]} />
  <NextStep title="Give access from this request."
    prefill={[{ label: 'GitHub Actions (acme)', logo: { brand: 'github' } }, { label: 'acme/web', mono: true },
              { label: <>branch <span class="mono">feature/login-redesign</span></> },
              { label: 'Slack', logo: { brand: 'slack' } }]}
    actions={<><a class="btn primary" href="/admin/access/new?from_request=req_01JB8Z5K…">Give access from this request</a>
               <a class="btn secondary" href="…">Compare with existing accesses</a></>}>
    The form opens with these values filled in; you choose only what is missing.
  </NextStep>
</Panel>`,
      },
      {
        title: 'Step states',
        description:
          'warn: passed on an accepted risk. on: the current choice in a step explainer. notrun: not reached.',
        layout: 'stack',
        render: () => (
          <Panel variant="pad">
            <Trace
              steps={[
                { state: 'pass', title: 'Caller verified', detail: 'GitHub Actions (acme)' },
                {
                  state: 'warn',
                  title: 'Any branch, tag or environment',
                  detail: 'acme/infra · accepted by Diego Ruiz, 2 Oct',
                },
                {
                  state: 'on',
                  status: 'Current policy',
                  title: 'Ask an owner',
                  detail: 'New people wait until an owner picks a role',
                },
                { state: 'notrun', title: 'Upstream call', detail: 'Shown for comparison' },
              ]}
            />
          </Panel>
        ),
        code: `<Trace steps={[
  { state: 'pass', title: 'Caller verified', detail: 'GitHub Actions (acme)' },
  { state: 'warn', title: 'Any branch, tag or environment', detail: 'acme/infra · accepted by Diego Ruiz, 2 Oct' },
  { state: 'on', status: 'Current policy', title: 'Ask an owner', detail: 'New people wait until an owner picks a role' },
  { state: 'notrun', title: 'Upstream call', detail: 'Shown for comparison' },
]} />`,
      },
    ],
    props: [
      {
        component: 'Trace',
        props: [
          {
            name: 'steps',
            type: 'readonly TraceStep[]',
            required: true,
            description: (
              <>
                <code>state</code> (<code>'pass' | 'fail' | 'notrun' | 'warn' | 'on'</code>),{' '}
                <code>title</code>, <code>detail?</code>, <code>status?</code> (default Passed,
                Failed, Not reached, Risk accepted, Current choice), <code>glyph?</code>.
              </>
            ),
          },
          {
            name: 'label',
            type: 'string',
            description: 'Accessible name of the list ("Where the call stopped").',
          },
          CLASS_PROP,
        ],
      },
      {
        component: 'NextStep',
        props: [
          {
            name: 'title',
            type: 'Child',
            required: true,
            description: 'The next step in one short bold sentence.',
          },
          { name: 'children', type: 'Child', description: 'What happens when you take it.' },
          {
            name: 'prefill',
            type: 'readonly PrefillValue[]',
            description: (
              <>
                Chips of the values the form opens with: <code>label</code>, <code>logo?</code>,{' '}
                <code>mono?</code>.
              </>
            ),
          },
          {
            name: 'actions',
            type: 'Child',
            description: 'One .btn.primary, then secondary buttons.',
          },
          CLASS_PROP,
        ],
      },
    ],
    accessibility: [
      'An ordered list: each step reads its status word, the check and the evidence. Glyphs are hidden; connectors are CSS.',
      'mark is announced as highlighted text by most screen readers; the status word still says Failed.',
      'The prefill chips start with a hidden "Filled in:" so they read as the form values.',
    ],
    do: [
      'Say where it stopped in the fail status ("Failed, stopped here").',
      'Offer the fix right under the trace, with the values it will prefill.',
    ],
    dont: [
      'Do not show steps after the failing one as failed: they are not reached.',
      'Do not use the trace for more than 4 checks in a row.',
    ],
    classes: [
      'trace',
      'tstep',
      'pass',
      'fail',
      'notrun',
      'warn',
      'is-on',
      's',
      'v',
      'd',
      'mark',
      'todo',
      'prefill',
      'chip',
    ],
  },
  {
    slug: 'split-view',
    name: 'SplitView',
    summary:
      'A list of requests on the left and the selected one’s detail on the right; every item is a link to its own URL.',
    usage: {
      when: [
        'Reading through requests one after another (denied requests, errors of one token).',
        'Any list where people compare neighbors and want the list in view.',
      ],
      whenNot: [
        'Scanning many columns: use the request table.',
        'A single object: use its detail page.',
      ],
    },
    examples: [
      {
        title: 'Denied request selected',
        description:
          'The server renders the pane for ?req= and marks that item aria-current. Below 64rem the list sits above the detail and scrolls on its own.',
        layout: 'stack',
        render: () => (
          <Tray id="sv-ex" level={3} title="Denied requests" count={241}>
            <SplitView
              id="sv-ex-split"
              level={3}
              label="Denied requests, newest first"
              items={requestItems}
              title={<span class="mono">POST /chat.postMessage</span>}
              meta="req_01JB8Z5K2Q7W3N4M6P8R9T0V1X · 15 Oct 2026, 14:03:22 UTC · 403 no_matching_grant"
              actions={
                <a class="btn sm secondary" href="/admin/requests/req_01JB8Z5K2Q7W3N4M6P8R9T0V1X">
                  Open request
                </a>
              }
              listFooter="Showing 1–5 of 241"
            >
              <Trace label="Where the call stopped" steps={deniedTrace} />
              {giveAccess}
            </SplitView>
          </Tray>
        ),
        code: `<Tray id="rq-denied" title="Denied requests" count={241}>
  <SplitView id="rq-split" level={3} label="Denied requests, newest first"
    items={[
      { href: '?req=req_01JB8Z5K2Q7W3N4M6P8R9T0V1X', title: 'POST /chat.postMessage', current: true,
        outcome: { tone: 'bad', word: 'Denied', code: '403' }, time: '14:03:22',
        datetime: '2026-10-15T14:03:22Z', meta: 'acme/web → slack' },
      …
    ]}
    title={<span class="mono">POST /chat.postMessage</span>}
    meta="req_01JB8Z5K2Q7W3N4M6P8R9T0V1X · 15 Oct 2026, 14:03:22 UTC · 403 no_matching_grant"
    actions={<a class="btn sm secondary" href="/admin/requests/req_01JB8Z5K…">Open request</a>}
    listFooter="Showing 1–5 of 241">
    <Trace label="Where the call stopped" steps={…} />
    <NextStep title="Give access from this request." … />
  </SplitView>
</Tray>`,
      },
    ],
    props: [
      {
        component: 'SplitView',
        props: [
          {
            name: 'id',
            type: 'string',
            required: true,
            description: 'Prefix of the pane heading id. Unique on the page.',
          },
          {
            name: 'label',
            type: 'string',
            required: true,
            description: 'Accessible name of the list nav.',
          },
          {
            name: 'items',
            type: 'readonly SplitItem[]',
            required: true,
            description: (
              <>
                <code>href</code>, <code>title</code>, <code>outcome?</code> (
                <code>{'{ tone, word, code? }'}</code>), <code>time?</code>, <code>datetime?</code>,{' '}
                <code>meta?</code>, <code>current?</code>.
              </>
            ),
          },
          { name: 'title', type: 'Child', required: true, description: 'Pane heading.' },
          { name: 'meta', type: 'Child', description: 'Facts under the pane heading.' },
          { name: 'actions', type: 'Child', description: 'Buttons on the right of the heading.' },
          {
            name: 'level',
            type: '2 | 3',
            default: '2',
            description: 'Heading level of the pane title.',
          },
          { name: 'listFooter', type: 'Child', description: 'Under the list: pager or count.' },
          { name: 'children', type: 'Child', description: 'The detail.' },
          CLASS_PROP,
        ],
      },
    ],
    accessibility: [
      'The list is a nav of plain links; the selected item has aria-current="page" and an accent bar as well as the tint.',
      'The pane is a section labelled by its heading, after the list in reading and focus order.',
      'Outcome is a word with its code; the dot is hidden.',
    ],
    do: [
      'Keep the selection in the URL (?req=), so back, reload and share work.',
      'Show the same detail parts as the request page: trace, then the next step.',
    ],
    dont: [
      'Do not reorder the list and pane with CSS: the list comes first in the source and on screen.',
      'Do not put more than three facts in a list item.',
    ],
    classes: [
      'split',
      'split-list',
      'split-items',
      'split-item',
      'split-top',
      'split-t',
      'split-f',
      'split-pane',
      'split-h',
      'split-b',
      'res',
      'dot',
      'time',
    ],
  },
  {
    slug: 'arrow-row',
    name: 'ArrowRow',
    summary: 'One delegation on one line: consumer (and repository) → token (and operation).',
    usage: {
      when: [
        'Access lists on token and consumer pages, and the text form of the connections map.',
        'A request row: caller → token.',
      ],
      whenNot: ['Many accesses at once: use ConnectionsMap or Matrix.'],
    },
    examples: [
      {
        title: 'Plain and linked',
        description:
          'With href the whole row is one link and the consumer name underlines on hover. Below 48rem it wraps to two lines.',
        layout: 'stack',
        render: () => (
          <>
            <ArrowRow
              consumer={{
                name: 'GitLab CI (platform) › platform/deploy-tools',
                logo: { brand: 'gitlab' },
                context: 'branch main',
              }}
              token={{
                name: 'Discord alerts',
                logo: { brand: 'discord' },
                context: <code>POST /</code>,
              }}
            />
            <ArrowRow
              href="/admin/access/acc_01"
              consumer={{
                name: 'GitHub Actions (acme) › acme/api',
                logo: { brand: 'github' },
                context: 'environment production',
              }}
              token={{ name: 'Slack', logo: { brand: 'slack' }, context: 'Post messages' }}
            />
            <ArrowRow
              consumer={{
                name: 'Buildkite (acme) › pipeline deploy',
                logo: { brand: 'buildkite' },
              }}
              token={{
                name: 'Slack (legacy)',
                logo: { brand: 'slack', disabled: true },
                context: 'Post messages',
              }}
            />
          </>
        ),
        code: `<ArrowRow consumer={{ name: 'GitLab CI (platform) › platform/deploy-tools', logo: { brand: 'gitlab' }, context: 'branch main' }}
  token={{ name: 'Discord alerts', logo: { brand: 'discord' }, context: <code>POST /</code> }} />
<ArrowRow href="/admin/access/acc_01"
  consumer={{ name: 'GitHub Actions (acme) › acme/api', logo: { brand: 'github' }, context: 'environment production' }}
  token={{ name: 'Slack', logo: { brand: 'slack' }, context: 'Post messages' }} />
<ArrowRow consumer={{ name: 'Buildkite (acme) › pipeline deploy', logo: { brand: 'buildkite' } }}
  token={{ name: 'Slack (legacy)', logo: { brand: 'slack', disabled: true }, context: 'Post messages' }} />`,
      },
    ],
    props: [
      {
        component: 'ArrowRow',
        props: [
          {
            name: 'consumer',
            type: 'ArrowEnd',
            required: true,
            description: (
              <>
                Left side: <code>name</code>, <code>logo?</code> (
                <code>{'{ brand, text?, disabled? }'}</code>
                ), <code>context?</code>.
              </>
            ),
          },
          {
            name: 'token',
            type: 'ArrowEnd',
            required: true,
            description: 'Right side, same shape.',
          },
          { name: 'href', type: 'string', description: 'Makes the row one link.' },
          {
            name: 'verb',
            type: 'string',
            default: "'can use'",
            description: 'Read instead of the arrow.',
          },
          CLASS_PROP,
        ],
      },
    ],
    accessibility: [
      'The arrow is hidden and a hidden "can use" takes its place: "GitHub Actions (acme) › acme/api · environment production can use Slack · Post messages".',
      'Logos are hidden; names are text.',
    ],
    do: ['Put the constraint on the consumer side and the operation on the token side.'],
    dont: ['Do not put two links in one row: link the access, filter elsewhere.'],
    classes: ['arrow', 'side-c', 'side-t', 'to', 'ctx', 'ent-n'],
  },
];
