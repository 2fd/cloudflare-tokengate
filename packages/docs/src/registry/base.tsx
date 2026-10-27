// Docs entries of the "base" group (packages/ui/src/components/base). One ComponentDoc per
// component page, in nav order. Only the base group agent edits this file.
import {
  AskSomeone,
  Avatar,
  Badge,
  Button,
  ButtonRow,
  Callout,
  Chip,
  Chips,
  CodeBlock,
  Dot,
  ICON_NAMES,
  Icon,
  IdChip,
  Kbd,
  LOGO_BRANDS,
  LinkAction,
  Logo,
  LogoStack,
  Mask,
  Mono,
  Notice,
  RiskTag,
  STATUS_VOCABULARY,
  Slug,
  Status,
  type LogoBrand,
  type StatusKind,
} from '@tokengate/ui';
import type { ComponentDoc, PropDoc } from './types';

const CLASS_PROP: PropDoc = {
  name: 'class',
  type: 'string',
  description: 'Extra classes on the root element, after the component’s own.',
};

const BRANDS = Object.keys(LOGO_BRANDS) as LogoBrand[];
const STATUSES = Object.keys(STATUS_VOCABULARY) as StatusKind[];
const TONE_TYPE = "'ok' | 'warn' | 'bad' | 'info' | 'pending' | 'off'";
const STATUS_TYPE = STATUSES.map((status) => `'${status}'`).join(' | ');

