// Docs entries of the "data" group (packages/ui/src/components/data). One ComponentDoc per component
// page, in nav order. Only the data group agent edits this file.
import {
  ActiveFilters,
  AddFilter,
  Avatar,
  Badge,
  Button,
  Cell,
  CountLink,
  DiffTable,
  EmptyState,
  Entity,
  GroupRow,
  Feed,
  FeedDay,
  FeedItem,
  FieldError,
  type FilterOptionGroup,
  FilterSearch,
  Filters,
  Icon,
  KeyValue,
  LinkAction,
  LOGO_BRANDS,
  Logo,
  type LogoBrand,
  type LogoSpec,
  Pager,
  Panel,
  QuickLinks,
  RailFoot,
  RailKeyValue,
  Result,
  Row,
  RowHeader,
  Secret,
  Table,
  Time,
  Tray,
  ZeroState,
} from '@tokengate/ui';
import type { Child } from 'hono/jsx';
import type { ComponentDoc, PropDoc } from './types';

// ----- Example helpers (the base group's components, with the arguments the examples repeat) ----

/** A logo as data: the brand, with other letters or disabled when the example says so. */
function logo(brand: LogoBrand, letters: string, disabled?: boolean): LogoSpec {
  const own: { letters?: string; icon?: string } = LOGO_BRANDS[brand];
  // the brand's own letters (or the OIDC key) unless the example names other ones
  const text = letters === own.letters || brand === 'oidc' ? undefined : letters;
  return text === undefined && !disabled ? brand : { brand, text, disabled };
}

/** A drawn tile, for the hand-made logo stacks of the examples. */
function tile(brand: LogoBrand) {
  return <Logo brand={brand} />;
}

function avatar(initials: string) {
  return <Avatar initials={initials} />;
}

function rowButton(label: string, context: string) {
  return (
    <Button size="sm" href="#" srSuffix={context}>
      {label}
    </Button>
  );
}

function usedBy(tiles: readonly Child[], text: string) {
  return (
    <span class="lstack">
      <span class="tiles" aria-hidden="true">
        {tiles}
      </span>
      {text}
    </span>
  );
}

const systemAvatar = (
  <Avatar variant="sys">
    <Icon name="system" />
  </Avatar>
);

/** The `class` prop row every component takes, worded for its root element. */
const classProp = (root: string): PropDoc => ({
  name: 'class',
  type: 'string',
  description: `Extra classes on the ${root}, after the component's own.`,
});

// ----- Example data (the shared tokengate data set) -------------------------------------------

const TOKENS = [
  {
    slug: 'openai',
    name: 'OpenAI',
    logo: logo('openai', 'O'),
    usedBy: usedBy([tile('github')], '1 consumer'),
    requests: '3,902',
    status: (
      <Badge tone="warn" glyph="⌛">
        Expires in 6 days
      </Badge>
    ),
    lastUsed: '2026-10-15T14:02Z',
    ago: '1 min ago',
    action: rowButton('Replace secret', 'of OpenAI'),
  },
  {
    slug: 'slack',
    name: 'Slack',
    logo: logo('slack', 'S'),
    usedBy: usedBy([tile('github'), tile('gitlab')], '2 consumers'),
    requests: '2,140',
    status: (
      <Badge tone="ok" glyph="✓">
        Active
      </Badge>
    ),
    lastUsed: '2026-10-15T14:01Z',
    ago: '2 min ago',
    action: rowButton('Give access', 'to Slack'),
    highlight: true,
  },
  {
    slug: 'slack-legacy',
    name: 'Slack (legacy)',
    logo: logo('slack', 'S', true),
    usedBy: usedBy([tile('buildkite')], '1 consumer'),
    requests: '0',
    zero: true,
    status: (
      <Badge tone="off" glyph="⏸">
        Disabled
      </Badge>
    ),
    lastUsed: '2026-09-04T10:20Z',
    ago: '41 days ago',
    action: rowButton('Enable', 'Slack (legacy)'),
  },
] as const;

const TOKEN_COLUMNS = [
  { label: 'Credential' },
  { label: 'Used by' },
  { label: 'Requests 24 h', num: true },
  { label: 'Status' },
  { label: 'Last used' },
  { label: 'Actions', act: true },
];

const REQUESTS = [
  {
    at: '2026-10-15T14:03:22Z',
    tone: 'bad',
    word: 'Denied',
    code: 403,
    repo: 'acme/web',
    token: 'slack',
    call: 'POST /chat.postMessage',
    why: 'No issuer access rules allows this call',
    ms: '9 ms',
  },
  {
    at: '2026-10-15T14:03:10Z',
    tone: 'ok',
    word: 'Allowed',
    code: 200,
    repo: 'acme/api',
    token: 'openai',
    call: 'POST /v1/chat/completions',
    why: 'via environment production',
    ms: '812 ms',
  },
  {
    at: '2026-10-15T14:01:55Z',
    tone: 'warn',
    word: 'Error',
    code: 502,
    repo: 'acme/api',
    token: 'openai',
    call: 'POST /v1/chat/completions',
    why: 'Upstream error · 502',
    ms: '2,311 ms',
  },
  {
    at: '2026-10-15T14:01:20Z',
    tone: 'ok',
    word: 'Allowed',
    code: 204,
    repo: 'platform/deploy-tools',
    token: 'discord-alerts',
    call: 'POST /',
    why: 'via branch main',
    ms: '96 ms',
  },
] as const;

const REQUEST_COLUMNS = [
  { label: 'When (UTC)' },
  { label: 'Result' },
  { label: 'Caller → token' },
  { label: 'Request' },
  { label: 'Reason or access' },
  { label: 'Duration', num: true },
];

function RequestRows() {
  return (
    <>
      {REQUESTS.map((r) => (
        <Row>
          <Cell>
            <Time datetime={r.at} format="time" mono />
          </Cell>
          <Cell label="Result">
            <Result tone={r.tone} code={r.code}>
              {r.word}
            </Result>
          </Cell>
          <Cell label="Caller → token">
            {r.repo} → <span class="mono">{r.token}</span>
          </Cell>
          <RowHeader>
            <a class="ent-n mono" href="#">
              {r.call}
            </a>
          </RowHeader>
          <Cell label="Reason or access">{r.why}</Cell>
          <Cell label="Duration" num>
            {r.ms}
          </Cell>
        </Row>
      ))}
    </>
  );
}

const TOKEN_OPTIONS = [
  { href: '?token=openai', label: 'OpenAI', logo: logo('openai', 'O'), count: '3,902' },
  { href: '?token=slack', label: 'Slack', logo: logo('slack', 'S'), count: '2,140' },
  {
    href: '?token=anthropic',
    label: 'Anthropic',
    logo: logo('anthropic', 'A'),
    count: '1,630',
  },
];

/** About 45 denial reason codes, by where the request failed: the “+ Reason” menu in groups. */
const REASON_GROUPS: readonly FilterOptionGroup[] = (
  [
    [
      'Caller',
      [
        ['issuer_unknown', 'Unknown issuer', 182],
        ['token_missing', 'No caller token', 31],
        ['token_malformed', 'Caller token unreadable', 4],
        ['token_expired', 'Caller token expired', 3],
        ['token_not_yet_valid', 'Caller token not valid yet'],
        ['audience_mismatch', 'Wrong audience', 2],
        ['signature_invalid', 'Bad signature'],
        ['jwks_unavailable', 'Issuer keys unavailable'],
        ['claims_missing', 'Required claims missing'],
      ],
    ],
    [
      'Access',
      [
        ['no_matching_grant', 'No issuer access rules allows this call', 59],
        ['grant_expired', 'Issuer access rules expired', 6],
        ['grant_disabled', 'Issuer access rules disabled'],
        ['consumer_disabled', 'Consumer disabled'],
        ['repo_not_allowed', 'Repository not allowed', 9],
        ['branch_not_allowed', 'Branch not allowed', 5],
        ['environment_not_allowed', 'Environment not allowed'],
        ['workflow_not_allowed', 'Workflow not allowed'],
        ['event_not_allowed', 'Event not allowed'],
      ],
    ],
    [
      'Request',
      [
        ['method_not_allowed', 'Method not allowed', 7],
        ['path_not_allowed', 'Path not allowed', 11],
        ['host_not_allowed', 'Upstream host not allowed'],
        ['header_not_allowed', 'Header not allowed'],
        ['query_not_allowed', 'Query not allowed'],
        ['scheme_not_allowed', 'Scheme not allowed'],
        ['body_too_large', 'Request body too large'],
        ['request_malformed', 'Request unreadable'],
        ['rate_limited', 'Rate limited', 14],
      ],
    ],
    [
      'Credential',
      [
        ['token_unknown', 'Unknown token', 8],
        ['token_disabled', 'Token disabled', 3],
        ['token_paused', 'Token paused'],
        ['secret_missing', 'No secret stored'],
        ['secret_expired', 'Secret expired', 1],
        ['secret_unsealable', 'Secret cannot be unsealed'],
        ['kek_mismatch', 'Sealing key changed'],
        ['rotation_pending', 'Rotation pending'],
        ['token_slug_invalid', 'Token name unreadable'],
      ],
    ],
    [
      'Upstream',
      [
        ['upstream_5xx', 'Upstream error', 12],
        ['upstream_4xx', 'Upstream refused', 2],
        ['upstream_timeout', 'Upstream timed out', 1],
        ['upstream_unreachable', 'Upstream unreachable'],
        ['upstream_tls', 'Upstream TLS failed'],
        ['upstream_redirect', 'Upstream redirected'],
        ['upstream_too_large', 'Upstream answer too large'],
        ['upstream_reset', 'Upstream reset the connection'],
        ['dns_failure', 'Upstream name not found'],
      ],
    ],
  ] as const
).map(([group, codes]) => ({
  group,
  options: codes.map(([slug, label, count]: readonly [string, string, number?]) => ({
    href: `?reason=${slug}`,
    label,
    slug,
    count,
  })),
}));

// ----- Shared prop docs ------------------------------------------------------------------------

const FILTER_OPTION_TYPE =
  '{ href: string; label: Child; logo?: LogoSpec; logoSlot?: Child; slug?: string; count?: number | string }';

