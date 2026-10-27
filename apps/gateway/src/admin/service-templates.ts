// The credential types of the "Add a credential" accordion and the operation presets of issuer access rules. A
// template card posts only the secret and display fields: base URL, injection, headers, timeout and
// check come from here, never from the form (I-SSRF-1). Every template is checked by
// test/unit/admin/ops/service-templates.test.ts against validateBaseUrl, validateServiceFields, the
// rule validation of its operation presets, and its own secret placeholder and pattern.
import type { Service } from '../db/types';
import { canonicalJson } from '../lib/json';
import type { Injection, ProxyMethod, Rule, VerifyCheck } from '../policy/types';
import type { VerifyIdentity } from './ops/verify';

/** Stands for the repository (`acme/api`) in an operation preset path. */
export const REPO_PLACEHOLDER = '{repo}';

/** A named set of rules, e.g. "Post messages: POST /chat.postMessage". */
export interface OperationPreset {
  /** Stable within its template; the `op` checkbox value. */
  id: string;
  label: string;
  rules: Rule[];
  /** Checked when a new access is created for a service of this template. */
  default: boolean;
}

/** How the secret of a template is asked for: the label, an exact fake example and the hint. */
export interface TemplateSecret {
  label: string;
  /** Format-exact but visibly fake (zeros and X), so secret scanners do not flag the source. */
  placeholder: string;
  hint: string;
  /**
   * Webhook templates: the whole webhook URL is pasted and the server keeps the part after one of
   * these prefixes (the path secret). The bare remainder is accepted too.
   */
  url_prefixes?: readonly string[];
  /** HTML `pattern` of the pasted value (compiled with the `v` flag by browsers). */
  pattern?: string;
}

export interface ServiceTemplate {
  id: string;
  label: string;
  /** Application heading in the credential catalog. */
  app: string;
  /** Access type shown within the application group. */
  access_label: string;
  /** The card summary after the label: host and secret shape, e.g. "slack.com/api · bot token xoxb-…". */
  card_summary: string;
  secret: TemplateSecret;
  /** Templates that take the same secret (rotate offers to replace it in the others too). */
  family?: 'github';
  /** The check also reads who the secret belongs to; a credential created without a name takes it. */
  identity?: VerifyIdentity;
  /** Suggested slug and display name. */
  slug: string;
  name: string;
  base_url: string;
  injection: Injection;
  forward_headers: string[];
  timeout_ms: number;
  verify: VerifyCheck | null;
  /**
   * Named operation sets that issuer access rules offers as checkboxes, `default` ones checked. A path
   * may contain REPO_PLACEHOLDER, replaced by the repository on submit (presetRules).
   */
  operation_presets: OperationPreset[];
  docs_url: string;
  /** Short operator guidance shown under the form. */
  notes: string;
}

const GITHUB_SECRET: TemplateSecret = {
  label: 'Personal access token',
  placeholder:
    'github_pat_00XXXXXXXXXXXXXXXXXXXX_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
  hint: 'Fine-grained token limited to the needed repositories (classic ghp_… also works).',
};

