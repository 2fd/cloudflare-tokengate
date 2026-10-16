// Docs entries of the "base" group (packages/ui/src/components/base). One ComponentDoc per
// component page, in nav order. Only the base group agent edits this file.
import { Badge, CodeBlock } from '@tokengate/ui';
import type { ComponentDoc } from './types';

export const base: readonly ComponentDoc[] = [
  {
    slug: 'badge',
    name: 'Badge',
    summary: 'A 22px label for a status or a fact, with an optional decorative glyph.',
    usage: {
      when: [
        'The status of an object in a page header, a card or a radio card: “✓ Active”.',
        'A label that is a fact about an item: “Most used”, “Owner”, “You”.',
      ],
      whenNot: [
        <>
          A status in a dense table row: use the dot + text form (<code>.st</code>).
        </>,
        'An action: badges are not links or buttons.',
      ],
    },
    examples: [
      {
        title: 'Status tones',
        description: 'The status vocabulary. The word always carries the meaning.',
        render: () => (
          <>
            <Badge tone="ok" glyph="✓">
              Active
            </Badge>
            <Badge tone="warn" glyph="⌛">
              Expires in 6 days
            </Badge>
            <Badge tone="bad" glyph="✕">
              Expired
            </Badge>
            <Badge tone="info" glyph="◐">
              Pending approval
            </Badge>
            <Badge tone="off" glyph="⏸">
              Disabled
            </Badge>
          </>
        ),
        code: `<Badge tone="ok" glyph="✓">Active</Badge>
<Badge tone="warn" glyph="⌛">Expires in 6 days</Badge>
<Badge tone="bad" glyph="✕">Expired</Badge>
<Badge tone="info" glyph="◐">Pending approval</Badge>
<Badge tone="off" glyph="⏸">Disabled</Badge>`,
      },
      {
        title: 'Labels',
        description: 'Neutral (default), accent and outline badges carry facts, not status.',
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
            name: 'tone',
            type: "'ok' | 'warn' | 'bad' | 'info' | 'off' | 'accent' | 'outline' | 'neutral'",
            default: "'neutral'",
            description: 'Color of the badge. Pick it from the status vocabulary.',
          },
          {
            name: 'glyph',
            type: 'string',
            description: 'Leading glyph (✓ ⌛ ✕ ◐ ⏸ ⚠ –). Rendered with aria-hidden.',
          },
          { name: 'class', type: 'string', description: 'Extra classes on the span.' },
          { name: 'children', type: 'Child', required: true, description: 'The word.' },
        ],
      },
    ],
    accessibility: [
      'The glyph is hidden from assistive tech; the word is read.',
      'Text and background meet 4.5:1 in both schemes; forced colors add a border.',
    ],
    do: [
      'Use the exact words of the status vocabulary.',
      'Put the badge next to the name it describes, inside the heading when it is the status of the page object.',
    ],
    dont: [
      'Do not use a badge without a word, or a color without a word.',
      'Do not make a badge clickable.',
    ],
    classes: ['badge', 'ok', 'warn', 'bad', 'info', 'off', 'accent', 'outline'],
  },
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
          An ID or a short value in text: use <code>code</code> or an ID chip.
        </>,
        'A secret: secrets are never shown.',
      ],
    },
    examples: [
      {
        title: 'With a caption',
        layout: 'stack',
        render: () => (
          <CodeBlock
            label="Workflow snippet"
            caption="Add this step to .github/workflows/deploy.yml"
          >
            {`- uses: tokengate/get-token@v1
  with:
    service: slack`}
          </CodeBlock>
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