export const base: readonly ComponentDoc[] = [
  // ----- Button ---------------------------------------------------------------------------------
  {
    slug: 'button',
    name: 'Button',
    related: ['ButtonRow', 'LinkAction'],
    summary:
      'A button or a link styled as one, in five variants and two sizes; its label names the outcome.',
    usage: {
      when: [
        <>
          <b>Primary</b>: exactly one per page header (top right), and the first submit of a form
          (“Give access”).
        </>,
        <>
          <b>Secondary</b> (default): every other action with a label. Row actions are small
          secondary buttons with a screen-reader suffix, srSuffix (“Disable acme/api → Slack”).
        </>,
        <>
          <b>Ghost</b>: inline adds inside a form (“+ Add another repository”).
        </>,
        <>
          <b>Danger</b>: on a page, opens a confirm dialog; the label ends with “…”.{' '}
          <b>Danger solid</b>: only the confirm button inside that dialog.
        </>,
        <>
          <code>LinkAction</code>: a text link that reads as an action (“See denied →”).
        </>,
      ],
      whenNot: [
        'An icon-only button: there are none. Every button has a visible label.',
        <>
          Navigation inside a page: use tabs or a segmented link (layout group), not a row of
          buttons.
        </>,
      ],
    },
    examples: [
      {
        title: 'Variants',
        description:
          'One solid primary per page header. Secondary has a 1px control border (3:1). Danger is an outline on the page; solid danger lives only inside the confirm dialog.',
        render: () => (
          <>
            <Button variant="primary" plus>
              Add credential
            </Button>
            <Button>Replace secret</Button>
            <Button variant="ghost">+ Add another repository</Button>
            <Button variant="danger">Delete Slack…</Button>
            <Button variant="danger-solid">Delete Slack</Button>
          </>
        ),
        code: `<Button variant="primary" plus>Add credential</Button>
<Button>Replace secret</Button>
<Button variant="ghost">+ Add another repository</Button>
<Button variant="danger">Delete Slack…</Button>
<Button variant="danger-solid">Delete Slack</Button>`,
      },
      {
        title: 'Small (32px) and row actions',
        description:
          'Row and tray actions are small. The srSuffix prop adds hidden text that names the row, so a list of “Disable” buttons is not ambiguous.',
        render: () => (
          <>
            <Button size="sm" variant="primary">
              Give access
            </Button>
            <Button size="sm" srSuffix="acme/api → Slack">
              Disable
            </Button>
            <Button size="sm" variant="ghost">
              Extend
            </Button>
            <Button size="sm" variant="danger">
              Remove…
            </Button>
            <LinkAction href="#" arrow>
              See denied
            </LinkAction>
          </>
        ),
        code: `<Button size="sm" variant="primary">Give access</Button>
<Button size="sm" srSuffix="acme/api → Slack">Disable</Button>
<Button size="sm" variant="ghost">Extend</Button>
<Button size="sm" variant="danger">Remove…</Button>
<LinkAction href="/admin/requests?outcome=denied" arrow>See denied</LinkAction>`,
      },
      {
        title: 'With an icon',
        description: 'The icon is decorative and always comes with the label.',
        render: () => (
          <>
            <Button icon="search">Find a request</Button>
            <Button variant="primary" icon="token">
              Add credential
            </Button>
            <Button size="sm" icon="arrow-right">
              Open issuer access rules
            </Button>
          </>
        ),
        code: `<Button icon="search">Find a request</Button>
<Button variant="primary" icon="token">Add credential</Button>
<Button size="sm" icon="arrow-right">Open issuer access rules</Button>`,
      },
      {
        title: 'Disabled',
        description:
          'Prefer AskSomeone over a disabled button when the reader lacks permission. A disabled link loses its href.',
        render: () => (
          <>
            <Button variant="primary" disabled>
              Give access
            </Button>
            <Button disabled>Test</Button>
            <Button href="#" disabled>
              Export configuration
            </Button>
          </>
        ),
        code: `<Button variant="primary" disabled>Give access</Button>
<Button disabled>Test</Button>
<Button href="/admin/export" disabled>Export configuration</Button>`,
      },
      {
        title: 'Link and submit',
        description:
          'With href it is a link (GET navigation). In a form it is type="submit"; name and value pick the option, one click per role.',
        render: () => (
          <ButtonRow>
            <Button href="#" variant="primary" plus>
              Give access
            </Button>
            <form method="get" action="#">
              <Button type="submit" size="sm" name="role" value="viewer">
                Viewer
              </Button>
              <Button type="submit" size="sm" name="role" value="manager">
                Credential manager
              </Button>
            </form>
          </ButtonRow>
        ),
        code: `<ButtonRow>
  <Button href="/admin/issuer-access-rules/new?token=slack" variant="primary" plus>Give access</Button>
  <form method="post" action="/admin/users/sam/approve">
    <Button type="submit" size="sm" name="role" value="viewer">Viewer</Button>
    <Button type="submit" size="sm" name="role" value="manager">Credential manager</Button>
  </form>
</ButtonRow>`,
      },
      {
        title: 'Submit without validation',
        description:
          'formnovalidate skips the browser’s constraint validation for a secondary submit (add a row, refresh a preview) or a confirm that submits another form, so a half-filled form does not block it. Ignored with href.',
        render: () => (
          <form method="get" action="#">
            <ButtonRow>
              <Button type="submit" variant="primary">
                Give access
              </Button>
              <Button
                type="submit"
                variant="ghost"
                name="_action"
                value="add:cond"
                formnovalidate
                plus
              >
                Add condition
              </Button>
            </ButtonRow>
          </form>
        ),
        code: `<form method="post" action="/admin/issuer-access-rules/new">
  <ButtonRow>
    <Button type="submit" variant="primary">Give access</Button>
    <Button type="submit" variant="ghost" name="_action" value="add:cond" formnovalidate plus>
      Add condition
    </Button>
  </ButtonRow>
</form>`,
      },
      {
        title: 'Block and button row',
        description:
          'Block fills the width (narrow rails, phone layouts). ButtonRow wraps with 8px gaps; primary first.',
        layout: 'stack',
        render: () => (
          <>
            <Button variant="primary" block>
              Give access
            </Button>
            <ButtonRow>
              <Button variant="primary">Give access</Button>
              <Button href="#">Cancel</Button>
              <LinkAction href="#">How access works</LinkAction>
            </ButtonRow>
          </>
        ),
        code: `<Button variant="primary" block>Give access</Button>
<ButtonRow>
  <Button variant="primary">Give access</Button>
  <Button href="/admin/issuer-access-rules">Cancel</Button>
  <LinkAction href="/docs/access">How access works</LinkAction>
</ButtonRow>`,
      },
    ],
    props: [
      {
        component: 'Button',
        props: [
          {
            name: 'variant',
            type: "'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-solid'",
            default: "'secondary'",
            description: 'Which button: see “Use it for”.',
          },
          {
            name: 'size',
            type: "'md' | 'sm'",
            default: "'md'",
            description: '40px or 32px tall.',
          },
          { name: 'block', type: 'boolean', description: 'Full width.' },
          {
            name: 'href',
            type: 'string',
            description: 'Renders an a.btn link instead of a button.',
          },
          {
            name: 'type',
            type: "'button' | 'submit' | 'reset'",
            default: "'button'",
            description: 'Button type. Ignored with href.',
          },
          {
            name: 'name / value',
            type: 'string',
            description: 'Submitted pair, for one-click choices.',
          },
          {
            name: 'form / formaction / formmethod',
            type: 'string',
            description: 'Submit another form, or override its action and method.',
          },
          {
            name: 'formnovalidate',
            type: 'boolean',
            description:
              'Submit without constraint validation (secondary submits). Ignored with href.',
          },
          {
            name: 'command / commandfor',
            type: "'show-modal' | 'close' | … / string",
            description: 'Invoker commands: open or close a dialog without JavaScript.',
          },
          { name: 'popovertarget', type: 'string', description: 'Popover invoker (menus).' },
          {
            name: 'disabled',
            type: 'boolean',
            description: 'disabled on a button; a link drops href and gets aria-disabled.',
          },
          { name: 'plus', type: 'boolean', description: 'Leading “+” for create actions.' },
          { name: 'icon', type: 'IconName', description: 'Leading decorative icon.' },
          {
            name: 'srSuffix',
            type: 'string',
            description:
              'Hidden suffix that names the object of a row action ("acme/api → Slack"). The space before it is added.',
          },
          { name: 'id', type: 'string', description: 'Element id.' },
          {
            name: 'describedBy',
            type: 'string',
            description: 'aria-describedby: ids of a hint about the action.',
          },
          CLASS_PROP,
          { name: 'children', type: 'Child', required: true, description: 'The label.' },
        ],
      },
      {
        component: 'ButtonRow',
        props: [
          {
            name: 'id',
            type: 'string',
            description: 'Element id, for aria-describedby or a link to the row.',
          },
          CLASS_PROP,
          {
            name: 'children',
            type: 'Child',
            required: true,
            description: 'Buttons, links and one-button forms.',
          },
        ],
      },
      {
        component: 'LinkAction',
        props: [
          { name: 'href', type: 'string', required: true, description: 'Where it goes.' },
          { name: 'arrow', type: 'boolean', description: 'Trailing decorative “→”.' },
          {
            name: 'srSuffix',
            type: 'string',
            description: 'Hidden suffix naming the object ("for OpenAI"). The space is added.',
          },
          CLASS_PROP,
          { name: 'children', type: 'Child', required: true, description: 'The label.' },
        ],
      },
    ],
    accessibility: [
      'A button defaults to type="button", so it never submits a form by accident.',
      'formnovalidate lets a secondary submit through an incomplete form; the primary submit keeps the browser’s validation and the server validates every submit.',
      'Focus shows a 3px accent ring with a 2px offset on every variant.',
      'The plus sign and icons are aria-hidden; the label is the accessible name, and srSuffix adds the object for screen readers.',
      'A disabled link has no href, so it is not focusable; a disabled button keeps its label. Tell the reader why with AskSomeone or a hint.',
      'Targets are 40px (32px small) tall, above the 24px minimum.',
    ],
    do: [
      'Name the outcome: “Give access”, “Replace secret”, “Delete Slack…”.',
      'End the label of a button that opens a confirm dialog with “…”.',
      'Use a link (href) for navigation and a button for actions that change something.',
    ],
    dont: [
      'Do not put two primary buttons in one header or form.',
      'Do not use danger-solid outside a confirm dialog.',
      'Do not make icon-only buttons, or labels like “OK”, “Submit” or “Click here”.',
    ],
    classes: [
      'btn',
      'primary',
      'secondary',
      'ghost',
      'danger',
      'danger-solid',
      'sm',
      'block',
      'plus',
      'btn-row',
      'linkish',
      'vh',
    ],
  },

  // ----- Badge ----------------------------------------------------------------------------------
  {
    slug: 'badge',
    name: 'Badge',
    summary:
      'A 22px label for a status or a fact; status badges come from the vocabulary, with a decorative glyph.',
    usage: {
      when: [
        'The status of an object in a page header, a card or a table cell: “✓ Active”.',
        'A label that is a fact about an item: “Most used”, “Owner”, “You”.',
      ],
      whenNot: [
        <>
          A status in a dense table row: use <code>Status</code> (dot + text).
        </>,
        <>
          A risk on an option: use <code>RiskTag</code>.
        </>,
        'An action: badges are not links or buttons.',
      ],
    },
    examples: [
      {
        title: 'Status vocabulary',
        description:
          'status sets the tone, the glyph and the word. Children replace the word when it carries a fact.',
        render: () => (
          <>
            <Badge status="active" />
            <Badge status="expiring">Expires in 6 days</Badge>
            <Badge status="expired" />
            <Badge status="risk-accepted" />
            <Badge status="pending" />
            <Badge status="disabled" />
            <Badge status="no-secret" />
          </>
        ),
        code: `<Badge status="active" />
<Badge status="expiring">Expires in 6 days</Badge>
<Badge status="expired" />
<Badge status="risk-accepted" />
<Badge status="pending" />
<Badge status="disabled" />
<Badge status="no-secret" />`,
      },
      {
        title: 'Tones',
        description: 'Every tone by hand, for a status outside the vocabulary.',
        render: () => (
          <>
            <Badge tone="ok" glyph="✓">
              Passed
            </Badge>
            <Badge tone="warn" glyph="⚠">
              Errors
            </Badge>
            <Badge tone="bad" glyph="✕">
              Denied
            </Badge>
            <Badge tone="pending" glyph="◐">
              Invited
            </Badge>
            <Badge tone="info">Note</Badge>
            <Badge tone="off" glyph="⏸">
              Paused
            </Badge>
          </>
        ),
        code: `<Badge tone="ok" glyph="✓">Passed</Badge>
<Badge tone="warn" glyph="⚠">Errors</Badge>
<Badge tone="bad" glyph="✕">Denied</Badge>
<Badge tone="pending" glyph="◐">Invited</Badge>
<Badge tone="info">Note</Badge>
<Badge tone="off" glyph="⏸">Paused</Badge>`,
      },
      {
        title: 'Labels',
        description:
          'Neutral (default), accent and outline badges carry facts, not status. The accent tone is a stronger neutral: a label is not an action, so it never takes the petrol accent.',
        render: () => (
          <>
            <Badge>Owner</Badge>
            <Badge tone="accent">Most used</Badge>
            <Badge tone="outline">You</Badge>
          </>
        ),
        code: `<Badge>Owner</Badge>
<Badge tone="accent">Most used</Badge>
<Badge tone="outline">You</Badge>`,
      },
    ],
    props: [
      {
        component: 'Badge',
        props: [
          {
            name: 'status',
            type: STATUS_TYPE,
            description: 'A meaning from the status vocabulary: tone, glyph and default word.',
          },
          {
            name: 'tone',
            type: "'ok' | 'warn' | 'bad' | 'info' | 'pending' | 'off' | 'accent' | 'outline' | 'neutral'",
            default: "'neutral'",
            description: 'Color of the badge; overrides the status tone.',
          },
          {
            name: 'glyph',
            type: 'string',
            description: 'Leading glyph (✓ ⌛ ✕ ◐ ⏸ ⚠ –). Rendered with aria-hidden.',
          },
          CLASS_PROP,
          {
            name: 'children',
            type: 'Child',
            description: 'The word. Required without status.',
          },
        ],
      },
    ],
    accessibility: [
      'The glyph is hidden from assistive tech; the word is read.',
      'Text and background meet 4.5:1 in both schemes; forced colors add a border.',
    ],
    do: [
      'Use the exact words of the status vocabulary; add the fact in the word (“Expires in 6 days”).',
      'Put the badge next to the name it describes, inside the heading when it is the status of the page object.',
    ],
    dont: [
      'Do not use a badge without a word, or a color without a word.',
      'Do not make a badge clickable.',
    ],
    classes: ['badge', 'ok', 'warn', 'bad', 'info', 'pending', 'off', 'accent', 'outline'],
  },

  // ----- Status ---------------------------------------------------------------------------------
  {
    slug: 'status',
    name: 'Status',
    related: ['Dot', 'RiskTag'],
    summary:
      'Dot + text, the status form for dense rows; a bare decorative dot; and the warn risk tag.',
    usage: {
      when: [
        'The status column of a table with 44px or 36px rows, or a list next to an arrow row.',
        <>
          <code>Dot</code>: before text that already says the status, such as the health line.
        </>,
        <>
          <code>RiskTag</code>: on a radio card or row whose option is risky (“⚠ Risk”).
        </>,
      ],
      whenNot: [
        <>
          The status of the page object: use <code>Badge</code>.
        </>,
        'A dot without words.',
      ],
    },
    examples: [
      {
        title: 'Dot + text',
        render: () => (
          <>
            <Status status="active" />
            <Status tone="warn">Expires in 9 days</Status>
            <Status tone="bad">Denied</Status>
            <Status tone="info">Note</Status>
            <Status status="pending" />
            <Status status="disabled" />
          </>
        ),
        code: `<Status status="active" />
<Status tone="warn">Expires in 9 days</Status>
<Status tone="bad">Denied</Status>
<Status tone="info">Note</Status>
<Status status="pending" />
<Status status="disabled" />`,
      },
      {
        title: 'Bare dots',
        description: 'Decorative: the text next to the dot carries the meaning.',
        render: () => (
          <>
            <span class="dx-row">
              <Dot tone="warn" />3 warnings to review
            </span>
            <span class="dx-row">
              <Dot />
              <Dot tone="warn" />
              <Dot tone="bad" />
              <Dot tone="info" />
              <Dot tone="pending" />
              <Dot tone="off" />
            </span>
          </>
        ),
        code: `<span><Dot tone="warn" />3 warnings to review</span>
<Dot /> <Dot tone="warn" /> <Dot tone="bad" /> <Dot tone="info" /> <Dot tone="pending" /> <Dot tone="off" />`,
      },
      {
        title: 'Risk tag',
        render: () => (
          <>
            <RiskTag />
            <RiskTag>Any branch</RiskTag>
          </>
        ),
        code: `<RiskTag />
<RiskTag>Any branch</RiskTag>`,
      },
    ],
    props: [
      {
        component: 'Status',
        props: [
          {
            name: 'status',
            type: STATUS_TYPE,
            description: 'A meaning from the vocabulary: tone and default word.',
          },
          { name: 'tone', type: TONE_TYPE, default: "'ok'", description: 'Dot color.' },
          CLASS_PROP,
          { name: 'children', type: 'Child', description: 'The word. Required without status.' },
        ],
      },
      {
        component: 'Dot',
        props: [
          { name: 'tone', type: TONE_TYPE, default: "'ok'", description: 'Dot color.' },
          CLASS_PROP,
        ],
      },
      {
        component: 'RiskTag',
        props: [
          CLASS_PROP,
          { name: 'children', type: 'Child', default: "'Risk'", description: 'The word.' },
        ],
      },
    ],
    accessibility: [
      'Status draws its dot with CSS; only the word is in the accessibility tree.',
      'Dot is aria-hidden. Dots meet 3:1 against the surfaces; off is a hollow ring, so it differs by shape, not only color.',
      'In forced colors the dots keep their color (forced-color-adjust: none).',
    ],
    do: ['Use the same word as the badge for the same status.'],
    dont: ['Do not use a dot alone to show status.', 'Do not mix badges and dots in one column.'],
    classes: ['st', 'dot', 'ok', 'warn', 'bad', 'info', 'pending', 'off', 'risktag'],
  },

  // ----- Chip -----------------------------------------------------------------------------------
  {
    slug: 'chip',
    name: 'Chip',
    related: ['Chips'],
    summary:
      'A relationship chip: the logo and name of a related object, a count and a status glyph, linking to the relation.',
    usage: {
      when: [
        'The tokens a credential access rule can use, or the credential access rules of a token, in a table cell or a rail.',
        'A short related value without a logo (a text chip): “acme/api · env production”.',
      ],
      whenNot: [
        <>
          A status: use <code>Badge</code> or <code>Status</code>.
        </>,
        'An active filter: use the filter chips of the forms group.',
      ],
    },
    examples: [
      {
        title: 'States',
        description:
          'Active, expiring (glyph only), expired (warn chip) and inactive (dashed, dimmed logo). The hidden srSuffix says the status in words.',
        render: () => (
          <Chips label="Can use" more={{ href: '#', label: '+1 more' }}>
            <Chip href="#" logo="slack" count={2} srSuffix=": 2 accesses, active. Open.">
              Slack
            </Chip>
            <Chip
              href="#"
              logo="openai"
              count={1}
              glyph="⌛"
              glyphTone="warn"
              srSuffix=": secret expires in 6 days. Open."
            >
              OpenAI
            </Chip>
            <Chip
              href="#"
              logo="anthropic"
              tone="warn"
              count={2}
              glyph="✕"
              srSuffix=": 1 expired. Open."
            >
              Anthropic
            </Chip>
            <Chip
              href="#"
              logo="slack"
              tone="off"
              count={1}
              glyph="⚠"
              srSuffix=": inactive, credential disabled. Open."
            >
              Slack (legacy)
            </Chip>
          </Chips>
        ),
        code: `<Chips label="Can use" more={{ href: '/admin/issuer-access-rules?consumer=gha-acme', label: '+1 more' }}>
  <Chip href="/admin/issuer-access-rules?…" logo="slack" count={2} srSuffix=": 2 accesses, active. Open.">Slack</Chip>
  <Chip href="…" logo="openai" count={1} glyph="⌛" glyphTone="warn" srSuffix=": secret expires in 6 days. Open.">OpenAI</Chip>
  <Chip href="…" logo="anthropic" tone="warn" count={2} glyph="✕" srSuffix=": 1 expired. Open.">Anthropic</Chip>
  <Chip href="…" logo="slack" tone="off" count={1} glyph="⚠" srSuffix=": inactive, credential disabled. Open.">Slack (legacy)</Chip>
</Chips>`,
      },
      {
        title: 'Text chips and consumers',
        render: () => (
          <Chips>
            <Chip href="#">
              <Mono>acme/api</Mono> · env production
            </Chip>
            <Chip href="#" logo="github" count={4}>
              GitHub Actions (acme)
            </Chip>
            <Chip href="#" logo="gitlab">
              GitLab CI (acme-group)
            </Chip>
            <Chip href="#" logo="buildkite" tone="bad" glyph="✕" srSuffix=": access expired">
              Buildkite (acme)
            </Chip>
          </Chips>
        ),
        code: `<Chips>
  <Chip href="…"><Mono>acme/api</Mono> · env production</Chip>
  <Chip href="…" logo="github" count={4}>GitHub Actions (acme)</Chip>
  <Chip href="…" logo="gitlab">GitLab CI (acme-group)</Chip>
  <Chip href="…" logo="buildkite" tone="bad" glyph="✕" srSuffix=": access expired">Buildkite (acme)</Chip>
</Chips>`,
      },
    ],
    props: [
      {
        component: 'Chip',
        props: [
          { name: 'href', type: 'string', description: 'Link to the relation; a span without.' },
          {
            name: 'logo',
            type: 'LogoSpec',
            description: '18px brand tile; without it the chip is a text chip.',
          },
          {
            name: 'tone',
            type: "'warn' | 'bad' | 'off'",
            description: 'warn / bad tint the glyph; off is dashed with a dimmed logo.',
          },
          { name: 'count', type: 'number | string', description: 'Count after the name.' },
          { name: 'glyph', type: 'string', description: 'Trailing decorative status glyph.' },
          {
            name: 'glyphTone',
            type: "'ok' | 'warn' | 'bad'",
            description: 'Tints only the glyph of an active chip.',
          },
          {
            name: 'srSuffix',
            type: 'string',
            description:
              'Hidden rest of the sentence: the status in words and the action. A space is added before it, none before punctuation.',
          },
          CLASS_PROP,
          { name: 'children', type: 'Child', required: true, description: 'The name.' },
        ],
      },
      {
        component: 'Chips',
        props: [
          {
            name: 'label',
            type: 'string',
            description: 'Accessible name of the group (“Can use”): role="group" and aria-label.',
          },
          {
            name: 'more',
            type: '{ href: string; label: string }',
            description: 'Trailing “+N more” link to the full list.',
          },
          CLASS_PROP,
          { name: 'children', type: 'Child', required: true, description: 'The chips.' },
        ],
      },
    ],
    accessibility: [
      'The logo and the glyph are aria-hidden; give an srSuffix whenever a glyph or tone shows a status, so the link reads as a sentence.',
      'Give Chips a label when the row has no visible heading: it becomes a named group (“Can use”), so screen readers say what the chips are.',
      'The inactive chip differs by its dashed border, not only by color.',
      'Chips are at least 28px tall with 6px gaps.',
    ],
    do: ['Link the chip to the relation it shows (the access list, filtered).'],
    dont: [
      'Do not show more than a few chips in a cell: end with “+N more”.',
      'Do not rely on the glyph color alone.',
    ],
    classes: ['chips', 'chip', 'warn', 'bad', 'off', 'text', 'n', 'g', 't-warn', 'more-link'],
  },

  // ----- Logo -----------------------------------------------------------------------------------
  {
    slug: 'logo',
    name: 'Logo',
    related: ['LogoStack'],
    summary:
      'A brand tile for an upstream service or a CI system, in four sizes; and overlapping tiles with a count.',
    usage: {
      when: [
        'Before the name of a token or a credential access rule: table rows, page identity, map nodes, chips.',
        <>
          <code>LogoStack</code>: “Used by” cells and summaries (“2 consumers”).
        </>,
      ],
      whenNot: [
        'Instead of the name: the tile is a logotype, the name is always next to it.',
        <>
          A person: use <code>Avatar</code>.
        </>,
      ],
    },
    examples: [
      {
        title: 'Brands',
        description: 'Letters in the brand color; OIDC is a key, a custom upstream is </>.',
        render: () => (
          <>
            {BRANDS.map((brand) => (
              <span class="dx-row">
                <Logo brand={brand} />
                {LOGO_BRANDS[brand].name}
              </span>
            ))}
          </>
        ),
        code: BRANDS.map((brand) => `<Logo brand="${brand}" />`).join('\n'),
      },
      {
        title: 'Sizes',
        description:
          'xs 18 (chips), sm 24 (fixed bar), md 32 (default, rows), lg 40 (page identity).',
        render: () => (
          <>
            <Logo brand="github" size="xs" />
            <Logo brand="gitlab" size="sm" />
            <Logo brand="buildkite" />
            <Logo brand="discord" size="lg" />
          </>
        ),
        code: `<Logo brand="github" size="xs" />
<Logo brand="gitlab" size="sm" />
<Logo brand="buildkite" />
<Logo brand="discord" size="lg" />`,
      },
      {
        title: 'Disabled and custom letters',
        description: 'A disabled token dims its tile; say “Disabled” in words next to it.',
        render: () => (
          <>
            <span class="dx-row">
              <Logo brand="slack" disabled />
              Slack (legacy) <Badge status="disabled" />
            </span>
            <span class="dx-row">
              <Logo brand="custom">AC</Logo>
              Acme CRM
            </span>
          </>
        ),
        code: `<Logo brand="slack" disabled /> Slack (legacy) <Badge status="disabled" />
<Logo brand="custom">AC</Logo> Acme CRM`,
      },
      {
        title: 'Logo stack',
        render: () => (
          <>
            <LogoStack brands={['github', 'gitlab']}>2 consumers</LogoStack>
            <LogoStack brands={['slack', 'openai', 'anthropic', 'github']}>4 tokens</LogoStack>
          </>
        ),
        code: `<LogoStack brands={['github', 'gitlab']}>2 consumers</LogoStack>
<LogoStack brands={['slack', 'openai', 'anthropic', 'github']}>4 tokens</LogoStack>`,
      },
      {
        title: 'Logo stack: a disabled credential access rule’s tile',
        description:
          'Each entry is a LogoSpec, so a disabled object gets a dimmed tile and a custom upstream its own letters.',
        render: () => (
          <LogoStack
            brands={[
              'github',
              { brand: 'buildkite', disabled: true },
              { brand: 'custom', text: 'AC' },
            ]}
          >
            3 consumers, 1 disabled
          </LogoStack>
        ),
        code: `<LogoStack brands={['github', { brand: 'buildkite', disabled: true }, { brand: 'custom', text: 'AC' }]}>
  3 consumers, 1 disabled
</LogoStack>`,
      },
      {
        title: 'Logo stack: tiles only',
        description:
          'Without a count the whole stack is aria-hidden: a decorative logo next to a name, such as the logoSlot of an Entity (data group).',
        render: () => (
          <span class="dx-row">
            <LogoStack brands={['slack', 'openai']} />
            Slack and OpenAI
          </span>
        ),
        code: `<Entity logoSlot={<LogoStack brands={['slack', 'openai']} />} name="Slack and OpenAI" />`,
      },
    ],
    props: [
      {
        component: 'Logo',
        props: [
          {
            name: 'brand',
            type: BRANDS.map((brand) => `'${brand}'`).join(' | '),
            required: true,
            description: 'Which brand tile.',
          },
          {
            name: 'size',
            type: "'xs' | 'sm' | 'md' | 'lg'",
            default: "'md'",
            description: '18, 24, 32 or 40px.',
          },
          { name: 'disabled', type: 'boolean', description: 'Dimmed, grayscale tile.' },
          {
            name: 'label',
            type: 'string',
            description: 'Accessible name, only when the tile stands alone.',
          },
          CLASS_PROP,
          { name: 'children', type: 'Child', description: 'Letters instead of the brand’s.' },
          {
            name: 'cssLetters',
            type: 'boolean',
            description:
              'Letters drawn by CSS (data-l): the tile adds no text, as in a select option.',
          },
        ],
      },
      {
        component: 'LogoStack',
        props: [
          {
            name: 'brands',
            type: 'readonly LogoSpec[]',
            required: true,
            description: 'The overlapping 24px tiles, in order; a disabled spec dims its tile.',
          },
          CLASS_PROP,
          {
            name: 'children',
            type: 'Child',
            description:
              'The count in words. Required unless the stack is decorative next to a name; without it the stack is aria-hidden.',
          },
        ],
      },
    ],
    accessibility: [
      'Tiles are aria-hidden by default: the service name next to them is the text. label makes a standalone tile a named image.',
      'A LogoStack without a count is aria-hidden as a whole: put it only next to a name that says the same.',
      'The tile letters are part of a logotype, so they are outside the text contrast rule; the name next to them meets 4.5:1.',
      'Disabled is said in words; the dimmed tile only adds to it.',
    ],
    do: ['Use the same brand tile for a service everywhere it appears.'],
    dont: [
      'Do not load brand images from another origin: tiles are CSS and text.',
      'Do not use a tile as the only label of a link or button.',
    ],
    classes: [
      'logo',
      'xs',
      'sm',
      'lg',
      'dis',
      ...BRANDS.map((brand) => `lg-${brand}`),
      'lstack',
      'tiles',
    ],
  },

  // ----- Icon -----------------------------------------------------------------------------------
  {
    slug: 'icon',
    name: 'Icon',
    summary:
      'A 16px outline icon from the inline-SVG set, drawn in the current text color; decorative by default.',
    usage: {
      when: [
        'Sidebar sections, the leading icon of a button, empty-state glyphs, system avatars.',
        'Any place the design shows an icon: always one of this set, so they match.',
      ],
      whenNot: [
        'A status: status glyphs (✓ ⌛ ✕ ⚠ ◐ ⏸) are text, in badges and callouts.',
        'An icon-only button.',
        <>
          A brand: use <code>Logo</code>.
        </>,
      ],
    },
    examples: [
      {
        title: 'The set',
        description: `${ICON_NAMES.length} icons, 24×24 grid, stroke 1.6, round caps and joins, no fills.`,
        render: () => (
          <>
            {ICON_NAMES.map((name) => (
              <span class="chip text">
                <Icon name={name} />
                {name}
              </span>
            ))}
          </>
        ),
        code: ICON_NAMES.map((name) => `<Icon name="${name}" />`).join('\n'),
      },
      {
        title: 'In context',
        description: 'The icon takes the color of its text, so it follows the scheme and states.',
        render: () => (
          <>
            <a class="nav-item" href="#">
              <Icon name="token" />
              Credentials
            </a>
            <Button icon="search">Find a request</Button>
            <Avatar variant="sys">
              <Icon name="system" />
            </Avatar>
            <span class="t-warn dx-row">
              <Icon name="monitoring" />
              Errors in the last hour
            </span>
          </>
        ),
        code: `<a class="nav-item" href="/admin/credentials"><Icon name="token" />Credentials</a>
<Button icon="search">Find a request</Button>
<Avatar variant="sys"><Icon name="system" /></Avatar>
<span class="t-warn"><Icon name="monitoring" />Errors in the last hour</span>`,
      },
      {
        title: 'Named icon',
        description:
          'Rare: when the icon stands for a word that is not next to it, label makes it role="img" with that name.',
        render: () => <Icon name="gate" label="Checked by tokengate" />,
        code: `<Icon name="gate" label="Checked by tokengate" />`,
      },
    ],
    props: [
      {
        component: 'Icon',
        props: [
          {
            name: 'name',
            type: 'IconName',
            required: true,
            description: (
              <>
                One of: <code>{ICON_NAMES.join(', ')}</code>.
              </>
            ),
          },
          {
            name: 'label',
            type: 'string',
            description: 'Accessible name; without it the icon is aria-hidden.',
          },
          CLASS_PROP,
        ],
      },
    ],
    accessibility: [
      'aria-hidden by default: the word next to it carries the meaning.',
      'Stroke is currentColor, so the icon has the contrast of its text and follows forced colors.',
      'Inline SVG with no sprite and no external file: nothing for the CSP to block.',
    ],
    do: [
      'Add an icon to the set (Icon.tsx) instead of pasting an SVG into a page.',
      'Keep new icons on the 24px grid with stroke 1.6 and no fills.',
    ],
    dont: [
      'Do not use an icon without a word next to it.',
      'Do not color an icon on its own: it takes the text color.',
    ],
    classes: ['ic'],
  },

  // ----- IDs ------------------------------------------------------------------------------------
  {
    slug: 'id-chip',
    name: 'IdChip',
    related: ['Slug', 'Mono'],
    summary:
      'Machine values: the full object ID in a selectable chip, the slug next to a name, and mono text inline.',
    usage: {
      when: [
        'IdChip: the ID of the page object in its identity row, and IDs in the right rail.',
        'Slug: the path segment of a token or consumer, after its name.',
        'Mono: a repository, a path or a claim inside running text.',
      ],
      whenNot: [
        <>
          A snippet to copy: use <code>CodeBlock</code>.
        </>,
        <>
          A secret: use <code>Mask</code>.
        </>,
      ],
    },
    examples: [
      {
        title: 'Identity row',
        description: 'Type → slug → ID chip → facts.',
        render: () => (
          <div class="ident-meta">
            <span>Slack Web API</span>
            <Slug>slack</Slug>
            <IdChip kind="Credential">svc_01JB8Y2K4M6P8R0T2V4X6Z8A1C</IdChip>
            <span>Created 3 Oct 2026</span>
          </div>
        ),
        code: `<span>Slack Web API</span>
<Slug>slack</Slug>
<IdChip kind="Credential">svc_01JB8Y2K4M6P8R0T2V4X6Z8A1C</IdChip>
<span>Created 3 Oct 2026</span>`,
      },
      {
        title: 'IDs and slugs',
        render: () => (
          <>
            <IdChip kind="Request">req_01JB8Z5K2Q7W3N4M6P8R9T0V1X</IdChip>
            <IdChip kind="Credential access rule">csm_01JB8X4F6H8K0M2P4R6T8V0X2Z</IdChip>
            <Slug>slack-legacy</Slug>
            <Slug>gha-acme</Slug>
          </>
        ),
        code: `<IdChip kind="Request">req_01JB8Z5K2Q7W3N4M6P8R9T0V1X</IdChip>
<IdChip kind="Credential access rule">csm_01JB8X4F6H8K0M2P4R6T8V0X2Z</IdChip>
<Slug>slack-legacy</Slug>
<Slug>gha-acme</Slug>`,
      },
      {
        title: 'Mono in text',
        render: () => (
          <p>
            Jobs of <Mono>acme/api</Mono> on <Mono>refs/heads/main</Mono> call{' '}
            <Mono>gate.acme.dev/proxy/slack</Mono>.
          </p>
        ),
        code: `<p>Jobs of <Mono>acme/api</Mono> on <Mono>refs/heads/main</Mono> call <Mono>gate.acme.dev/proxy/slack</Mono>.</p>`,
      },
    ],
    props: [
      {
        component: 'IdChip',
        props: [
          {
            name: 'kind',
            type: 'string',
            description: 'What it identifies; the tooltip reads “<kind> ID”.',
          },
          CLASS_PROP,
          { name: 'children', type: 'string', required: true, description: 'The full ID.' },
        ],
      },
      {
        component: 'Slug',
        props: [
          CLASS_PROP,
          { name: 'children', type: 'string', required: true, description: 'The slug.' },
        ],
      },
      {
        component: 'Mono',
        props: [
          CLASS_PROP,
          { name: 'children', type: 'Child', required: true, description: 'The value.' },
        ],
      },
    ],
    accessibility: [
      'The full ID is in the text, so screen readers and copy get all of it; CSS only ends it with an ellipsis when it does not fit.',
      'One click selects the whole ID (user-select: all): no copy button, no JavaScript.',
      'ID chip text (12px, text-2 on surface-2) meets 4.5:1 in both schemes.',
    ],
    do: ['Show the full ID; let CSS shorten it.'],
    dont: [
      'Do not shorten an ID by hand (svc_01JB…): it can no longer be copied or searched.',
      'Do not use IdChip for secrets.',
    ],
    classes: ['idchip', 'slug', 'mono', 'ident-meta'],
  },

  // ----- Mask -----------------------------------------------------------------------------------
  {
    slug: 'mask',
    name: 'Mask',
    summary:
      'A masked secret, “•••• 9fQa”: the last 4 characters tell two secrets apart; the secret is never shown.',
    usage: {
      when: [
        'The secret block of a token page (lg), and a secret in a table or rail (default).',
        'Before/after in the audit log of a secret replacement.',
      ],
      whenNot: [
        'Any value the reader needs to copy: a secret is never revealed or copied in the UI.',
      ],
    },
    examples: [
      {
        title: 'Sizes',
        render: () => (
          <>
            <Mask last4="9fQa" />
            <Mask last4="9fQa" size="lg" />
          </>
        ),
        code: `<Mask last4="9fQa" />
<Mask last4="9fQa" size="lg" />`,
      },
      {
        title: 'Only the last 4',
        description:
          'Whatever is passed, only the last 4 characters are rendered, so a full secret never reaches the page by mistake.',
        render: () => (
          <>
            <Mask last4="xoxb-0000-0000-7Rk2" />
            <Mask last4="r2Xw" srPrefix="Old secret ending in" />
          </>
        ),
        code: `<Mask last4={token.secretLast4} />
<Mask last4="r2Xw" srPrefix="Old secret ending in" />`,
      },
      {
        title: 'Short secret',
        description:
          'tokengate keeps no last characters of a secret under 20 characters. Without last4 the mask shows only the dots and screen readers hear “Secret, last characters not stored”. Never pass a placeholder such as ????.',
        render: () => (
          <>
            <Mask />
            <Mask size="lg" />
          </>
        ),
        code: `<Mask last4={token.secretLast4} /> {/* undefined for a short secret */}
<Mask size="lg" />`,
      },
    ],
    props: [
      {
        component: 'Mask',
        props: [
          {
            name: 'last4',
            type: 'string',
            description:
              'The stored last characters; only the last 4 render. Missing or empty: “not stored”, dots only.',
          },
          {
            name: 'size',
            type: "'md' | 'lg'",
            default: "'md'",
            description: '24px, or 36px with 16px type.',
          },
          {
            name: 'srPrefix',
            type: 'string',
            default: "'Secret ending in'",
            description:
              'Screen-reader text before the characters. The space is added. Not used without last4.',
          },
          CLASS_PROP,
        ],
      },
    ],
    accessibility: [
      'The dots are aria-hidden; screen readers hear “Secret ending in 9fQa”, or “Secret, last characters not stored” without last4.',
      'Mono type and a border tell it apart from an ID chip.',
    ],
    do: ['Pair it with the facts (added, expires) and the Replace secret and Test actions.'],
    dont: ['Do not add Reveal or Copy: there are none, by design.'],
    classes: ['mask', 'lg', 'vh'],
  },

  // ----- Kbd ------------------------------------------------------------------------------------
  {
    slug: 'kbd',
    name: 'Kbd',
    summary: 'A key on the keyboard, for instructions in text.',
    usage: {
      when: ['Instructions that name a key: “Press Esc to close the dialog.”'],
      whenNot: ['Keyboard shortcuts: there are none, because there is no client JavaScript.'],
    },
    examples: [
      {
        title: 'Keys in text',
        render: () => (
          <p>
            Press <Kbd>Esc</Kbd> to close the dialog, or <Kbd>Tab</Kbd> to move to Cancel.
          </p>
        ),
        code: `<p>Press <Kbd>Esc</Kbd> to close the dialog, or <Kbd>Tab</Kbd> to move to Cancel.</p>`,
      },
    ],
    props: [
      {
        component: 'Kbd',
        props: [
          CLASS_PROP,
          { name: 'children', type: 'Child', required: true, description: 'The key name.' },
        ],
      },
    ],
    accessibility: [
      'A real kbd element; screen readers read the key name.',
      'Write the key as a word (“Esc”, “Enter”), not only a symbol.',
    ],
    do: ['Use the name printed on the key.'],
    dont: ['Do not style other text as keys.'],
    classes: ['kbd'],
  },

  // ----- Avatar ---------------------------------------------------------------------------------
  {
    slug: 'avatar',
    name: 'Avatar',
    summary:
      'Initials in a circle for a person, a dashed ring for a pending person, a tile for a system actor.',
    usage: {
      when: [
        'Before the name of a person in the people list, the activity feed and the account menu.',
        'A system actor (the hourly job) in the feed: sys with an icon.',
      ],
      whenNot: [
        <>
          A service or CI system: use <code>Logo</code>.
        </>,
      ],
    },
    examples: [
      {
        title: 'Sizes and states',
        description: 'sm 28 (default), md 32, lg 40; pending is dashed; sys is a square tile.',
        render: () => (
          <>
            <Avatar name="Maya Chen" />
            <Avatar name="Diego Ruiz" size="md" />
            <Avatar name="Priya Natarajan" size="lg" />
            <Avatar name="Sam Ito" size="md" variant="pending" />
            <Avatar variant="sys">
              <Icon name="system" />
            </Avatar>
          </>
        ),
        code: `<Avatar name="Maya Chen" />
<Avatar name="Diego Ruiz" size="md" />
<Avatar name="Priya Natarajan" size="lg" />
<Avatar name="Sam Ito" size="md" variant="pending" />
<Avatar variant="sys"><Icon name="system" /></Avatar>`,
      },
      {
        title: 'Next to the name',
        render: () => (
          <span class="dx-row">
            <Avatar name="Sam Ito" size="md" variant="pending" />
            Sam Ito <Badge status="pending" />
          </span>
        ),
        code: `<Avatar name="Sam Ito" size="md" variant="pending" /> Sam Ito <Badge status="pending" />`,
      },
    ],
    props: [
      {
        component: 'Avatar',
        props: [
          { name: 'name', type: 'string', description: 'The initials come from it.' },
          {
            name: 'initials',
            type: 'string',
            description: 'Initials instead of the computed ones.',
          },
          {
            name: 'size',
            type: "'sm' | 'md' | 'lg'",
            default: "'sm'",
            description: '28, 32 or 40px.',
          },
          {
            name: 'variant',
            type: "'pending' | 'sys'",
            description: 'Dashed ring, or a square tile for system actors.',
          },
          CLASS_PROP,
          { name: 'children', type: 'Child', description: 'An icon instead of initials.' },
        ],
      },
    ],
    accessibility: [
      'aria-hidden: the name is always next to it.',
      'Pending is a dashed ring and a “Pending approval” badge, not a color.',
    ],
    do: ['Pass the name; the initials follow it.'],
    dont: ['Do not load photos: nothing comes from another origin.'],
    classes: ['avatar', 'md', 'lg', 'pending', 'sys'],
  },

  // ----- Callout --------------------------------------------------------------------------------
  {
    slug: 'callout',
    name: 'Callout',
    related: ['Notice'],
    summary:
      'A tinted block with a glyph, a bold first sentence, a second line and one action; Notice is the one shown after an action.',
    usage: {
      when: [
        'A state of the page the reader should know about: an expiring secret, a single owner.',
        <>
          <code>Notice</code>: the result of an action, under the header after the redirect (“Access
          given.”). It replaces toasts.
        </>,
      ],
      whenNot: [
        'An error-level problem of the whole install: use the health strip (layout group).',
        'A field error: use the field error of the forms group.',
        <>
          A missing permission: use <code>AskSomeone</code>.
        </>,
      ],
    },
    examples: [
      {
        title: 'Tones',
        layout: 'stack',
        render: () => (
          <>
            <Callout
              title="Only one active owner."
              actions={
                <Button size="sm" href="#">
                  Invite
                </Button>
              }
            >
              Invite a second owner so the deployment stays manageable if that account is lost.
            </Callout>
            <Callout
              tone="warn"
              glyph="⌛"
              title="The secret of OpenAI expires on 21 Oct 2026 (in 6 days)."
              more="Its 1 issuer access rules stops working then."
              actions={
                <Button size="sm" href="#">
                  Replace secret
                </Button>
              }
            />
            <Callout tone="bad" title="Slack rejected the new secret.">
              <code>invalid_auth</code>: check that it starts with <code>xoxb-</code>.
            </Callout>
          </>
        ),
        code: `<Callout title="Only one active owner." actions={<Button size="sm" href="/admin/users/invite">Invite</Button>}>
  Invite a second owner so the deployment stays manageable if that account is lost.
</Callout>
<Callout tone="warn" glyph="⌛"
  title="The secret of OpenAI expires on 21 Oct 2026 (in 6 days)."
  more="Its 1 issuer access rules stops working then."
  actions={<Button size="sm" href="/admin/credentials/openai/secret">Replace secret</Button>} />
<Callout tone="bad" title="Slack rejected the new secret.">
  <code>invalid_auth</code>: check that it starts with <code>xoxb-</code>.
</Callout>`,
      },
      {
        title: 'Notice after an action',
        layout: 'stack',
        render: () => (
          <>
            <Notice
              title="Access given."
              actions={
                <Button size="sm" href="#">
                  Show the workflow snippet
                </Button>
              }
            >
              GitHub Actions (acme) › acme/api › environment production can now use Slack.
            </Notice>
            <Notice
              title="Token created."
              actions={
                <>
                  <Button size="sm" href="#">
                    Give access
                  </Button>
                  <Button size="sm" variant="ghost" href="#">
                    Undo
                  </Button>
                </>
              }
            >
              Slack is ready. Add issuer access rule next.
            </Notice>
          </>
        ),
        code: `<Notice title="Access given." actions={<Button size="sm" href="…#snippet">Show the workflow snippet</Button>}>
  GitHub Actions (acme) › acme/api › environment production can now use Slack.
</Notice>
<Notice title="Token created." actions={<>
  <Button size="sm" href="/admin/issuer-access-rules/new?token=slack">Give access</Button>
  <Button size="sm" variant="ghost" href="…">Undo</Button>
</>}>Slack is ready. Add issuer access rule next.</Notice>`,
      },
      {
        title: 'Notice focused after a redirect',
        description:
          'With autofocus the notice gets tabindex="-1" and autofocus, so focus lands on the result of the action after the redirect and shows the focus ring. On this docs page autofocus is off so the page does not jump.',
        layout: 'stack',
        render: () => (
          <Notice title="Secret replaced.">
            Slack uses the new secret now. The old one stopped working.
          </Notice>
        ),
        code: `<Notice autofocus={errors.length === 0} title="Secret replaced.">
  Slack uses the new secret now. The old one stopped working.
</Notice>`,
      },
    ],
    props: [
      {
        component: 'Callout',
        props: [
          {
            name: 'tone',
            type: "'info' | 'ok' | 'warn' | 'bad'",
            default: "'info'",
            description: 'Background, bar and glyph color.',
          },
          {
            name: 'title',
            type: 'Child',
            required: true,
            description: 'The bold first sentence: what is true.',
          },
          {
            name: 'glyph',
            type: 'string',
            description: 'Glyph instead of the tone’s (i ✓ ⚠ ✕). Decorative.',
          },
          { name: 'more', type: 'Child', description: 'Second line: the consequence.' },
          { name: 'actions', type: 'Child', description: 'One action, usually a small button.' },
          {
            name: 'role',
            type: "'status'",
            description: 'For messages that appear after an action.',
          },
          {
            name: 'autofocus',
            type: 'boolean',
            default: 'false',
            description: 'Focus it on load (tabindex="-1" autofocus).',
          },
          CLASS_PROP,
          { name: 'children', type: 'Child', description: 'The rest of the first paragraph.' },
        ],
      },
      {
        component: 'Notice',
        props: [
          {
            name: 'tone',
            type: "'info' | 'ok' | 'warn' | 'bad'",
            default: "'ok'",
            description: 'As Callout; role is always status.',
          },
          {
            name: 'title',
            type: 'Child',
            required: true,
            description: 'What happened: “Access given.”',
          },
          { name: 'glyph', type: 'string', description: 'As Callout.' },
          { name: 'more', type: 'Child', description: 'As Callout.' },
          {
            name: 'actions',
            type: 'Child',
            description: 'The next step, usually one small button.',
          },
          {
            name: 'autofocus',
            type: 'boolean',
            default: 'false',
            description: 'Focus it on load, after the redirect. Only one autofocus per page.',
          },
          CLASS_PROP,
          { name: 'children', type: 'Child', description: 'The rest of the first paragraph.' },
        ],
      },
    ],
    accessibility: [
      'Callouts are not role="alert": they describe the page and are read in order.',
      'Notice has role="status", so the result of an action is announced after the redirect.',
      'autofocus moves focus to the notice on load (tabindex="-1", no JS) and shows the 3px focus ring. Only one autofocus per page: when the page has an ErrorSummary, it takes focus instead.',
      'The glyph is aria-hidden; the bold first sentence says the state in words. Forced colors add a border.',
    ],
    do: [
      'Start with one bold sentence that says what is true, then the consequence.',
      'Offer at most one action, the one that fixes it.',
    ],
    dont: [
      'Do not stack callouts: one per page section.',
      'Do not use a callout for a field error or a missing permission.',
    ],
    classes: ['callout', 'ok', 'warn', 'bad', 'notice', 'gl', 'body', 'more', 'acts'],
  },

  // ----- AskSomeone -----------------------------------------------------------------------------
  {
    slug: 'ask-someone',
    name: 'AskSomeone',
    summary:
      'Replaces an action the reader has no permission for: why, who can do it, and how to reach them.',
    usage: {
      when: [
        'A token viewer on a page whose main action needs a credential manager.',
        'Anywhere a disabled button would otherwise appear without a reason.',
      ],
      whenNot: [
        <>
          A state of the page: use <code>Callout</code>.
        </>,
      ],
    },
    examples: [
      {
        title: 'Two people and a link',
        layout: 'stack',
        render: () => (
          <AskSomeone
            people={['Priya Natarajan', 'Diego Ruiz']}
            link={{ href: '#', label: 'Email them this page' }}
          >
            Only credential managers can add tokens.
          </AskSomeone>
        ),
        code: `<AskSomeone
  people={['Priya Natarajan', 'Diego Ruiz']}
  link={{ href: 'mailto:priya@acme.dev,diego@acme.dev?body=…', label: 'Email them this page' }}
>
  Only credential managers can add tokens.
</AskSomeone>`,
      },
      {
        title: 'One person',
        layout: 'stack',
        render: () => (
          <AskSomeone people={['Maya Chen']}>Only owners can export the configuration.</AskSomeone>
        ),
        code: `<AskSomeone people={['Maya Chen']}>Only owners can export the configuration.</AskSomeone>`,
      },
      {
        title: 'More people than named',
        description:
          'Name the first few and count the rest with more: “and 2 more”. One link reaches all of them.',
        layout: 'stack',
        render: () => (
          <AskSomeone
            people={['Maya Chen', 'Priya Natarajan', 'Diego Ruiz']}
            more={2}
            link={{ href: '#', label: 'Email them this page' }}
          >
            Only credential managers can replace secrets.
          </AskSomeone>
        ),
        code: `<AskSomeone
  people={['Maya Chen', 'Priya Natarajan', 'Diego Ruiz']}
  more={2}
  link={{ href: 'mailto:…?body=…', label: 'Email them this page' }}
>
  Only credential managers can replace secrets.
</AskSomeone>`,
      },
    ],
    props: [
      {
        component: 'AskSomeone',
        props: [
          {
            name: 'people',
            type: 'readonly string[]',
            required: true,
            description: 'Who can do it; joined as “A, B or C”.',
          },
          {
            name: 'more',
            type: 'number',
            default: '0',
            description:
              'How many more can do it, not named: “and 2 more”. Ignored without people.',
          },
          {
            name: 'link',
            type: '{ href: string; label: string }',
            description: 'How to reach them, usually a mailto link.',
          },
          CLASS_PROP,
          {
            name: 'children',
            type: 'Child',
            required: true,
            description: 'Why the reader cannot.',
          },
        ],
      },
    ],
    accessibility: [
      'A plain paragraph in reading order, where the action would be.',
      'Names are in bold text, not color; the link has a descriptive label.',
    ],
    do: ['Name real people with the needed role, owners first.'],
    dont: ['Do not show a disabled primary button instead.'],
    classes: ['ask'],
  },

  // ----- CodeBlock ------------------------------------------------------------------------------
  {
    slug: 'code-block',
    name: 'CodeBlock',
    summary: 'A snippet in mono type that scrolls on its own and selects as a whole on click.',
    usage: {
      when: [
        'A workflow or configuration snippet the reader copies.',
        'JSX or command examples in docs.',
      ],
      whenNot: [
        <>
          An ID or a short value in text: use <code>Mono</code> or <code>IdChip</code>.
        </>,
        'A secret: secrets are never shown.',
      ],
    },
    examples: [
      {
        title: 'With a caption',
        layout: 'stack',
        render: () => (
          <div>
            <CodeBlock
              label="Workflow snippet"
              caption="Add this step to .github/workflows/deploy.yml"
            >
              {`- uses: tokengate/get-token@v1
  with:
    service: slack`}
            </CodeBlock>
          </div>
        ),
        code: `<CodeBlock label="Workflow snippet" caption="Add this step to .github/workflows/deploy.yml">
  {\`- uses: tokengate/get-token@v1
  with:
    service: slack\`}
</CodeBlock>`,
      },
      {
        title: 'Comment and key tones',
        description: 'Spans with the classes c (comment) and k (key) tint parts of the code.',
        layout: 'stack',
        render: () => (
          <CodeBlock label="Annotated snippet">
            <span class="c"># call Slack through the gateway</span>
            {'\n'}
            <span class="k">url</span>
            {': https://gate.acme.dev/proxy/slack/chat.postMessage'}
          </CodeBlock>
        ),
        code: `<CodeBlock label="Annotated snippet">
  <span class="c"># call Slack through the gateway</span>{'\\n'}
  <span class="k">url</span>{': https://gate.acme.dev/proxy/slack/chat.postMessage'}
</CodeBlock>`,
      },
    ],
    props: [
      {
        component: 'CodeBlock',
        props: [
          {
            name: 'label',
            type: 'string',
            required: true,
            description: 'Accessible name of the block; it is focusable, so it needs one.',
          },
          { name: 'caption', type: 'Child', description: 'Visible line above the block.' },
          { name: 'class', type: 'string', description: 'Extra classes on the pre.' },
          {
            name: 'children',
            type: 'Child',
            required: true,
            description: 'The code. Text is escaped by the renderer.',
          },
        ],
      },
    ],
    accessibility: [
      'The block is focusable (tabindex 0) so keyboard users can scroll it, and has a name from label.',
      'Text is escaped: markup in a snippet is shown, never rendered.',
    ],
    do: ['Give every block a label that says what the snippet is for.'],
    dont: [
      'Do not put secrets or tokens in a snippet.',
      'Do not add a copy button: there is no JavaScript.',
    ],
    classes: ['code', 'code-cap', 'c', 'k'],
  },
];