/** Deeply frozen: forms prefill from these shared objects and must copy before editing. */
export const SERVICE_TEMPLATES: readonly ServiceTemplate[] = deepFreeze([
  {
    id: 'slack',
    app: 'Slack',
    access_label: 'Bot token',
    label: 'Slack Web API',
    card_summary: 'slack.com/api · bot token xoxb-…',
    secret: {
      label: 'Bot token',
      placeholder: 'xoxb-0000000000-0000000000000-XXXXXXXXXXXXXXXXXXXXXXXX',
      hint: 'Bot User OAuth Token from api.slack.com/apps › OAuth & Permissions. Starts with xoxb-.',
    },
    slug: 'slack',
    name: 'Slack',
    base_url: 'https://slack.com/api',
    injection: { kind: 'bearer' },
    forward_headers: [],
    timeout_ms: 30_000,
    // auth.test returns HTTP 200 with {"ok": false} for a bad token.
    // https://docs.slack.dev/reference/methods/auth.test
    verify: { method: 'POST', path: '/auth.test', expect_status: 200, expect_ok_field: true },
    identity: 'slack-bot',
    operation_presets: [
      preset('post-message', 'Post messages', true, ['POST', '/chat.postMessage']),
      // Files go to an upload URL on files.slack.com, which needs no token; these two calls do.
      // https://docs.slack.dev/messaging/working-with-files#uploading_files
      preset(
        'upload-files',
        'Upload files',
        false,
        ['POST', '/files.getUploadURLExternal'],
        ['POST', '/files.completeUploadExternal'],
      ),
    ],
    docs_url: 'https://docs.slack.dev/apis/web-api/',
    notes:
      'Use a bot token (xoxb-…). Point the Slack SDK at <gateway>/proxy/slack/ (slackApiUrl option).',
  },
  {
    id: 'slack-webhook',
    app: 'Slack',
    access_label: 'Incoming webhook',
    label: 'Slack incoming webhook',
    card_summary: 'hooks.slack.com · webhook URL',
    secret: {
      label: 'Webhook URL',
      placeholder: 'https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX',
      hint: 'Paste the whole webhook URL. Only the part after /services/ is stored, as the secret.',
      url_prefixes: ['https://hooks.slack.com/services/'],
      pattern: 'https://hooks\\.slack\\.com/services/[^\\/\\s]+(\\/[^\\/\\s]+)+',
    },
    slug: 'slack-webhook',
    name: 'Slack webhook',
    base_url: 'https://hooks.slack.com/services',
    // The credential is the "T…/B…/…" part of the webhook URL; callers POST to /proxy/<slug>.
    injection: { kind: 'path' },
    forward_headers: [],
    timeout_ms: 30_000,
    verify: null,
    operation_presets: [preset('send', 'Send messages', true, ['POST', '/'])],
    docs_url: 'https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/',
    notes:
      'There is no read-only check for webhooks. Workloads POST to <gateway>/proxy/slack-webhook.',
  },
  {
    id: 'discord-webhook',
    app: 'Discord',
    access_label: 'Webhook',
    label: 'Discord webhook',
    card_summary: 'discord.com · webhook URL',
    secret: {
      label: 'Webhook URL',
      placeholder:
        'https://discord.com/api/webhooks/000000000000000000/XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      hint: 'Paste the whole webhook URL from Server settings › Integrations › Webhooks.',
      url_prefixes: ['https://discord.com/api/webhooks/', 'https://discordapp.com/api/webhooks/'],
      pattern: 'https://(discord|discordapp)\\.com/api/webhooks/[0-9]+/[A-Za-z0-9_\\-]+',
    },
    slug: 'discord-webhook',
    name: 'Discord webhook',
    base_url: 'https://discord.com/api/webhooks',
    // The credential is the "{id}/{token}" part of the webhook URL; callers POST to /proxy/<slug>.
    injection: { kind: 'path' },
    forward_headers: [],
    timeout_ms: 30_000,
    // GET on the webhook URL is the only read-only call, and it returns the token in its body.
    // https://discord.com/developers/docs/resources/webhook#get-webhook-with-token
    verify: null,
    operation_presets: [preset('send', 'Send messages', true, ['POST', '/'])],
    docs_url: 'https://discord.com/developers/docs/resources/webhook#execute-webhook',
    notes:
      'Allow only POST /: GET and PATCH on the webhook URL return the token in the response body.',
  },
  {
    id: 'openai',
    app: 'OpenAI',
    access_label: 'API key',
    label: 'OpenAI API',
    card_summary: 'api.openai.com · project API key sk-proj-…',
    secret: {
      label: 'API key',
      placeholder: 'sk-proj-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      hint: 'Project API key from platform.openai.com › API keys.',
    },
    slug: 'openai',
    name: 'OpenAI',
    base_url: 'https://api.openai.com/v1',
    injection: { kind: 'bearer' },
    forward_headers: ['openai-organization', 'openai-project', 'openai-beta'],
    timeout_ms: 600_000,
    verify: { method: 'GET', path: '/models', expect_status: 200 },
    operation_presets: [
      preset('responses', 'Create responses', true, ['POST', '/responses']),
      preset('chat', 'Chat completions', true, ['POST', '/chat/completions']),
      preset('models', 'List models', true, ['GET', '/models']),
    ],
    docs_url: 'https://platform.openai.com/docs/api-reference/authentication',
    notes: 'Use a project API key. Set the SDK base URL to <gateway>/proxy/openai.',
  },
  {
    id: 'anthropic',
    app: 'Anthropic',
    access_label: 'API key',
    label: 'Anthropic API',
    card_summary: 'api.anthropic.com · API key sk-ant-…',
    secret: {
      label: 'API key',
      placeholder: 'sk-ant-api03-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      hint: 'API key from console.anthropic.com › API keys.',
    },
    slug: 'anthropic',
    name: 'Anthropic',
    // Without /v1: the Anthropic SDKs add /v1 to every path themselves.
    base_url: 'https://api.anthropic.com',
    injection: { kind: 'header', name: 'x-api-key' },
    forward_headers: ['anthropic-version', 'anthropic-beta'],
    timeout_ms: 600_000,
    // Listing models is read-only and needs the anthropic-version header, which the check sends.
    // https://docs.anthropic.com/en/api/models-list
    verify: {
      method: 'GET',
      path: '/v1/models',
      expect_status: 200,
      headers: { 'anthropic-version': '2023-06-01' },
    },
    operation_presets: [
      preset('messages', 'Send messages', true, ['POST', '/v1/messages']),
      preset('count-tokens', 'Count tokens', false, ['POST', '/v1/messages/count_tokens']),
    ],
    docs_url: 'https://docs.anthropic.com/en/api/overview',
    notes: 'Set the SDK base URL to <gateway>/proxy/anthropic; the SDK adds /v1 itself.',
  },
  {
    id: 'github',
    app: 'GitHub',
    access_label: 'Personal access token',
    label: 'GitHub REST API',
    card_summary: 'api.github.com · personal access token github_pat_… or ghp_…',
    secret: GITHUB_SECRET,
    family: 'github',
    slug: 'github',
    name: 'GitHub',
    base_url: 'https://api.github.com',
    injection: { kind: 'bearer' },
    forward_headers: ['x-github-api-version'],
    timeout_ms: 60_000,
    // /rate_limit needs no permissions and works with every credential type.
    // https://docs.github.com/en/rest/rate-limit/rate-limit
    verify: { method: 'GET', path: '/rate_limit', expect_status: 200 },
    operation_presets: [
      preset('read-repo', 'Read repository contents', true, ['GET', '/repos/{repo}/**']),
    ],
    docs_url: 'https://docs.github.com/en/rest/authentication/authenticating-to-the-rest-api',
    notes:
      'Prefer a fine-grained token limited to the needed repositories. Contents API paths may contain %2F, which only ** matches (use contents/**, not contents/*).',
  },
  {
    id: 'github-uploads',
    app: 'GitHub',
    access_label: 'Release asset uploads',
    label: 'GitHub release asset uploads',
    card_summary: 'uploads.github.com · the same secret as GitHub REST API',
    secret: GITHUB_SECRET,
    family: 'github',
    slug: 'github-uploads',
    name: 'GitHub uploads',
    base_url: 'https://uploads.github.com',
    injection: { kind: 'bearer' },
    forward_headers: ['x-github-api-version'],
    timeout_ms: 600_000,
    verify: null,
    operation_presets: [
      preset('release-assets', 'Upload release assets', true, [
        'POST',
        '/repos/{repo}/releases/*/assets',
      ]),
    ],
    docs_url: 'https://docs.github.com/en/rest/releases/assets#upload-a-release-asset',
    notes:
      'Release asset uploads use a separate host. Store the same secret that the GitHub credential holds.',
  },
] satisfies ServiceTemplate[]);

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function getServiceTemplate(id: string): ServiceTemplate | null {
  return SERVICE_TEMPLATES.find((template) => template.id === id) ?? null;
}