export const data: readonly ComponentDoc[] = [
  // ===== Table ==================================================================================
  {
    slug: 'table',
    name: 'Table',
    related: ['Row', 'RowHeader', 'Cell', 'Entity', 'CountLink', 'Result', 'GroupRow'],
    summary:
      'A dense data table in a keyboard-scrollable region: 44px rows, an entity first column, numbers right-aligned, cards on phones.',
    usage: {
      when: [
        'A list of objects of one kind: tokens, consumers, accesses, people, requests.',
        'Logs and number tables (dense rows): the request log, the hourly numbers under a chart.',
        'Three to seven columns. A second fact goes in the meta line of the cell, not in a new column.',
      ],
      whenNot: [
        <>
          Facts about one object: use <code>KeyValue</code> or <code>RailKeyValue</code>.
        </>,
        <>
          A history of events in sentences: use <code>Feed</code>.
        </>,
        <>
          Nothing to show yet: keep the header (<code>scroll={'{false}'}</code>, no rows) and put an{' '}
          <code>EmptyState</code> after it.
        </>,
      ],
    },
    examples: [
      {
        title: 'List with entity, numbers, status and row actions',
        description:
          'The tokens list: the first column is the row header (logo, name link, mono meta line), numbers are tabular, one row is highlighted, a zero is faint. Each row has an id, so a redirect to #token-slack lands on it. Below 48rem each row becomes a card with the column name above each value.',
        layout: 'stack',
        render: () => (
          <Tray
            id="ex-tbl-tokens"
            title="All tokens"
            count={6}
            description="Each token is a secret tokengate keeps for one upstream API."
            actions={
              <a class="btn sm secondary" href="#">
                Open issuer access rules
              </a>
            }
          >
            <Panel variant="flush">
              <Table labelledBy="ex-tbl-tokens-h" stackable columns={TOKEN_COLUMNS}>
                {TOKENS.map((t) => (
                  <Row highlight={'highlight' in t} id={`ex-tbl-token-${t.slug}`}>
                    <RowHeader>
                      <Entity
                        logo={t.logo}
                        name={t.name}
                        href="#"
                        meta={`/proxy/${t.slug}`}
                        metaMono
                      />
                    </RowHeader>
                    <Cell>{t.usedBy}</Cell>
                    <Cell label="Requests" num zero={'zero' in t}>
                      {t.requests}
                    </Cell>
                    <Cell label="Status">{t.status}</Cell>
                    <Cell label="Last used">
                      <Time datetime={t.lastUsed}>{t.ago}</Time>
                    </Cell>
                    <Cell act>{t.action}</Cell>
                  </Row>
                ))}
              </Table>
              <Pager summary="Showing 1–3 of 6" newer="#" older="#" />
            </Panel>
          </Tray>
        ),
        code: `<Tray id="all-tokens" title="All tokens" count={6} description="Each token is a secret tokengate keeps for one upstream API."
  actions={<a class="btn sm secondary" href="/admin/issuer-access-rules">Open issuer access rules</a>}>
  <Panel variant="flush">
    <Table labelledBy="all-tokens-h" stackable columns={[
      { label: 'Credential' }, { label: 'Used by' }, { label: 'Requests 24 h', num: true },
      { label: 'Status' }, { label: 'Last used' }, { label: 'Actions', act: true },
    ]}>
      {tokens.map((t) => (
        <Row highlight={t.slug === changed} id={\`token-\${t.slug}\`}>
          <RowHeader>
            <Entity logo={t.brand}
              name={t.name} href={\`/admin/credentials/\${t.slug}\`} meta={\`/proxy/\${t.slug}\`} metaMono />
          </RowHeader>
          <Cell>{usedBy(t)}</Cell>
          <Cell label="Requests" num zero={t.requests === 0}>{fmt(t.requests)}</Cell>
          <Cell label="Status"><Badge tone="ok" glyph="✓">Active</Badge></Cell>
          <Cell label="Last used"><Time datetime={t.lastUsed}>{ago(t.lastUsed)}</Time></Cell>
          <Cell act>
            <a class="btn sm secondary" href={\`/admin/issuer-access-rules/new?token=\${t.slug}\`}>
              Give access<span class="vh"> to {t.name}</span>
            </a>
          </Cell>
        </Row>
      ))}
    </Table>
    <Pager summary="Showing 1–3 of 6" newer="?page=1" older="?page=3" />
  </Panel>
</Tray>`,
      },
      {
        title: 'Dense log with time and result cells',
        description:
          'The request log: 36px rows, a mono UTC time, the outcome as dot + word + status code. The request is the row header. No visible heading names the region, so it gets a label.',
        layout: 'stack',
        render: () => (
          <Panel variant="flush">
            <Table label="Requests, newest first" dense stackable columns={REQUEST_COLUMNS}>
              <RequestRows />
            </Table>
            <Pager
              summary="Showing 1–25 of 8,214 · times in UTC"
              older="#"
              buttons
              label="Request log pages"
            />
          </Panel>
        ),
        code: `<Table label="Requests, newest first" dense stackable columns={[
  { label: 'When (UTC)' }, { label: 'Result' }, { label: 'Caller → token' },
  { label: 'Request' }, { label: 'Reason or access' }, { label: 'Duration', num: true },
]}>
  {requests.map((r) => (
    <Row>
      <Cell><Time datetime={r.at} format="time" mono /></Cell>
      <Cell label="Result"><Result tone="bad" code={403}>Denied</Result></Cell>
      <Cell label="Caller → token">{r.repo} → <span class="mono">{r.token}</span></Cell>
      <RowHeader><a class="ent-n mono" href={\`/admin/requests/\${r.id}\`}>{r.call}</a></RowHeader>
      <Cell label="Reason or access">{r.reason}</Cell>
      <Cell label="Duration" num>{r.ms} ms</Cell>
    </Row>
  ))}
</Table>
<Pager summary="Showing 1–25 of 8,214 · times in UTC" older={\`?before=\${last.id}\`} buttons />`,
      },
      {
        title: 'Count links, meta lines and a caption',
        description:
          'Top denied callers: each count links to the filtered request log, the reason is in the meta line, and a hidden caption names the table.',
        layout: 'stack',
        render: () => (
          <Tray
            id="ex-tbl-denied"
            title="Top denied callers"
            description="The 2 groups behind 220 denials since 14 Oct, 15:00 UTC."
          >
            <Panel variant="flush">
              <Table
                labelledBy="ex-tbl-denied-h"
                stackable
                caption="Top denied callers since 14 Oct 15:00 UTC"
                columns={[
                  { label: 'Caller → token' },
                  { label: 'Requests', num: true },
                  { label: 'Last seen' },
                  { label: 'Action', act: true },
                ]}
              >
                <Row>
                  <RowHeader>
                    <Entity
                      logo="github"
                      logoSize="sm"
                      name="acme/web → Slack"
                      meta={
                        <>
                          <span class="t-bad">✕ No issuer access rules allows this call</span> ·
                          GitHub Actions (acme)
                        </>
                      }
                    />
                  </RowHeader>
                  <Cell label="Requests" num>
                    <CountLink href="#" tone="bad" srSuffix="denied requests">
                      38
                    </CountLink>
                  </Cell>
                  <Cell label="Last seen">
                    <Time datetime="2026-10-15T13:59Z">4 min ago</Time>
                  </Cell>
                  <Cell act>{rowButton('Give access', 'for acme/web on Slack')}</Cell>
                </Row>
                <Row>
                  <RowHeader>
                    <Entity
                      logo="oidc"
                      logoSize="sm"
                      name="Unverified token"
                      meta={
                        <>
                          <span class="t-bad">✕ Unknown issuer</span> · from{' '}
                          <code>https://gitlab.example.org</code>
                        </>
                      }
                    />
                  </RowHeader>
                  <Cell label="Requests" num>
                    <CountLink href="#" tone="bad" srSuffix="denied requests">
                      182
                    </CountLink>
                  </Cell>
                  <Cell label="Last seen">
                    <Time datetime="2026-10-15T14:01Z">2 min ago</Time>
                  </Cell>
                  <Cell act>
                    {rowButton('Add credential access rule', 'for https://gitlab.example.org')}
                  </Cell>
                </Row>
              </Table>
            </Panel>
          </Tray>
        ),
        code: `<Table labelledBy="denied-h" stackable caption="Top denied callers since 14 Oct 15:00 UTC"
  columns={[{ label: 'Caller → token' }, { label: 'Requests', num: true }, { label: 'Last seen' }, { label: 'Action', act: true }]}>
  <Row>
    <RowHeader>
      <Entity logo="github" logoSize="sm" name="acme/web → Slack"
        meta={<><span class="t-bad">✕ No issuer access rules allows this call</span> · GitHub Actions (acme)</>} />
    </RowHeader>
    <Cell label="Requests" num>
      <CountLink href="/admin/requests?outcome=denied&token=slack&repo=acme/web" tone="bad" srSuffix="denied requests">38</CountLink>
    </Cell>
    <Cell label="Last seen"><Time datetime="2026-10-15T13:59Z">4 min ago</Time></Cell>
    <Cell act><a class="btn sm secondary" href="/admin/issuer-access-rules/new?from_request=req_01JB8Z5K">Give access<span class="vh"> for acme/web on Slack</span></a></Cell>
  </Row>
</Table>`,
      },
      {
        title: 'Number table without a region',
        description:
          'A narrow dense table that fits every width, so it needs no scroll region: scroll={false}, a caption to name it, row headers for the hour. A table with more columns keeps its region. The id is on the table element, so a link to #requests-per-hour lands on it.',
        layout: 'stack',
        render: () => (
          <Panel variant="flush">
            <Table
              id="ex-tbl-hours"
              scroll={false}
              dense
              caption="Requests per hour, numbers"
              columns={[
                { label: 'Hour (UTC)' },
                { label: 'Requests', num: true },
                { label: 'Denied', num: true },
              ]}
            >
              {[
                ['12:00', '640', '48'],
                ['13:00', '480', '61'],
                ['14:00', '64', '1'],
              ].map(([hour, ...values]) => (
                <Row>
                  <RowHeader>{hour}</RowHeader>
                  {values.map((value) => (
                    <Cell num>{value}</Cell>
                  ))}
                </Row>
              ))}
            </Table>
          </Panel>
        ),
        code: `<Table id="requests-per-hour" scroll={false} dense caption="Requests per hour, numbers" columns={[
  { label: 'Hour (UTC)' }, { label: 'Requests', num: true }, { label: 'Denied', num: true },
]}>
  {hours.map((h) => (
    <Row>
      <RowHeader>{h.label}</RowHeader>
      <Cell num>{fmt(h.requests)}</Cell>
      <Cell num>{fmt(h.denied)}</Cell>
    </Row>
  ))}
</Table>`,
      },
      {
        title: 'Entity variants',
        description:
          'With an avatar and an inline badge, with a slug after the name, and without a link or logo.',
        layout: 'stack',
        render: () => (
          <>
            <Entity
              logoSlot={<Avatar name="Maya Chen" size="md" />}
              name="maya@acme.dev"
              href="#"
              after={<Badge tone="outline">You</Badge>}
              meta="Maya Chen"
            />
            <Entity
              logo={logo('slack', 'S')}
              name="Slack"
              href="#"
              after={<span class="slug">slack</span>}
              meta={
                <>
                  Slack Web API · <span class="mono">slack.com/api</span>
                </>
              }
            />
            <Entity name="GitHub Actions (acme)" meta="org acme (1234567)" />
          </>
        ),
        code: `<Entity logoSlot={<Avatar name="Maya Chen" size="md" />} name="maya@acme.dev" href="/admin/users/maya"
  after={<Badge tone="outline">You</Badge>} meta="Maya Chen" />
<Entity logo="slack" name="Slack" href="/admin/credentials/slack"
  after={<span class="slug">slack</span>} meta={<>Slack Web API · <span class="mono">slack.com/api</span></>} />
<Entity name="GitHub Actions (acme)" meta="org acme (1234567)" />`,
      },
      {
        title: 'Result tones',
        render: () => (
          <>
            <Result tone="ok" code={200}>
              Allowed
            </Result>
            <Result tone="bad" code={403}>
              Denied
            </Result>
            <Result tone="warn" code={502}>
              Error
            </Result>
          </>
        ),
        code: `<Result tone="ok" code={200}>Allowed</Result>
<Result tone="bad" code={403}>Denied</Result>
<Result tone="warn" code={502}>Error</Result>`,
      },
      {
        title: 'Group rows',
        description:
          'GroupRow puts a header between rows that share a credential access rule or a repository, on the panel-sub band, with one ghost action. It spans every column (colspan) and heads its row group.',
        layout: 'stack',
        render: () => (
          <Panel variant="flush">
            <Table
              label="Accesses of GitHub Actions (acme), by repository"
              stackable
              columns={[{ label: 'Repository → token' }, { label: 'Status' }, { label: 'Expires' }]}
            >
              <GroupRow
                colspan={3}
                actions={
                  <a class="btn ghost sm" href="#">
                    <span class="plus" aria-hidden="true">
                      +
                    </span>
                    Give acme/api access to another token
                  </a>
                }
              >
                <span class="mono">acme/api</span> <span class="meta">(89012345)</span>
              </GroupRow>
              <Row>
                <RowHeader>
                  <Entity
                    logo="slack"
                    logoSize="sm"
                    name="Slack"
                    href="#"
                    meta="environment production"
                  />
                </RowHeader>
                <Cell label="Status">
                  <Badge status="active" />
                </Cell>
                <Cell label="Expires" nowrap>
                  Never
                </Cell>
              </Row>
              <GroupRow colspan={3}>
                <span class="mono">acme/web</span> <span class="meta">(89012346)</span>
              </GroupRow>
              <Row>
                <RowHeader>
                  <Entity logo="openai" logoSize="sm" name="OpenAI" href="#" meta="branch main" />
                </RowHeader>
                <Cell label="Status">
                  <Badge status="expiring">Expires in 9 days</Badge>
                </Cell>
                <Cell label="Expires" nowrap>
                  24 Oct 2026
                </Cell>
              </Row>
            </Table>
          </Panel>
        ),
        code: `<Table label="Accesses of GitHub Actions (acme), by repository" stackable columns={columns}>
  <GroupRow colspan={3} actions={<a class="btn ghost sm" href="…">+ Give acme/api access to another token</a>}>
    <span class="mono">acme/api</span> <span class="meta">(89012345)</span>
  </GroupRow>
  <Row>…</Row>
  <GroupRow colspan={3}><span class="mono">acme/web</span> <span class="meta">(89012346)</span></GroupRow>
  <Row>…</Row>
</Table>`,
      },
    ],
    props: [
      {
        component: 'Table',
        props: [
          {
            name: 'columns',
            type: 'readonly TableColumn[]',
            required: true,
            description: (
              <>
                Header cells:{' '}
                <code>{'{ label: Child; num?: boolean; act?: boolean; class?: string }'}</code>.{' '}
                <code>num</code> right-aligns; <code>act</code> is the row-actions column, its label
                read by screen readers only.
              </>
            ),
          },
          {
            name: 'id',
            type: 'string',
            description:
              'Id of the table element, not of the scroll region: a fragment target (#requests), and where checkers start reading the table up to its caption.',
          },
          {
            name: 'labelledBy',
            type: 'string',
            description: (
              <>
                Id of the visible heading that names the scroll region (the tray heading,{' '}
                <code>{'<id>-h'}</code>). Give labelledBy or label.
              </>
            ),
          },
          {
            name: 'label',
            type: 'string',
            description: 'Name of the scroll region when no visible heading names it.',
          },
          {
            name: 'scroll',
            type: 'false',
            description:
              'Leave out the scroll region: for a small table that never overflows, or an empty table before an EmptyState.',
          },
          {
            name: 'caption',
            type: 'Child',
            description:
              'Table caption, visually hidden (the tray title is the visible name). Required with scroll={false}, where no labelled region names the table.',
          },
          {
            name: 'captionVisible',
            type: 'boolean',
            default: 'false',
            description: 'Show the caption above the table.',
          },
          { name: 'dense', type: 'boolean', default: 'false', description: '36px rows.' },
          {
            name: 'stackable',
            type: 'boolean',
            default: 'false',
            description: 'Rows become cards below 48rem; give cells a label.',
          },
          {
            name: 'class',
            type: 'string',
            description: 'Extra classes on the table element (not on the scroll region).',
          },
          {
            name: 'children',
            type: 'Child',
            description: 'Row elements. None: the table renders its header only.',
          },
        ],
      },
      {
        component: 'Row',
        props: [
          {
            name: 'id',
            type: 'string',
            description:
              'Id of the tr: the fragment target of a redirect back to the row (#user-usr_1).',
          },
          {
            name: 'highlight',
            type: 'boolean',
            default: 'false',
            description: 'Accent-soft row: the one just changed or arrived from.',
          },
          classProp('tr'),
          { name: 'children', type: 'Child', description: 'A RowHeader, then Cells.' },
        ],
      },
      {
        component: 'RowHeader',
        props: [
          classProp('th'),
          { name: 'children', type: 'Child', description: 'Usually an Entity.' },
        ],
      },
      {
        component: 'Cell',
        props: [
          {
            name: 'label',
            type: 'string',
            description: 'Column name shown above the value when the row is a card (data-label).',
          },
          { name: 'num', type: 'boolean', description: 'Right-aligned tabular number.' },
          { name: 'zero', type: 'boolean', description: 'Faint zero or empty value.' },
          { name: 'act', type: 'boolean', description: 'Row actions cell.' },
          {
            name: 'nowrap',
            type: 'boolean',
            description: 'One line on wide screens; wraps when stacked.',
          },
          classProp('td'),
          { name: 'children', type: 'Child', description: 'The value.' },
        ],
      },
      {
        component: 'Entity',
        props: [
          { name: 'name', type: 'Child', required: true, description: 'The object name.' },
          { name: 'href', type: 'string', description: 'Detail page: the name becomes a link.' },
          {
            name: 'logo',
            type: 'LogoSpec',
            description: 'Brand tile before the name, decorative (aria-hidden).',
          },
          {
            name: 'logoSize',
            type: "'sm' | 'md'",
            default: "'md'",
            description: 'md (32px) on list pages, sm (24px) in denser rows.',
          },
          {
            name: 'logoSlot',
            type: 'Child',
            description: 'A custom decorative node instead of logo: an Avatar for a person.',
          },
          {
            name: 'after',
            type: 'Child',
            description: 'Inline after the name: a slug or a badge.',
          },
          { name: 'meta', type: 'Child', description: 'Muted second line.' },
          {
            name: 'metaMono',
            type: 'boolean',
            default: 'false',
            description: 'Mono 12px meta line, for paths and IDs.',
          },
          classProp('span.ent'),
        ],
      },
      {
        component: 'CountLink',
        props: [
          {
            name: 'href',
            type: 'string',
            required: true,
            description: 'The filtered list the number counts.',
          },
          { name: 'tone', type: "'bad' | 'warn'", description: 'Color of the number.' },
          {
            name: 'srSuffix',
            type: 'string',
            description:
              'Hidden suffix that says what is counted ("denied requests"). The space is added.',
          },
          classProp('a'),
          { name: 'children', type: 'Child', required: true, description: 'The number.' },
        ],
      },
      {
        component: 'Result',
        props: [
          {
            name: 'tone',
            type: "'ok' | 'bad' | 'warn'",
            required: true,
            description: 'Allowed, denied or error.',
          },
          { name: 'code', type: 'number | string', description: 'HTTP status code, in mono.' },
          classProp('span.res'),
          {
            name: 'children',
            type: 'Child',
            required: true,
            description: 'The word: Allowed, Denied, Error.',
          },
        ],
      },
      {
        component: 'GroupRow',
        props: [
          {
            name: 'colspan',
            type: 'number',
            required: true,
            description: 'Columns the header spans: the column count of the table.',
          },
          {
            name: 'actions',
            type: 'Child',
            description: 'One action at the right (.btn.ghost.sm).',
          },
          { name: 'class', type: 'string', description: 'Extra classes on tr.grp.' },
          {
            name: 'children',
            type: 'Child',
            required: true,
            description: 'What the rows under it share: a mono repository and its ID, an Entity.',
          },
        ],
      },
    ],
    accessibility: [
      'The scroll region is focusable (tabindex 0) with role region and a name from labelledBy or label, so keyboard users can scroll a wide table and screen readers announce it.',
      'Column headers have scope col and the first cell is a th with scope row, so every cell is announced with its row and column.',
      'The actions column header is hidden visually but read. Each row button needs a hidden suffix that names the row ("Give access to Slack"): the labels repeat on every row.',
      'Highlight, zero and tone are visual only. Say the fact in words too: a badge, the count, the word in Result.',
      'Logos and avatars are aria-hidden; the name next to them is read.',
      'Stacked rows keep the table semantics; the visible column labels come from data-label and are decorative.',
      'A GroupRow header is a th with scope="rowgroup": screen readers announce it with the cells under it.',
    ],
    do: [
      'Put the table in Panel variant="flush" inside a Tray, and name the region with the tray heading id.',
      'Keep 3 to 7 columns. Put a second fact in the meta line.',
      'Right-align numbers with num on both the column and the cell.',
      'Give every Cell a label in a stackable table (not the row header or the actions cell).',
    ],
    dont: [
      'Do not add a column for an icon or a status color without a word.',
      'Do not use icon-only row actions.',
      'Do not put links in the meta line that are the only way to reach a page.',
    ],
    classes: [
      'scroll',
      'tbl',
      'dense',
      'stackable',
      'hl',
      'num',
      'act',
      'zero',
      'nowrap',
      'ent',
      'ent-t',
      'ent-n',
      'meta',
      'nlink',
      'res',
      'code',
      'time',
      'grp',
      'grp-in',
    ],
  },

  // ===== Filters ================================================================================
  {
    slug: 'filters',
    name: 'Filters',
    related: ['FilterSearch', 'AddFilter', 'ActiveFilters'],
    summary:
      'The filter bar above a table: a search box, “+ Token” add-filter menus and Apply, with the active filters as removable chips.',
    usage: {
      when: [
        'A long list people narrow down: requests, the audit log, tokens, people.',
        <>
          In the tray header, through the <code>bar</code> slot of <code>Tray</code>, above the
          table panel.
        </>,
      ],
      whenNot: [
        <>
          Three to eight fixed statuses with counts: use <code>QuickLinks</code>.
        </>,
        <>Views of one object (Overview, Access): use tabs.</>,
        <>
          Finding one record by ID: use an inline field (<code>.field-inline</code>) in the page
          header.
        </>,
      ],
    },
    examples: [
      {
        title: 'Filter bar with an open menu',
        description:
          'A GET form with role search. “+ Token” is a details element holding links; the open menu floats over the table. Apply submits the search box.',
        layout: 'stack',
        render: () => (
          <Tray
            id="ex-flt"
            title="Requests, newest first"
            hideTitle
            bar={
              <Filters label="Filter requests" submitLabel="Apply">
                <FilterSearch
                  id="ex-flt-q"
                  label="Search requests"
                  placeholder="Path, repository or request ID"
                  suggestions={['acme/api', 'acme/web', 'acme/infra', 'platform/deploy-tools']}
                />
                <AddFilter
                  label="Credential"
                  open
                  srSuffix="requests"
                  options={TOKEN_OPTIONS}
                  extra={[{ href: '?token=none', label: 'No token chosen', count: 182 }]}
                />
                <AddFilter
                  label="Credential access rule"
                  srSuffix="requests"
                  options={[
                    {
                      href: '?consumer=github-acme',
                      label: 'GitHub Actions (acme)',
                      logo: logo('github', 'GH'),
                      count: '7,983',
                    },
                  ]}
                />
              </Filters>
            }
          >
            <Panel variant="flush">
              <Table
                label="Requests, newest first (filter example)"
                dense
                stackable
                columns={REQUEST_COLUMNS}
              >
                <RequestRows />
              </Table>
            </Panel>
          </Tray>
        ),
        code: `<Tray id="requests" title="Requests, newest first" hideTitle bar={
  <Filters label="Filter requests" action="/admin/requests" hidden={{ outcome: 'denied' }} submitLabel="Apply">
    <FilterSearch id="rq-q" label="Search requests" value={query} placeholder="Path, repository or request ID"
      suggestions={['acme/api', 'acme/web', 'acme/infra', 'platform/deploy-tools']} />
    <AddFilter label="Credential" srSuffix="requests" options={[
      { href: '?token=openai', label: 'OpenAI', logo: 'openai', count: '3,902' },
      { href: '?token=slack', label: 'Slack', logo: 'slack', count: '2,140' },
      …
    ]} extra={[{ href: '?token=none', label: 'No token chosen', count: 182 }]} />
    <AddFilter label="Credential access rule" srSuffix="requests" options={consumers} />
  </Filters>
}>
  <Panel variant="flush"><Table label="Requests, newest first" dense stackable columns={columns}>…</Table></Panel>
</Tray>`,
      },
      {
        title: 'Menu values with slugs',
        description:
          'Reason codes and token slugs in mono after the label, special values after the divider.',
        layout: 'stack',
        render: () => (
          <Tray
            id="ex-flt-reason"
            title="Denied requests"
            count={253}
            actions={
              <Filters as="group" end label="Filter denied requests">
                <AddFilter
                  label="Reason"
                  open
                  srSuffix="requests"
                  options={[
                    {
                      href: '?reason=issuer_unknown',
                      label: 'Unknown issuer',
                      slug: 'issuer_unknown',
                      count: 182,
                    },
                    {
                      href: '?reason=no_matching_grant',
                      label: 'No issuer access rules allows this call',
                      slug: 'no_matching_grant',
                      count: 59,
                    },
                    {
                      href: '?reason=upstream_5xx',
                      label: 'Upstream error',
                      slug: 'upstream_5xx',
                      count: 12,
                    },
                  ]}
                />
              </Filters>
            }
          >
            <Panel variant="flush">
              <Table label="Denied requests (example)" dense stackable columns={REQUEST_COLUMNS}>
                <RequestRows />
              </Table>
            </Panel>
          </Tray>
        ),
        code: `<AddFilter label="Reason" srSuffix="requests" options={[
  { href: '?reason=issuer_unknown', label: 'Unknown issuer', slug: 'issuer_unknown', count: 182 },
  { href: '?reason=no_matching_grant', label: 'No issuer access rules allows this call', slug: 'no_matching_grant', count: 59 },
  { href: '?reason=upstream_5xx', label: 'Upstream error', slug: 'upstream_5xx', count: 12 },
]} />`,
      },
      {
        title: 'Menus only, at the end of the tray header',
        description:
          'The audit log: no search box, so the bar is a labelled group of menus (as="group") next to the tray title.',
        layout: 'stack',
        render: () => (
          <Tray
            id="ex-flt-audit"
            title="Audit events, newest first"
            description="Last 30 days · times in UTC"
            actions={
              <Filters as="group" end label="Filter audit events">
                <AddFilter
                  label="Who"
                  options={[
                    { href: '?actor=maya', label: 'Maya Chen', logoSlot: avatar('MC'), count: 9 },
                    { href: '?actor=diego', label: 'Diego Ruiz', logoSlot: avatar('DR'), count: 8 },
                  ]}
                  extra={[{ href: '?actor=system', label: 'System (hourly job)', count: 1 }]}
                />
                <AddFilter
                  label="Target"
                  options={[
                    {
                      href: '?target=slack',
                      label: 'Slack',
                      logo: logo('slack', 'S'),
                      slug: 'token',
                    },
                    {
                      href: '?target=github-acme',
                      label: 'GitHub Actions (acme)',
                      logo: logo('github', 'GH'),
                      slug: 'consumer',
                    },
                  ]}
                />
              </Filters>
            }
          >
            <Panel>
              <Feed compact>
                <FeedItem
                  avatar={avatar('PN')}
                  time={<Time datetime="2026-10-15T13:02Z" format="clock" />}
                >
                  <b>Priya Natarajan</b> disabled the token Slack (legacy)
                </FeedItem>
                <FeedItem
                  avatar={avatar('DR')}
                  time={<Time datetime="2026-10-15T11:47Z" format="clock" />}
                >
                  <b>Diego Ruiz</b> extended acme/infra → GitHub
                </FeedItem>
              </Feed>
            </Panel>
          </Tray>
        ),
        code: `<Tray id="audit" title="Audit events, newest first" description="Last 30 days · times in UTC"
  actions={
    <Filters as="group" end label="Filter audit events">
      <AddFilter label="Who" options={people} extra={[{ href: '?actor=system', label: 'System (hourly job)', count: 1 }]} />
      <AddFilter label="Target" options={targets} />
    </Filters>
  }>
  …
</Tray>`,
      },
      {
        title: '“+ Reason” with about 45 codes in groups',
        description:
          'A long menu splits into titled groups (Caller, Access, Request, Token, Upstream) and scrolls past 24rem. Each group is a named group; its visible title is hidden from screen readers so it is not read twice. The id on the details is the target of an ErrorSummary link (#f-reason).',
        layout: 'stack',
        render: () => (
          <Tray
            id="ex-flt-groups"
            title="Denials by reason"
            count={253}
            actions={
              <Filters as="group" end label="Filter denied requests by reason">
                <AddFilter
                  id="ex-flt-reason-menu"
                  label="Reason"
                  open
                  srSuffix="requests"
                  options={REASON_GROUPS}
                />
              </Filters>
            }
          >
            <Panel variant="flush">
              <Table
                label="Denied requests by reason (example)"
                dense
                stackable
                columns={REQUEST_COLUMNS}
              >
                <RequestRows />
                <RequestRows />
              </Table>
            </Panel>
          </Tray>
        ),
        code: `<AddFilter id="f-reason" label="Reason" srSuffix="requests" open={errors.reason !== undefined} options={[
  { group: 'Caller', options: [
    { href: '?reason=issuer_unknown', label: 'Unknown issuer', slug: 'issuer_unknown', count: 182 },
    { href: '?reason=token_missing', label: 'No caller token', slug: 'token_missing', count: 31 },
    …
  ] },
  { group: 'Access', options: [
    { href: '?reason=no_matching_grant', label: 'No issuer access rules allows this call', slug: 'no_matching_grant', count: 59 },
    …
  ] },
  { group: 'Request', options: […] },
  { group: 'Credential', options: […] },
  { group: 'Upstream', options: […] },
]} />`,
      },
      {
        title: 'Invalid repository filter',
        description:
          'The browser checks the format (pattern, maxlength) before it submits; the server refuses what it cannot parse and renders the page again. The error line is the page’s FieldError in the bar, referenced by describedBy; invalid sets aria-invalid.',
        layout: 'stack',
        render: () => (
          <Filters label="Filter requests by repository (example)" submitLabel="Apply">
            <FilterSearch
              id="ex-flt-repo"
              label="Filter by repository"
              name="repo"
              value="acme/"
              placeholder="owner/name"
              pattern="[A-Za-z0-9_.\-]+/[A-Za-z0-9_.\-]+"
              maxlength={256}
              invalid
              describedBy="ex-flt-repo-error"
            />
            <FieldError id="ex-flt-repo-error">
              Type a repository as owner/name, for example acme/api.
            </FieldError>
          </Filters>
        ),
        code: `<Filters label="Filter requests" action="/admin/requests" submitLabel="Apply">
  <FilterSearch id="rq-repo" label="Filter by repository" name="repo" value={repo} placeholder="owner/name"
    pattern="[A-Za-z0-9_.\\-]+/[A-Za-z0-9_.\\-]+" maxlength={256}
    invalid={errors.repo !== undefined} describedBy={errors.repo ? 'rq-repo-error' : undefined} />
  {errors.repo ? <FieldError id="rq-repo-error">{errors.repo}</FieldError> : null}
</Filters>`,
      },
      {
        title: 'Active filters',
        description:
          'Each chip links to the list without that filter; Clear all links to the unfiltered list. Nothing renders when no filter is active.',
        layout: 'stack',
        render: () => (
          <>
            <ActiveFilters
              lead="Active filters"
              filters={[
                { label: 'Outcome: Denied', href: '?token=slack' },
                { label: 'Token: Slack', href: '?outcome=denied' },
              ]}
              clearHref="#"
            />
            <ActiveFilters
              lead="Filters"
              label="Filters on the map"
              filters={[{ label: 'Token: Slack', href: '#' }]}
            />
          </>
        ),
        code: `<ActiveFilters lead="Active filters" clearHref="/admin/requests" filters={[
  { label: 'Outcome: Denied', href: '?token=slack' },
  { label: 'Token: Slack', href: '?outcome=denied' },
]} />
<ActiveFilters lead="Filters" label="Filters on the map" filters={[{ label: 'Token: Slack', href: '/admin/issuer-access-rules' }]} />`,
      },
    ],
    props: [
      {
        component: 'Filters',
        props: [
          {
            name: 'label',
            type: 'string',
            required: true,
            description: 'Accessible name of the form or group ("Filter requests").',
          },
          {
            name: 'as',
            type: "'form' | 'group'",
            default: "'form'",
            description:
              'form: a GET form with role search. group: a div with role group, for menus only.',
          },
          { name: 'action', type: 'string', description: 'Form target (GET). Form only.' },
          {
            name: 'hidden',
            type: 'Record<string, string>',
            description: 'Applied filters kept as hidden inputs when the form submits. Form only.',
          },
          {
            name: 'submitLabel',
            type: 'string',
            description: 'Label of a trailing secondary submit button ("Apply"). Form only.',
          },
          {
            name: 'end',
            type: 'boolean',
            default: 'false',
            description: 'Sits at the right of the tray title instead of taking the row.',
          },
          classProp('form or div'),
          {
            name: 'children',
            type: 'Child',
            description: 'FilterSearch, AddFilter menus, a .suggest line.',
          },
        ],
      },
      {
        component: 'FilterSearch',
        props: [
          {
            name: 'id',
            type: 'string',
            required: true,
            description: 'Input id; the suggestion list is id-list.',
          },
          {
            name: 'label',
            type: 'string',
            required: true,
            description: 'Visually hidden label ("Search requests").',
          },
          { name: 'name', type: 'string', default: "'q'", description: 'Query parameter.' },
          { name: 'value', type: 'string', description: 'Current query.' },
          { name: 'placeholder', type: 'string', description: 'The exact format to type.' },
          {
            name: 'suggestions',
            type: 'readonly string[]',
            description: 'Known values for the browser datalist.',
          },
          {
            name: 'pattern',
            type: 'string',
            description: 'Format the browser checks before it submits (a repository owner/name).',
          },
          {
            name: 'maxlength',
            type: 'number',
            description: 'Longest query: 254 for an email search, 256 for a repository filter.',
          },
          {
            name: 'invalid',
            type: 'boolean',
            default: 'false',
            description: 'The query was refused: aria-invalid="true". Say why with describedBy.',
          },
          {
            name: 'describedBy',
            type: 'string',
            description:
              'Id of the hint or FieldError the page renders in the bar (aria-describedby). There is no error slot.',
          },
          classProp('label.search'),
        ],
      },
      {
        component: 'AddFilter',
        props: [
          {
            name: 'id',
            type: 'string',
            description:
              'Id of the details: the target of an ErrorSummary link (#f-reason). Pass open too on error.',
          },
          {
            name: 'label',
            type: 'string',
            required: true,
            description: 'What the menu filters by; the summary reads “+ Token”.',
          },
          {
            name: 'options',
            type: `readonly (${FILTER_OPTION_TYPE} | { group: string; options: readonly FilterOption[] })[]`,
            required: true,
            description:
              'One link per value, most rows first. A long list splits into titled groups (FilterOptionGroup); values and groups mix in the order given.',
          },
          {
            name: 'extra',
            type: 'readonly FilterOption[]',
            description: 'Special values after a divider.',
          },
          {
            name: 'srSuffix',
            type: 'string',
            description: 'Hidden unit after each count ("requests"). The space is added.',
          },
          {
            name: 'open',
            type: 'boolean',
            default: 'false',
            description: 'Render the menu open.',
          },
          classProp('details.fadd'),
        ],
      },
      {
        component: 'ActiveFilters',
        props: [
          {
            name: 'filters',
            type: 'readonly { label: Child; href: string }[]',
            required: true,
            description: 'Each chip: the filter in words, and the list without it.',
          },
          { name: 'clearHref', type: 'string', description: 'The unfiltered list.' },
          {
            name: 'clearLabel',
            type: 'string',
            default: "'Clear all'",
            description: 'Text of the clear link.',
          },
          { name: 'lead', type: 'Child', description: 'Visible text before the chips.' },
          {
            name: 'label',
            type: 'string',
            default: "'Active filters'",
            description: 'Accessible name of the group.',
          },
          classProp('div.achips'),
        ],
      },
    ],
    accessibility: [
      'The form has role search and a name, so it is a search landmark; a menus-only bar is a named group.',
      'The search input has a real label (visually hidden). The placeholder only shows the format.',
      'Each menu is a native details/summary: Enter or Space opens it, and its values are plain links in tab order. The summary reads “Filter by Token”; the “+” is hidden.',
      'Counts in a menu can carry a hidden unit (“2,140 requests”).',
      'An option group is a div with role group named by its title; the visible title is aria-hidden, so it is read once.',
      'A refused query sets aria-invalid on the input and points aria-describedby at the error line the page renders in the bar.',
      'Each active chip reads “Remove filter Token: Slack”; the ✕ is hidden.',
      'Everything is links and a GET form, with no JavaScript, so every filtered view is a URL.',
    ],
    do: [
      'Order menu values by row count, most first, and show the count.',
      'Keep the applied filters in hidden inputs so a new search does not drop them.',
      'Show active filters right above the table, with Clear all.',
    ],
    dont: [
      'Do not filter on change with scripts: there is no client JavaScript.',
      'Do not use a select for a filter with fewer than seven values.',
      'Do not hide an active filter: every filter in the URL has a chip.',
    ],
    classes: [
      'filters',
      'end',
      'search',
      'ic',
      'input',
      'fadd',
      'fpop',
      'fpop-h',
      'n',
      'slug',
      'achips',
      'achip',
      'x',
      'hint',
    ],
  },

  // ===== QuickLinks =============================================================================
  {
    slug: 'quick-links',
    name: 'QuickLinks',
    summary:
      'Status filter links with counts above a list, or the focus switch of the connections map; one link is current.',
    usage: {
      when: [
        'Two to eight fixed groups of a list, each with a count: All, Expiring, Disabled.',
        'Switching the focus of the connections map between consumers.',
        'A “Needs attention” row of problem filters with a lead text.',
      ],
      whenNot: [
        <>
          Free values (tokens, repositories): use <code>AddFilter</code>.
        </>,
        <>
          A range or view switch (24 hours, Map | Matrix): use the segmented control (
          <code>.seg</code>).
        </>,
      ],
    },
    examples: [
      {
        title: 'Status filters',
        description: 'The current link has the accent fill; glyphs are tinted but the word reads.',
        render: () => (
          <QuickLinks
            label="Filter tokens by status (example)"
            links={[
              { href: '#', label: 'All', count: 6, current: true },
              { href: '#', label: 'Expiring', count: 1, tone: 'warn', glyph: '⌛' },
              { href: '#', label: 'Disabled', count: 1, glyph: '⏸' },
            ]}
          />
        ),
        code: `<QuickLinks label="Filter tokens by status" links={[
  { href: '/admin/credentials', label: 'All', count: 6, current: true },
  { href: '/admin/credentials?status=expiring', label: 'Expiring', count: 1, tone: 'warn', glyph: '⌛' },
  { href: '/admin/credentials?status=disabled', label: 'Disabled', count: 1, glyph: '⏸' },
]} />`,
      },
      {
        title: 'Outcome filters',
        render: () => (
          <QuickLinks
            label="Outcome (example)"
            links={[
              { href: '#', label: 'All', count: '8,214', current: true },
              { href: '#', label: 'Denied', count: 241, tone: 'bad', glyph: '✕' },
              { href: '#', label: 'Errors', count: 12, tone: 'warn', glyph: '⚠' },
            ]}
          />
        ),
        code: `<QuickLinks label="Outcome" links={[
  { href: '?outcome=all', label: 'All', count: '8,214', current: true },
  { href: '?outcome=denied', label: 'Denied', count: 241, tone: 'bad', glyph: '✕' },
  { href: '?outcome=error', label: 'Errors', count: 12, tone: 'warn', glyph: '⚠' },
]} />`,
      },
      {
        title: 'With a lead and no current link',
        description:
          'Problem filters on Issuer access rules: a lead text names the row; none is current until one is picked.',
        render: () => (
          <QuickLinks
            label="Needs attention (example)"
            lead="Needs attention"
            links={[
              { href: '#', label: 'Inactive', count: 1, glyph: '⏸' },
              { href: '#', label: 'Expiring in 14 days', count: 1, tone: 'warn', glyph: '⌛' },
              { href: '#', label: 'Expired', count: 1, tone: 'bad', glyph: '✕' },
              { href: '#', label: 'Unused 30 days', count: 1 },
            ]}
          />
        ),
        code: `<QuickLinks label="Needs attention" lead="Needs attention" links={[
  { href: '?status=inactive', label: 'Inactive', count: 1, glyph: '⏸' },
  { href: '?status=expiring', label: 'Expiring in 14 days', count: 1, tone: 'warn', glyph: '⌛' },
  { href: '?status=expired', label: 'Expired', count: 1, tone: 'bad', glyph: '✕' },
  { href: '?status=unused', label: 'Unused 30 days', count: 1 },
]} />`,
      },
      {
        title: 'Focus switch without counts on All',
        render: () => (
          <QuickLinks
            label="Focus on a credential access rule (example)"
            links={[
              { href: '#', label: 'All credential access rules', current: true },
              { href: '#', label: 'GitHub Actions (acme)', count: 6 },
              { href: '#', label: 'GitLab CI (platform)', count: 2 },
              { href: '#', label: 'Buildkite (acme)', count: 1 },
            ]}
          />
        ),
        code: `<QuickLinks label="Focus on a credential access rule" links={[
  { href: '/admin/issuer-access-rules', label: 'All credential access rules', current: true },
  { href: '/admin/issuer-access-rules?focus=github-acme', label: 'GitHub Actions (acme)', count: 6 },
  { href: '/admin/issuer-access-rules?focus=gitlab-platform', label: 'GitLab CI (platform)', count: 2 },
  { href: '/admin/issuer-access-rules?focus=buildkite-acme', label: 'Buildkite (acme)', count: 1 },
]} />`,
      },
    ],
    props: [
      {
        component: 'QuickLinks',
        props: [
          {
            name: 'label',
            type: 'string',
            required: true,
            description: 'Accessible name of the navigation, unique on the page.',
          },
          {
            name: 'links',
            type: "readonly { href: string; label: Child; count?: number | string; tone?: 'warn' | 'bad'; glyph?: string; current?: boolean }[]",
            required: true,
            description: 'The links, in a fixed order. At most one is current.',
          },
          { name: 'lead', type: 'Child', description: 'Visible text before the links.' },
          classProp('nav.qlinks'),
        ],
      },
    ],
    accessibility: [
      'A nav landmark with a name; give each on a page its own label.',
      'The current link has aria-current="true", and forced colors add an outline to it.',
      'Glyphs are aria-hidden: “Denied 241” is read, never “✕”.',
    ],
    do: [
      'Show the count of every link, including All.',
      'Keep the order fixed: All first, then the statuses in the vocabulary order.',
    ],
    dont: ['Do not use quick links for actions.', 'Do not mark more than one link current.'],
    classes: ['qlinks', 'ql', 'warn', 'bad', 'g', 'n', 'meta'],
  },

  // ===== Pager ==================================================================================
  {
    slug: 'pager',
    name: 'Pager',
    summary:
      'The footer of a long table: what is shown, then an optional Newest link, Newer and Older cursor links; a missing end is faint text.',
    usage: {
      when: [
        'Under a table with more rows than one page (25): requests, audit events.',
        'Cursor pages, newest first: “Older” links to ?before=<last id>.',
      ],
      whenNot: [
        'A list that fits on one page: show the count in the tray title instead.',
        'Numbered pages: the logs are append-only, so cursors stay stable and numbers do not.',
      ],
    },
    examples: [
      {
        title: 'Links',
        description: 'The default inside a tray panel: both ends exist.',
        layout: 'stack',
        render: () => (
          <Panel variant="flush">
            <Pager summary="Showing 26–50 of 80" newer="#" older="#" label="Pages (example 1)" />
          </Panel>
        ),
        code: `<Pager summary="Showing 26–50 of 80" newer="?page=1" older="?page=3" />`,
      },
      {
        title: 'Buttons on the first page',
        description:
          'Long logs use small secondary buttons with arrows. On the first page there is nothing newer, so “Newer” is faint text, not a link.',
        layout: 'stack',
        render: () => (
          <Panel variant="flush">
            <Pager
              summary="Showing 1–25 of 8,214 · times in UTC"
              older="#"
              buttons
              label="Pages (example 2)"
            />
          </Panel>
        ),
        code: `<Pager summary="Showing 1–25 of 8,214 · times in UTC" older="?before=req_01JB8Z5JN9" buttons />`,
      },
      {
        title: 'Last page with custom labels',
        layout: 'stack',
        render: () => (
          <Panel variant="flush">
            <Pager
              summary="Showing 26–37 of 37 events in 30 days"
              newer="#"
              buttons
              newerLabel="Newer events"
              olderLabel="Older events"
              label="Audit log pages (example)"
            />
          </Panel>
        ),
        code: `<Pager summary="Showing 26–37 of 37 events in 30 days" newer="?after=evt_01JB8W2C" buttons
  newerLabel="Newer events" olderLabel="Older events" label="Audit log pages" />`,
      },
      {
        title: 'An older page of the log',
        description:
          'Deep in a log, “Newest entries” goes back to the first page in one step. It shows only when set: the first page has no Newest link, not a faint one.',
        layout: 'stack',
        render: () => (
          <Panel variant="flush">
            <Pager
              summary="Showing 201–225 of 8,214 · times in UTC"
              newest="#"
              newestLabel="Newest entries"
              newer="#"
              older="#"
              buttons
              label="Pages (example 4)"
            />
          </Panel>
        ),
        code: `<Pager summary="Showing 201–225 of 8,214 · times in UTC" buttons
  newest="/admin/requests" newestLabel="Newest entries"
  newer="?after=req_01JB8Y7Q" older="?before=req_01JB8X2M" />`,
      },
    ],
    props: [
      {
        component: 'Pager',
        props: [
          {
            name: 'summary',
            type: 'Child',
            required: true,
            description: 'What is shown ("Showing 1–25 of 8,214").',
          },
          { name: 'newer', type: 'string', description: 'Link to the newer page (rel prev).' },
          { name: 'older', type: 'string', description: 'Link to the older page (rel next).' },
          { name: 'newerLabel', type: 'string', default: "'Newer'", description: 'Text.' },
          { name: 'olderLabel', type: 'string', default: "'Older'", description: 'Text.' },
          {
            name: 'newest',
            type: 'string',
            description:
              'Link to the first page, shown first and only when set (an older page of a log). No rel, no faint placeholder.',
          },
          { name: 'newestLabel', type: 'string', default: "'Newest'", description: 'Text.' },
          {
            name: 'buttons',
            type: 'boolean',
            default: 'false',
            description: 'Small secondary buttons with arrows instead of text links.',
          },
          {
            name: 'label',
            type: 'string',
            default: "'Pages'",
            description: 'Accessible name of the navigation landmark.',
          },
          classProp('nav.pager'),
        ],
      },
    ],
    accessibility: [
      'A nav landmark named “Pages” (or label); name each pager differently when a page has two.',
      'A missing end is plain text, not a disabled or dead link, so it is never in the tab order.',
      'The arrows are aria-hidden; rel prev and next describe the order. The Newest link has no rel: it jumps, it is not the adjacent page.',
    ],
    do: [
      'Say what is shown, with the total and the time zone when the rows have times.',
      'Put the pager inside the table panel, after the table.',
    ],
    dont: [
      'Do not add page numbers or a page size picker.',
      'Do not render an end as a link to the same page.',
    ],
    classes: ['pager', 'end', 'faint', 'btn', 'sm', 'secondary'],
  },

  // ===== EmptyState =============================================================================
  {
    slug: 'empty-state',
    name: 'EmptyState',
    related: ['ZeroState'],
    summary:
      'What a panel shows when a list has no rows: a glyph, a sentence, why it matters and one action; or one muted line when empty is good news.',
    usage: {
      when: [
        'A list that is empty because nothing was set up yet (no access, no tokens): EmptyState with one primary action.',
        'A list that is empty for a good reason (nothing denied, nothing expiring): ZeroState.',
      ],
      whenNot: [
        'A filtered list with no match: keep the active filters and say “No requests match these filters” in a ZeroState with Clear all.',
        'An error loading data: use a callout.',
      ],
    },
    examples: [
      {
        title: 'After a kept table header',
        description:
          'The table keeps its header (scroll={false}, no rows) so the shape of the list stays visible; the empty state follows in the same panel.',
        layout: 'stack',
        render: () => (
          <Tray id="ex-empty" title="Issuer access rules" count={0}>
            <Panel variant="flush">
              <Table
                scroll={false}
                caption="Issuer access rules"
                columns={[{ label: 'Consumer → token' }, { label: 'Status' }, { label: 'Expires' }]}
              />
              <EmptyState
                icon="consumer"
                title="No workload can use a token yet"
                description="Add issuer access rule to a token so its CI jobs can call the API through tokengate."
                actions={
                  <>
                    <a class="btn primary" href="#">
                      Give access
                    </a>
                    <a href="#">How access works</a>
                  </>
                }
              />
            </Panel>
          </Tray>
        ),
        code: `<Tray id="access" title="Issuer access rules" count={0}>
  <Panel variant="flush">
    <Table scroll={false} caption="Issuer access rules"
      columns={[{ label: 'Consumer → token' }, { label: 'Status' }, { label: 'Expires' }]} />
    <EmptyState icon="consumer"
      title="No workload can use a token yet"
      description="Add issuer access rule to a token so its CI jobs can call the API through tokengate."
      actions={<><a class="btn primary" href="/admin/issuer-access-rules/new">Give access</a><a href="/docs/access">How access works</a></>} />
  </Panel>
</Tray>`,
      },
      {
        title: 'Title only',
        layout: 'stack',
        render: () => (
          <Panel>
            <EmptyState title="No requests yet" headingLevel={4} />
          </Panel>
        ),
        code: `<EmptyState title="No requests yet" headingLevel={4} />`,
      },
      {
        title: 'Zero state',
        description: 'One muted line, no glyph, no action: nothing needs fixing.',
        layout: 'stack',
        render: () => (
          <Panel>
            <ZeroState>No denied calls in the last 24 hours.</ZeroState>
          </Panel>
        ),
        code: `<Panel>
  <ZeroState>No denied calls in the last 24 hours.</ZeroState>
</Panel>`,
      },
    ],
    props: [
      {
        component: 'EmptyState',
        props: [
          {
            name: 'title',
            type: 'Child',
            required: true,
            description: 'What is missing, as a sentence.',
          },
          { name: 'description', type: 'Child', description: 'Why it matters, what to do.' },
          {
            name: 'icon',
            type: 'IconName',
            description: 'Icon of the set in the 40px tile, decorative (aria-hidden).',
          },
          {
            name: 'actions',
            type: 'Child',
            description: 'One primary button, then an optional link (in .btn-row).',
          },
          {
            name: 'headingLevel',
            type: '2 | 3 | 4',
            default: '3',
            description: 'Level of the title; a Tray around it shifts it one under its own title.',
          },
          classProp('div.empty'),
        ],
      },
      {
        component: 'ZeroState',
        props: [
          classProp('p.oneline'),
          { name: 'children', type: 'Child', required: true, description: 'One sentence.' },
        ],
      },
    ],
    accessibility: [
      'The title is a heading (h3 under a tray title by default), so it shows in the headings list.',
      'The glyph tile is aria-hidden; the heading and the text carry the message.',
      'Keep the table header before an empty state only when it helps: screen readers announce an empty table with its columns.',
    ],
    do: [
      'Name what is missing and the outcome of the action (“Give access”).',
      'Use exactly one primary action.',
    ],
    dont: [
      'Do not show an EmptyState for good news: use ZeroState.',
      'Do not write “No data” or “Nothing here”.',
    ],
    classes: ['empty', 'glyph', 'btn-row', 'oneline'],
  },

  // ===== KeyValue ===============================================================================
  {
    slug: 'key-value',
    name: 'KeyValue',
    related: ['RailKeyValue', 'RailFoot'],
    summary:
      'Facts lists: label and value rows in the main column (12rem labels), and label-over-value rows in the right rail.',
    usage: {
      when: [
        'The settings of one object in the main column: upstream, proxy URL, allowed hosts.',
        'The IDs and dates of a detail page in the right rail: token ID, slug, created, updated.',
      ],
      whenNot: [
        <>
          Many objects of one kind: use <code>Table</code>.
        </>,
        <>
          A secret: use <code>Secret</code>, never a plain value.
        </>,
      ],
    },
    examples: [
      {
        title: 'Detail main column and right rail',
        description:
          'KeyValue under the secret in the main column; RailKeyValue in the rail with mono, copyable IDs and a “by” line. The rail sits beside the main column at 80rem and above, below it otherwise.',
        layout: 'stack',
        render: () => (
          <div class="detail">
            <div class="col">
              <Tray id="ex-kv-main" title="Secret">
                <Panel variant="pad">
                  <KeyValue
                    items={[
                      { label: 'Upstream', value: 'https://slack.com/api', mono: true },
                      {
                        label: 'Proxy URL',
                        value: (
                          <>
                            <span class="mono copyable">https://gate.acme.dev/proxy/slack</span>{' '}
                            <span class="hint">(select to copy)</span>
                          </>
                        ),
                      },
                      {
                        label: 'Allowed hosts',
                        line: true,
                        value: (
                          <>
                            <span class="chip text mono">slack.com</span>
                            <span class="chip text mono">files.slack.com</span>
                          </>
                        ),
                      },
                    ]}
                  />
                </Panel>
              </Tray>
            </div>
            <aside class="rail" aria-label="Details (example)">
              <Tray id="ex-kv-rail" title="Details">
                <Panel>
                  <RailKeyValue
                    items={[
                      {
                        label: 'Credential ID',
                        value: 'svc_01JB8Z5K2Q7W3N4M6P8R9T7Q2M',
                        mono: true,
                        copyable: true,
                      },
                      { label: 'Slug', value: 'slack', mono: true },
                      { label: 'Created', value: '3 Oct 2026', note: 'by Priya Natarajan' },
                      { label: 'Updated', value: 'Today 09:12', note: 'by Maya Chen' },
                    ]}
                  />
                </Panel>
              </Tray>
            </aside>
          </div>
        ),
        code: `<KeyValue items={[
  { label: 'Upstream', value: 'https://slack.com/api', mono: true },
  { label: 'Proxy URL', value: <><span class="mono copyable">https://gate.acme.dev/proxy/slack</span> <span class="hint">(select to copy)</span></> },
  { label: 'Allowed hosts', line: true, value: <><span class="chip text mono">slack.com</span><span class="chip text mono">files.slack.com</span></> },
]} />

<aside class="rail" aria-label="Details">
  <Tray id="details" title="Details">
    <Panel>
      <RailKeyValue items={[
        { label: 'Credential ID', value: 'svc_01JB8Z5K2Q7W3N4M6P8R9T7Q2M', mono: true, copyable: true },
        { label: 'Slug', value: 'slack', mono: true },
        { label: 'Created', value: '3 Oct 2026', note: 'by Priya Natarajan' },
        { label: 'Updated', value: 'Today 09:12', note: 'by Maya Chen' },
      ]} />
    </Panel>
  </Tray>
</aside>`,
      },
      {
        title: 'Rail panel with a footer link',
        description:
          'RailFoot is the last line of a rail panel: one link to the full list, over a top border.',
        layout: 'stack',
        render: () => (
          <Panel>
            <RailKeyValue
              items={[
                {
                  label: 'Credential ID',
                  value: 'svc_01JB8Y2K4M6P8R0T2V4X6Z8A1C',
                  mono: true,
                  copyable: true,
                },
                { label: 'Created', value: '3 Oct 2026', note: 'by Priya Natarajan' },
              ]}
            />
            <RailFoot>
              <LinkAction href="#" arrow>
                Audit history
              </LinkAction>
            </RailFoot>
          </Panel>
        ),
        code: `<Panel>
  <RailKeyValue items={[…]} />
  <RailFoot><LinkAction href="/admin/audit?target=svc_01JB8Y2K…" arrow>Audit history</LinkAction></RailFoot>
</Panel>`,
      },
    ],
    props: [
      {
        component: 'KeyValue',
        props: [
          {
            name: 'items',
            type: 'readonly { label: Child; value: Child; mono?: boolean; copyable?: boolean; line?: boolean }[]',
            required: true,
            description: (
              <>
                One row per fact. <code>mono</code> for URLs and IDs, <code>copyable</code> selects
                the whole value on click, <code>line</code> wraps chips with an 8px gap.
              </>
            ),
          },
          classProp('dl.kv'),
        ],
      },
      {
        component: 'RailKeyValue',
        props: [
          {
            name: 'items',
            type: 'readonly { label: Child; value: Child; mono?: boolean; copyable?: boolean; note?: Child }[]',
            required: true,
            description: (
              <>
                One fact per row, label above value. <code>note</code> is a small second line (“by
                Maya Chen”); do not combine it with <code>copyable</code>.
              </>
            ),
          },
          classProp('dl.rkv'),
        ],
      },
      {
        component: 'RailFoot',
        props: [
          { name: 'class', type: 'string', description: 'Extra classes on p.rail-foot.' },
          {
            name: 'children',
            type: 'Child',
            required: true,
            description: 'One link to the full list.',
          },
        ],
      },
    ],
    accessibility: [
      'A description list: screen readers announce each term with its value.',
      'Copyable values use user-select: all, so a click or double-click selects the whole ID; there is no copy button and no JavaScript.',
      'Below 48rem the KeyValue label moves above its value; the reading order does not change.',
    ],
    do: ['Use the same labels as the form that sets the value.', 'Make IDs mono and copyable.'],
    dont: [
      'Do not put actions in a value; put them in the tray header.',
      'Do not show a secret, even masked, in a facts list: use Secret.',
    ],
    classes: ['kv', 'line', 'rkv', 'mono', 'copyable', 'rail-foot'],
  },

  // ===== Secret =================================================================================
  {
    slug: 'secret',
    name: 'Secret',
    summary:
      'A stored secret: the masked last 4 characters, its facts, and Replace or Test. Never Reveal, never Copy.',
    usage: {
      when: ['The Secret tray of a token detail page.'],
      whenNot: [
        <>
          A short masked value in a table or feed: <a href="/docs/components/base/mask">Mask</a>{' '}
          (Secret draws its own mask with it, so both render only the last 4 characters).
        </>,
        'A token with no secret: show the badge “– No secret” and the action to add one.',
      ],
    },
    examples: [
      {
        title: 'In the Secret tray',
        layout: 'stack',
        render: () => (
          <Tray
            id="ex-secret"
            title="Secret"
            description="Only the last 4 characters are kept for display."
          >
            <Panel variant="pad">
              <Secret
                last4="9fQa"
                facts="Bot token · 51 characters"
                meta={
                  <>
                    Set 3 Oct 2026 by Priya Natarajan · does not expire · sealed with key{' '}
                    <code>k2</code>
                  </>
                }
                actions={
                  <>
                    <button class="btn secondary" type="button">
                      Replace secret
                    </button>
                    <button class="btn secondary" type="button">
                      Test
                    </button>
                  </>
                }
              />
            </Panel>
          </Tray>
        ),
        code: `<Secret last4="9fQa" facts="Bot token · 51 characters"
  meta={<>Set 3 Oct 2026 by Priya Natarajan · does not expire · sealed with key <code>k2</code></>}
  actions={<>
    <a class="btn secondary" href="/admin/credentials/slack/secret">Replace secret</a>
    <form method="post" action="/admin/credentials/slack/test"><button class="btn secondary">Test</button></form>
  </>} />`,
      },
      {
        title: 'Mask only',
        layout: 'stack',
        render: () => <Secret last4="x7Lm" srPrefix="API key ending in" />,
        code: `<Secret last4="x7Lm" srPrefix="API key ending in" />`,
      },
    ],
    props: [
      {
        component: 'Secret',
        props: [
          {
            name: 'last4',
            type: 'string',
            description:
              'The last 4 characters, the only part kept for display. Missing or empty: the mask says they are not stored.',
          },
          { name: 'facts', type: 'Child', description: 'Kind and length.' },
          { name: 'meta', type: 'Child', description: 'Set when, by whom, expiry, key.' },
          {
            name: 'actions',
            type: 'Child',
            description: 'Replace secret and Test (secondary buttons).',
          },
          {
            name: 'srPrefix',
            type: 'string',
            default: "'Secret ending in'",
            description: 'Hidden text before the last 4 characters. The space is added.',
          },
          classProp('div.secret'),
        ],
      },
    ],
    accessibility: [
      'Screen readers hear “Secret ending in 9fQa”; the bullets are aria-hidden.',
      'The full secret is never in the page, so nothing can leak from the DOM, a screenshot or a screen reader.',
    ],
    do: ['Say how long the secret is and when and by whom it was set.'],
    dont: ['Do not add Reveal or Copy actions.', 'Do not show more than the last 4 characters.'],
    classes: ['secret', 'mask', 'lg', 'facts', 'meta', 'acts'],
  },

  // ===== Feed ===================================================================================
  {
    slug: 'feed',
    name: 'Feed',
    related: ['FeedItem', 'FeedDay'],
    summary:
      'An activity feed: one sentence per event, avatar first and time last, grouped by day in the audit log.',
    usage: {
      when: [
        'The audit log: who changed what, with the event code and the before/after diff.',
        'The History tray in the right rail of a detail page (compact).',
        'Recent changes on the Overview.',
      ],
      whenNot: [
        <>
          Requests (machine calls): use a dense <code>Table</code>.
        </>,
      ],
    },
    examples: [
      {
        title: 'Audit log, grouped by day',
        description:
          'Day headings between feeds in one panel; each event has a meta line (code, badge, History link), and one opens its diff.',
        layout: 'stack',
        render: () => (
          <Tray id="ex-feed" title="Audit events, newest first" description="Times in UTC">
            <Panel variant="flush">
              <FeedDay>Today, 15 Oct</FeedDay>
              <Feed>
                <FeedItem
                  avatar={avatar('PN')}
                  time={<Time datetime="2026-10-15T13:02Z" format="clock" />}
                  meta={
                    <>
                      <code>service.update</code>
                      <a href="#">History</a>
                    </>
                  }
                >
                  <a href="#">Priya Natarajan</a> disabled the token <a href="#">Slack (legacy)</a>.
                </FeedItem>
                <FeedItem
                  avatar={avatar('DR')}
                  time={<Time datetime="2026-10-15T11:47Z" format="clock" />}
                  meta={
                    <>
                      <code>grant.update</code>
                      <a href="#">History</a>
                    </>
                  }
                  details={
                    <details class="disc" open>
                      <summary>
                        Changes: expires<span class="vh"> for acme/infra → GitHub at 11:47</span>
                      </summary>
                      <div class="disc-b">
                        <DiffTable
                          caption="Changes to acme/infra → GitHub at 11:47"
                          rows={[{ field: 'Expires', before: '16 Oct 2026', after: '14 Nov 2026' }]}
                        />
                      </div>
                    </details>
                  }
                >
                  <a href="#">Diego Ruiz</a> extended <a href="#">acme/infra → GitHub</a> to 14 Nov
                  2026.
                </FeedItem>
              </Feed>
              <FeedDay>2 Oct</FeedDay>
              <Feed>
                <FeedItem
                  avatar={avatar('DR')}
                  time={<Time datetime="2026-10-02T16:20Z" format="clock" />}
                  meta={
                    <>
                      <code>grant.update</code>
                      <Badge tone="warn" glyph="⚠">
                        Risk accepted
                      </Badge>
                    </>
                  }
                >
                  <a href="#">Diego Ruiz</a> accepted a risk on <a href="#">acme/infra → GitHub</a>:
                  any branch, tag or environment.
                </FeedItem>
              </Feed>
            </Panel>
          </Tray>
        ),
        code: `<Panel variant="flush">
  <FeedDay>Today, 15 Oct</FeedDay>
  <Feed>
    <FeedItem avatar={<span class="avatar" aria-hidden="true">PN</span>}
      time={<Time datetime="2026-10-15T13:02Z" format="clock" />}
      meta={<><code>service.update</code><a href="?target=slack-legacy">History</a></>}>
      <a href="?actor=priya">Priya Natarajan</a> disabled the token <a href="/admin/credentials/slack-legacy">Slack (legacy)</a>.
    </FeedItem>
    <FeedItem avatar={…} time={<Time datetime="2026-10-15T11:47Z" format="clock" />}
      meta={<><code>grant.update</code><a href="?target=a5">History</a></>}
      details={
        <details class="disc"><summary>Changes: expires<span class="vh"> for acme/infra → GitHub at 11:47</span></summary>
          <div class="disc-b"><DiffTable caption="Changes to acme/infra → GitHub at 11:47"
            rows={[{ field: 'Expires', before: '16 Oct 2026', after: '14 Nov 2026' }]} /></div>
        </details>
      }>
      <a href="?actor=diego">Diego Ruiz</a> extended <a href="/admin/issuer-access-rules/a5">acme/infra → GitHub</a> to 14 Nov 2026.
    </FeedItem>
  </Feed>
  <FeedDay>2 Oct</FeedDay>
  <Feed>…</Feed>
</Panel>`,
      },
      {
        title: 'Compact rail history',
        description: 'One-line sentences, 24px avatars, the day and time in the time cell.',
        layout: 'stack',
        render: () => (
          <aside class="rail" aria-label="History (example)">
            <Tray
              id="ex-feed-rail"
              title="History"
              actions={
                <a class="sm" href="#">
                  Audit log
                </a>
              }
            >
              <Panel>
                <Feed compact>
                  <FeedItem
                    avatar={avatar('MC')}
                    time={<Time datetime="2026-10-15T09:12Z" format="clock" />}
                  >
                    <b>Maya Chen</b> gave <a href="#">acme/api</a> access
                  </FeedItem>
                  <FeedItem
                    avatar={avatar('PN')}
                    time={<Time datetime="2026-10-03T14:20Z" format="day" />}
                  >
                    <b>Priya Natarajan</b> replaced the secret
                  </FeedItem>
                  <FeedItem
                    avatar={systemAvatar}
                    time={<Time datetime="2026-10-02T03:00Z" format="day" />}
                  >
                    <b>System (hourly job)</b> purged 41,200 request records
                  </FeedItem>
                </Feed>
              </Panel>
            </Tray>
          </aside>
        ),
        code: `<Tray id="history" title="History" actions={<a class="sm" href="/admin/audit?target=slack">Audit log</a>}>
  <Panel>
    <Feed compact>
      <FeedItem avatar={<span class="avatar" aria-hidden="true">MC</span>}
        time={<Time datetime="2026-10-15T09:12Z" format="clock" />}>
        <b>Maya Chen</b> gave <a href="/admin/issuer-access-rules/a1">acme/api</a> access
      </FeedItem>
      <FeedItem avatar={<span class="avatar" aria-hidden="true">PN</span>}
        time={<Time datetime="2026-10-03T14:20Z" format="day" />}>
        <b>Priya Natarajan</b> replaced the secret
      </FeedItem>
    </Feed>
  </Panel>
</Tray>`,
      },
    ],
    props: [
      {
        component: 'Feed',
        props: [
          {
            name: 'compact',
            type: 'boolean',
            default: 'false',
            description: 'Rail history: 24px avatars, 13px text.',
          },
          classProp('ol.feed'),
          { name: 'children', type: 'Child', description: 'FeedItem elements, newest first.' },
        ],
      },
      {
        component: 'FeedItem',
        props: [
          {
            name: 'avatar',
            type: 'Child',
            required: true,
            description: 'Decorative avatar (aria-hidden); the sentence names the person.',
          },
          {
            name: 'time',
            type: 'Child',
            required: true,
            description: 'When: a Time element.',
          },
          {
            name: 'meta',
            type: 'Child',
            description: 'Line under the sentence: event code, badge, History link.',
          },
          {
            name: 'details',
            type: 'Child',
            description: 'Below the meta line: a details.disc with a DiffTable.',
          },
          classProp('li'),
          {
            name: 'children',
            type: 'Child',
            required: true,
            description: 'The sentence: actor, verb, object.',
          },
        ],
      },
      {
        component: 'FeedDay',
        props: [
          {
            name: 'headingLevel',
            type: '2 | 3 | 4',
            default: '3',
            description: 'Heading level; a Tray around it shifts it.',
          },
          classProp('heading'),
          { name: 'children', type: 'Child', required: true, description: 'The day.' },
        ],
      },
    ],
    accessibility: [
      'An ordered list, newest first: screen readers announce the number of events.',
      'Day headings (h3) let people jump between days with the headings list.',
      'Times are time elements with a datetime attribute; the text is short and the attribute is exact.',
      'The avatar is aria-hidden: the sentence always names the actor in words.',
      'A diff disclosure names its event in hidden text, so “Changes: expires” is not ambiguous in a list of summaries.',
    ],
    do: [
      'Write each event as a full sentence with the object name as a link.',
      'Group long feeds by day, with the day in the heading and the time in each row.',
    ],
    dont: [
      'Do not show raw JSON; show a DiffTable of the changed fields.',
      'Do not use relative times older than a day (“3 weeks ago”): use the date.',
    ],
    classes: ['feed', 'compact', 's', 'meta', 'avatar', 'day'],
  },

  // ===== DiffTable ==============================================================================
  {
    slug: 'diff-table',
    name: 'DiffTable',
    summary:
      'The before/after table of one audit event: a row per changed field, the old value struck, the new one in green.',
    usage: {
      when: [
        'The changes of an update event in the audit log, inside a details.disc disclosure.',
        'A confirm dialog that shows what an edit will change.',
      ],
      whenNot: [
        <>
          A create or delete event: the sentence and the meta line say it; use <code>KeyValue</code>{' '}
          to list the created values.
        </>,
      ],
    },
    examples: [
      {
        title: 'One changed field',
        render: () => (
          <DiffTable
            caption="Changes to acme/infra → GitHub at 11:47"
            rows={[{ field: 'Expires', before: '16 Oct 2026', after: '14 Nov 2026' }]}
          />
        ),
        code: `<DiffTable caption="Changes to acme/infra → GitHub at 11:47"
  rows={[{ field: 'Expires', before: '16 Oct 2026', after: '14 Nov 2026' }]} />`,
      },
      {
        title: 'Several fields, added and cleared values',
        description:
          'A missing value reads “Not set”, so a cleared field is still a visible change.',
        render: () => (
          <DiffTable
            caption="Changes to acme/web · branch main → Anthropic"
            rows={[
              { field: 'Branch', before: 'main', after: 'release/*' },
              { field: 'Operations', before: 'Messages', after: 'Messages, Count tokens' },
              { field: 'Note', after: 'Release jobs only' },
              { field: 'Expires', before: '1 Jan 2027' },
            ]}
          />
        ),
        code: `<DiffTable caption="Changes to acme/web · branch main → Anthropic" rows={[
  { field: 'Branch', before: 'main', after: 'release/*' },
  { field: 'Operations', before: 'Messages', after: 'Messages, Count tokens' },
  { field: 'Note', after: 'Release jobs only' },
  { field: 'Expires', before: '1 Jan 2027' },
]} />`,
      },
      {
        title: 'In an audit disclosure',
        layout: 'stack',
        render: () => (
          <details class="disc" open>
            <summary>
              Changes: role<span class="vh"> for alex@acme.dev at 17:05</span>
            </summary>
            <div class="disc-b">
              <DiffTable
                caption="Changes to alex@acme.dev at 17:05"
                labels={{ field: 'Setting', before: 'Was', after: 'Now' }}
                rows={[{ field: 'Role', before: 'Viewer', after: 'Access manager' }]}
              />
              <p class="hint">
                Event <span class="idchip">evt_01JB8W2C</span> · IP 203.0.113.24 · Firefox 131 on
                macOS
              </p>
            </div>
          </details>
        ),
        code: `<details class="disc">
  <summary>Changes: role<span class="vh"> for alex@acme.dev at 17:05</span></summary>
  <div class="disc-b">
    <DiffTable caption="Changes to alex@acme.dev at 17:05" labels={{ field: 'Setting', before: 'Was', after: 'Now' }}
      rows={[{ field: 'Role', before: 'Viewer', after: 'Access manager' }]} />
    <p class="hint">Event <span class="idchip">evt_01JB8W2C</span> · IP 203.0.113.24 · Firefox 131 on macOS</p>
  </div>
</details>`,
      },
    ],
    props: [
      {
        component: 'DiffTable',
        props: [
          {
            name: 'rows',
            type: 'readonly { field: Child; before?: Child; after?: Child }[]',
            required: true,
            description: 'One row per changed field; a missing value shows emptyText.',
          },
          {
            name: 'caption',
            type: 'Child',
            required: true,
            description: 'Hidden caption naming the event: the table always has a name.',
          },
          {
            name: 'labels',
            type: '{ field?: string; before?: string; after?: string }',
            default: 'Field / Before / After',
            description: 'Column headers.',
          },
          {
            name: 'emptyText',
            type: 'string',
            default: "'Not set'",
            description: 'Text for a missing value.',
          },
          classProp('table.diff'),
        ],
      },
    ],
    accessibility: [
      'Column headers say Before and After and each field is a row header, so a screen reader reads “Expires, Before, 16 Oct 2026”.',
      'del and ins add strike-through and weight; color is never the only cue.',
      'A caption names the event when the table is outside a labelled disclosure.',
    ],
    do: ['Show only the fields that changed, named as in the form.'],
    dont: ['Do not show internal field names or JSON paths.'],
    classes: ['diff', 'faint'],
  },

  // ===== Time ===================================================================================
  {
    slug: 'time',
    name: 'Time',
    summary:
      'A moment as a time element: the exact value in datetime, the text formatted in UTC or given as a relative phrase.',
    usage: {
      when: [
        'Every time and date in tables, feeds and facts.',
        'Log cells (mono, 13px, one line) with mono.',
      ],
      whenNot: ['A duration (812 ms) or a range (24 hours): those are plain text.'],
    },
    examples: [
      {
        title: 'Formats',
        description: 'Always UTC with English month names, the same on every server.',
        render: () => (
          <>
            <Time datetime="2026-10-15T14:03:22Z" format="time" />
            <Time datetime="2026-10-15T14:03:22Z" format="clock" />
            <Time datetime="2026-10-15T14:03:22Z" format="day" />
            <Time datetime="2026-10-15T14:03:22Z" format="date" />
            <Time datetime="2026-10-15T14:03:22Z" />
          </>
        ),
        code: `<Time datetime="2026-10-15T14:03:22Z" format="time" />   {/* 14:03:22 */}
<Time datetime="2026-10-15T14:03:22Z" format="clock" />  {/* 14:03 */}
<Time datetime="2026-10-15T14:03:22Z" format="day" />    {/* 15 Oct */}
<Time datetime="2026-10-15T14:03:22Z" format="date" />   {/* 15 Oct 2026 */}
<Time datetime="2026-10-15T14:03:22Z" />                 {/* 15 Oct 2026, 14:03 (datetime) */}`,
      },
      {
        title: 'Relative text and log cells',
        description:
          'Children replace the formatted text (“2 min ago”); the attribute keeps the exact moment. mono is the log cell style.',
        render: () => (
          <>
            <Time datetime={new Date('2026-10-15T14:01:00Z')}>2 min ago</Time>
            <Time datetime="2026-10-15T09:12Z">Today 09:12</Time>
            <Time datetime="2026-10-15T14:03:22Z" format="time" mono />
          </>
        ),
        code: `<Time datetime={grant.lastUsedAt}>{ago(grant.lastUsedAt)}</Time>
<Time datetime="2026-10-15T09:12Z">Today 09:12</Time>
<Time datetime={request.at} format="time" mono />`,
      },
    ],
    props: [
      {
        component: 'Time',
        props: [
          {
            name: 'datetime',
            type: 'Date | string',
            required: true,
            description:
              'The moment. A string is written as given; a Date as ISO 8601 UTC. An invalid value drops the attribute.',
          },
          {
            name: 'format',
            type: "'time' | 'clock' | 'day' | 'date' | 'datetime'",
            default: "'datetime'",
            description:
              'Text when there are no children. Also exported as formatTime(date, format).',
          },
          {
            name: 'mono',
            type: 'boolean',
            default: 'false',
            description: 'Log cell style (.time): mono, 13px, secondary, one line.',
          },
          classProp('time'),
          {
            name: 'children',
            type: 'Child',
            description: 'Text instead of the formatted value (a relative time).',
          },
        ],
      },
    ],
    accessibility: [
      'The datetime attribute gives assistive tech and tools the exact moment, whatever the text says.',
      'Say the time zone once near the times (“times in UTC” in the tray or the pager).',
    ],
    do: ['Use relative text only for the last 24 hours; use the date after that.'],
    dont: [
      'Do not format with the server locale: use format or formatTime so every page reads the same.',
    ],
    classes: ['time'],
  },
];
