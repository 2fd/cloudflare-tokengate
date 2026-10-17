import {
  CatalogGroup,
  Checkbox,
  Field,
  Input,
  Or,
  SubBox,
  SubmitRow,
  TypeCard,
  TypeCatalog,
} from '@tokengate/ui';
import type { ComponentDoc } from '../types';
import { logos } from './data';

export const typeCatalog: ComponentDoc = {
  slug: 'type-catalog',
  name: 'TypeCatalog',
  related: ['TypeCard', 'CatalogGroup'],
  summary:
    'An exclusive catalog of type cards: opening one closes the others and shows that type’s own form. No JS.',
  usage: {
    when: [
      'Pick a type, then fill in that type’s fields: “Which API does this token unlock?”.',
      'Each type has a different form (a bot token, a webhook URL, a base URL).',
    ],
    whenNot: [
      <>
        Types that lead to their own pages: <code>LinkCards</code>.
      </>,
      <>
        2–6 options in one form: <code>RadioCards</code>.
      </>,
    ],
  },
  examples: [
    {
      title: 'Credential types',
      description:
        'Slack is open (from the URL). Open another card and Slack closes: every card shares the name. A generic type comes after an OR.',
      layout: 'stack',
      render: () => (
        <TypeCatalog
          id="tc-types"
          title="Which API does this token unlock?"
          description="Ready-made types set the URL, how the secret is sent and the check for you."
        >
          <CatalogGroup>Chat</CatalogGroup>
          <TypeCard
            name="tc-type"
            id="tc-slack"
            logo={logos.slack}
            title="Slack Web API"
            description="slack.com/api · bot token xoxb-…"
            open
            action="?type=slack"
            method="get"
            layout="form-layout"
          >
            <div class="fields">
              <Field
                id="tc-slack-cred"
                label="Bot token"
                hint="Bot User OAuth Token from api.slack.com/apps › OAuth & Permissions. Starts with xoxb-. Only the last 4 characters are kept for display."
              >
                <Input
                  name="credential"
                  secret
                  placeholder="xoxb-0000000000-0000000000000-XXXXXXXXXXXXXXXXXXXXXXXX"
                />
              </Field>
              <Field
                id="tc-slack-name"
                label="Name"
                optional
                hint="Leave empty to use Slack 2. Consumers call /proxy/slack-2."
              >
                <Input name="name" placeholder="Slack 2" />
              </Field>
              <SubmitRow>
                <button class="btn primary" type="submit">
                  Check and save Slack
                </button>
                <a href="?help=bot-token">How to get a bot token</a>
              </SubmitRow>
            </div>
            <SubBox as="aside" labelledBy="tc-slack-next">
              <h4 id="tc-slack-next">When you save</h4>
              <ol>
                <li>
                  <b>tokengate calls Slack</b> <code>GET /auth.test</code> with the secret and
                  expects <code>"ok": true</code>.
                </li>
                <li>
                  <b>The secret is sealed</b> and never shown again.
                </li>
                <li>
                  <b>Loading a token gives nobody access.</b> Issuer access rules is given
                  separately.
                </li>
              </ol>
            </SubBox>
          </TypeCard>
          <TypeCard
            name="tc-type"
            id="tc-hook"
            logo={logos.slackHook}
            title="Slack incoming webhook"
            description="hooks.slack.com · whole webhook URL, one channel"
            action="?type=slack-webhook"
            method="get"
          >
            <Field
              id="tc-hook-cred"
              label="Webhook URL"
              hint="Paste the whole webhook URL from api.slack.com/apps › Incoming Webhooks."
            >
              <Input
                name="credential"
                secret
                placeholder="https://hooks.slack.com/services/T00000000/B00000000/XXXX"
              />
            </Field>
            <SubmitRow>
              <button class="btn primary" type="submit">
                Save Slack incoming webhook
              </button>
            </SubmitRow>
          </TypeCard>
          <CatalogGroup>AI</CatalogGroup>
          <TypeCard
            name="tc-type"
            id="tc-openai"
            logo={logos.openai}
            title="OpenAI API"
            description="api.openai.com/v1 · project key sk-proj-…"
            action="?type=openai"
            method="get"
          >
            <Field
              id="tc-openai-cred"
              label="Project API key"
              hint="From platform.openai.com › API keys. Starts with sk-proj-."
            >
              <Input
                name="credential"
                secret
                placeholder="sk-proj-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
              />
            </Field>
            <SubmitRow>
              <button class="btn primary" type="submit">
                Check and save OpenAI
              </button>
            </SubmitRow>
          </TypeCard>
          <TypeCard
            name="tc-type"
            id="tc-github"
            logo={logos.github}
            title="GitHub REST API"
            description="api.github.com · github_pat_… · can add uploads"
            action="?type=github"
            method="get"
          >
            <Field
              id="tc-github-cred"
              label="Fine-grained token"
              hint="Limited to the needed repositories. Its expiry is read from GitHub."
            >
              <Input
                name="credential"
                secret
                placeholder="github_pat_00XXXXXXXXXXXXXXXXXXXX_XXXX"
              />
            </Field>
            <Checkbox name="also_uploads" value="1">
              Also create a token for uploads.github.com with the same secret.
            </Checkbox>
            <SubmitRow>
              <button class="btn primary" type="submit">
                Check and save GitHub
              </button>
            </SubmitRow>
          </TypeCard>
          <Or />
          <TypeCard
            name="tc-type"
            id="tc-custom"
            logo={logos.custom}
            title="Custom API"
            description="Any HTTPS API. You set the base URL and how the secret is sent."
            action="?type=custom"
            method="get"
          >
            <Field id="tc-custom-url" label="Base URL" hint="https only, no query string.">
              <Input name="base_url" type="url" mono placeholder="https://api.example.com/v1" />
            </Field>
            <SubmitRow>
              <button class="btn primary" type="submit">
                Save custom token
              </button>
            </SubmitRow>
          </TypeCard>
        </TypeCatalog>
      ),
      code: `<TypeCatalog id="types" title="Which API does this token unlock?"
  description="Ready-made types set the URL, how the secret is sent and the check for you.">
  <CatalogGroup>Chat</CatalogGroup>
  <TypeCard name="token-type" id="type-slack" logo="slack" title="Slack Web API"
    description="slack.com/api · bot token xoxb-…" open action="/admin/credentials" layout="form-layout">
    <input type="hidden" name="template" value="slack" />
    <div class="fields">
      <Field id="slack-cred" label="Bot token" hint="… Starts with xoxb-.">
        <Input name="credential" secret placeholder="xoxb-0000000000-0000000000000-XXXXXXXXXXXXXXXXXXXXXXXX" />
      </Field>
      <Field id="slack-name" label="Name" optional hint="Leave empty to use Slack 2. …">
        <Input name="name" placeholder="Slack 2" />
      </Field>
      <SubmitRow>
        <button class="btn primary" type="submit">Check and save Slack</button>
        <a href="/docs/tokens/slack#bot-token">How to get a bot token</a>
      </SubmitRow>
    </div>
    <SubBox as="aside" labelledBy="slack-next"><h4 id="slack-next">When you save</h4>…</SubBox>
  </TypeCard>
  <TypeCard name="token-type" id="type-slack-webhook" … />
  <CatalogGroup>AI</CatalogGroup>
  <TypeCard name="token-type" id="type-openai" … />
  <TypeCard name="token-type" id="type-github" …>
    …
    <Checkbox name="also_uploads" value="1">Also create a token for uploads.github.com with the same secret.</Checkbox>
  </TypeCard>
  <Or />
  <TypeCard name="token-type" id="type-custom" logo="custom" title="Custom API" … />
</TypeCatalog>`,
    },
    {
      title: 'All closed',
      description: 'Without a type in the URL every card is closed; the person opens one.',
      layout: 'stack',
      render: () => (
        <TypeCatalog id="tc-closed" title="Which API does this token unlock?">
          <TypeCard
            name="tc-closed"
            id="tc-c-slack"
            logo={logos.slack}
            title="Slack Web API"
            description="slack.com/api · bot token xoxb-…"
          >
            <p class="hint">The Slack form.</p>
          </TypeCard>
          <TypeCard
            name="tc-closed"
            id="tc-c-anthropic"
            logo={logos.anthropic}
            title="Anthropic API"
            description="api.anthropic.com · API key sk-ant-…"
          >
            <p class="hint">The Anthropic form.</p>
          </TypeCard>
        </TypeCatalog>
      ),
      code: `<TypeCatalog id="types" title="Which API does this token unlock?">
  <TypeCard name="token-type" id="type-slack" logo="slack" title="Slack Web API"
    description="slack.com/api · bot token xoxb-…" action="/admin/credentials">…</TypeCard>
  <TypeCard name="token-type" id="type-anthropic" logo="anthropic" title="Anthropic API"
    description="api.anthropic.com · API key sk-ant-…" action="/admin/credentials">…</TypeCard>
</TypeCatalog>`,
    },
  ],
  props: [
    {
      component: 'TypeCatalog',
      props: [
        {
          name: 'id',
          type: 'string',
          required: true,
          description: 'The section is labelled by `${id}-h`.',
        },
        { name: 'title', type: 'Child', required: true, description: 'The question.' },
        { name: 'description', type: 'Child', description: 'Line under the title.' },
        { name: 'headingLevel', type: '2 | 3 | 4', default: '2', description: 'Heading level.' },
        { name: 'class', type: 'string', description: 'Extra classes on the section.' },
        {
          name: 'children',
          type: 'Child',
          required: true,
          description: 'TypeCard, CatalogGroup, Or.',
        },
      ],
    },
    {
      component: 'TypeCard',
      props: [
        {
          name: 'name',
          type: 'string',
          required: true,
          description: 'Exclusive group, shared by every card.',
        },
        {
          name: 'id',
          type: 'string',
          required: true,
          description: 'Id of the card (link target).',
        },
        {
          name: 'logo',
          type: 'LogoSpec',
          required: true,
          description: 'Brand tile (32px), decorative.',
        },
        { name: 'title', type: 'Child', required: true, description: 'Type name.' },
        { name: 'description', type: 'Child', description: 'Host and secret format.' },
        { name: 'open', type: 'boolean', description: 'Open on load.' },
        { name: 'action', type: 'string', description: 'With it, the body is the type’s form.' },
        { name: 'method', type: "'post' | 'get'", default: "'post'", description: 'Form method.' },
        {
          name: 'hidden',
          type: 'HiddenFields',
          description:
            'Hidden fields at the top of the type’s form (_csrf, the type), with action.',
        },
        {
          name: 'layout',
          type: "'fields' | 'form-layout'",
          default: "'fields'",
          description: 'Body layout.',
        },
        { name: 'class', type: 'string', description: 'Extra classes.' },
        {
          name: 'children',
          type: 'Child',
          required: true,
          description: 'The fields and the SubmitRow.',
        },
      ],
    },
    {
      component: 'CatalogGroup',
      props: [
        {
          name: 'headingLevel',
          type: '2 | 3 | 4',
          default: '3',
          description: 'Heading level; its TypeCatalog sets it one under the catalog title.',
        },
        { name: 'class', type: 'string', description: 'Extra classes.' },
        { name: 'children', type: 'Child', required: true, description: 'Group label.' },
      ],
    },
  ],
  accessibility: [
    'Each card is a native details element: the summary is a button with an expanded state, opened with Enter or Space.',
    'details[name] makes the group exclusive in the browser; no script.',
    '“✓ Selected” and the chevron are decorative; the open state is announced instead.',
    'Each type has its own form, so a submit sends only that type’s fields.',
  ],
  do: [
    'Open the card the URL asks for, or the one whose form has an error.',
    'Put the generic type last, after an Or.',
  ],
  dont: [
    'Do not nest a type catalog inside a panel or a tray.',
    'Do not share one form across cards.',
  ],
  classes: ['cat-list', 'cat-group', 'type-card', 'type-body', 'sel', 'chev', 'or'],
};