/**
 * The template of a service: its stored `template_id` (set on every save from the destination, see
 * templateIdFor). Display and preset data only, never a security reference.
 */
export function templateForService(service: Pick<Service, 'template_id'>): ServiceTemplate | null {
  return service.template_id === null ? null : getServiceTemplate(service.template_id);
}

/**
 * The template whose destination is exactly this one (normalized base URL and canonical injection
 * JSON), else null: a token keeps a type label only while it points where the template points.
 */
export function templateIdFor(baseUrl: string, injectionJson: string): string | null {
  return (
    SERVICE_TEMPLATES.find(
      (template) =>
        template.base_url === baseUrl && canonicalJson(template.injection) === injectionJson,
    )?.id ?? null
  );
}

/** The identity the check of this destination reads (templateIdFor), else null. */
export function identityFor(baseUrl: string, injectionJson: string): VerifyIdentity | null {
  const id = templateIdFor(baseUrl, injectionJson);
  return (id === null ? null : getServiceTemplate(id)?.identity) ?? null;
}

/** True when two templates take the same secret (same id or same family). */
export function sameSecretFamily(a: ServiceTemplate, b: ServiceTemplate): boolean {
  return a.id === b.id || (a.family !== undefined && a.family === b.family);
}

/**
 * Prefixes that identify a vendor's secret, longest first, mapped to the template it belongs to.
 * Used only to refuse a secret pasted into the wrong card, never to pick the card: GitHub
 * Enterprise Server shares the GitHub prefixes, and `sk-` is used by many vendors.
 */
export const FOREIGN_PREFIXES: ReadonlyArray<readonly [prefix: string, templateId: string]> = [
  ['https://hooks.slack.com/', 'slack-webhook'],
  ['https://discord.com/api/webhooks/', 'discord-webhook'],
  ['https://discordapp.com/api/webhooks/', 'discord-webhook'],
  ['github_pat_', 'github'],
  ['sk-proj-', 'openai'],
  ['sk-ant-', 'anthropic'],
  ['ghp_', 'github'],
  ['gho_', 'github'],
  ['ghs_', 'github'],
  ['xox', 'slack'],
];

/** "bot token", but "API key" (acronyms keep their case). */
function lowerLabel(label: string): string {
  return /^[A-Z]{2}/.test(label) ? label : `${label.charAt(0).toLowerCase()}${label.slice(1)}`;
}

export type TemplateSecretResult =
  | { ok: true; secret: string }
  /** `likely`: the template the pasted value seems to belong to. The error never quotes it. */
  | { ok: false; error: string; likely: string | null };

/**
 * The secret to store for a value pasted into `template`'s card: a whole webhook URL becomes its
 * path secret; another vendor's secret, or a URL in a card that takes no URL, is refused before
 * anything is sent (the wrong-type guard). Format checks are normalizeCredential's.
 */
export function secretFromTemplateInput(
  template: ServiceTemplate,
  raw: string,
): TemplateSecretResult {
  const value = typeof raw === 'string' ? raw.trim() : '';
  const lower = value.toLowerCase();
  const host = new URL(template.base_url).host;
  const prefixes = template.secret.url_prefixes ?? [];
  const own = prefixes.find((prefix) => lower.startsWith(prefix.toLowerCase()));
  if (own !== undefined) {
    const rest = value.slice(own.length).split(/[?#]/)[0]?.replace(/\/+$/, '') ?? '';
    if (rest === '') {
      return {
        ok: false,
        error: `Paste the whole webhook URL, including the part after ${own}`,
        likely: null,
      };
    }
    return { ok: true, secret: rest };
  }
  const foreign = FOREIGN_PREFIXES.find(([prefix]) => lower.startsWith(prefix.toLowerCase()));
  const likely = foreign ? getServiceTemplate(foreign[1]) : null;
  if (likely && !sameSecretFamily(likely, template)) {
    return {
      ok: false,
      error: `This looks like a ${likely.label} secret, and it would be sent to ${host}. Use the ${likely.label} card instead, or paste the ${lowerLabel(template.secret.label)} of ${template.label}`,
      likely: likely.id,
    };
  }
  if (/^https?:\/\//i.test(value)) {
    return {
      ok: false,
      error:
        prefixes.length > 0
          ? `This is not a ${template.label} URL. Paste a URL that starts with ${prefixes[0]}`
          : `This is a URL. Paste the ${lowerLabel(template.secret.label)} of ${template.label} itself`,
      likely: null,
    };
  }
  return { ok: true, secret: value };
}

/** The rules of `preset` with REPO_PLACEHOLDER replaced by `repository` (e.g. `acme/api`). */
export function presetRules(preset: OperationPreset, repository: string): Rule[] {
  return preset.rules.map((rule) => ({
    methods: [...rule.methods],
    path: rule.path.replaceAll(REPO_PLACEHOLDER, repository),
  }));
}

/** True when a rule path of `preset` needs a repository. */
export function presetNeedsRepository(preset: OperationPreset): boolean {
  return preset.rules.some((rule) => rule.path.includes(REPO_PLACEHOLDER));
}

/** The presets checked by default for a new access. */
export function defaultPresets(template: ServiceTemplate): OperationPreset[] {
  return template.operation_presets.filter((p) => p.default);
}

function preset(
  id: string,
  label: string,
  isDefault: boolean,
  ...rules: Array<[ProxyMethod, string]>
): OperationPreset {
  return {
    id,
    label,
    default: isDefault,
    rules: rules.map(([method, path]) => ({ methods: [method], path })),
  };
}
