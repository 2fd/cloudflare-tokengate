// Prefill data for the "new service" form and the operation presets of consumer access. Templates
// are suggestions only: the submitted form goes through the same validation as any other service.
// Every template is checked by test/unit/admin/ops/service-templates.test.ts against
// validateBaseUrl, validateServiceFields and the rule validation of its operation presets.
import type { Service } from '../db/types';
import type { Injection, ProxyMethod, Rule, VerifyCheck } from '../policy/types';

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

export interface ServiceTemplate {
  id: string;
  label: string;
  /** Suggested slug and display name. */
  slug: string;
  name: string;
  base_url: string;
  injection: Injection;
  forward_headers: string[];
  timeout_ms: number;
  verify: VerifyCheck | null;
  /**
   * Named operation sets that consumer access offers as checkboxes, `default` ones checked. A path
   * may contain REPO_PLACEHOLDER, replaced by the repository on submit (presetRules).
   */
  operation_presets: OperationPreset[];
  docs_url: string;
  /** Short operator guidance shown under the form. */
  notes: string;
}

/** Deeply frozen: forms prefill from these shared objects and must copy before editing. */
export const SERVICE_TEMPLATES: readonly ServiceTemplate[] = deepFreeze([
  {
    id: 'slack',
    label: 'Slack Web API',
    slug: 'slack',
    name: 'Slack',
    base_url: 'https://slack.com/api',
    injection: { kind: 'bearer' },
    forward_headers: [],
    timeout_ms: 30_000,
    // auth.test returns HTTP 200 with {"ok": false} for a bad token.
    // https://docs.slack.dev/reference/methods/auth.test
    verify: { method: 'POST', path: '/auth.test', expect_status: 200, expect_ok_field: true },
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
    label: 'Slack incoming webhook',
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
      'Paste only the part after https://hooks.slack.com/services/. There is no read-only check for webhooks.',
  },
  {
    id: 'discord-webhook',
    label: 'Discord webhook',
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
      'Paste only the "{id}/{token}" part after https://discord.com/api/webhooks/. Grant only POST /: GET and PATCH on the webhook URL return the token in the response body.',
  },
  {
    id: 'openai',
    label: 'OpenAI API',
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
    label: 'Anthropic API',
    slug: 'anthropic',
    name: 'Anthropic',
    // Without /v1: the Anthropic SDKs add /v1 to every path themselves.
    base_url: 'https://api.anthropic.com',
    injection: { kind: 'header', name: 'x-api-key' },
    forward_headers: ['anthropic-version', 'anthropic-beta'],
    timeout_ms: 600_000,
    // The API requires an anthropic-version header, which a verify check cannot send.
    // https://docs.anthropic.com/en/api/versioning
    verify: null,
    operation_presets: [
      preset('messages', 'Send messages', true, ['POST', '/v1/messages']),
      preset('count-tokens', 'Count tokens', false, ['POST', '/v1/messages/count_tokens']),
    ],
    docs_url: 'https://docs.anthropic.com/en/api/overview',
    notes: 'Set the SDK base URL to <gateway>/proxy/anthropic; the SDK adds /v1 itself.',
  },
  {
    id: 'github',
    label: 'GitHub REST API',
    slug: 'github',
    name: 'GitHub',
    base_url: 'https://api.github.com',
    injection: { kind: 'bearer' },
    forward_headers: ['x-github-api-version'],
    timeout_ms: 60_000,
    // /rate_limit needs no permissions, works with every token type and returns the token expiry
    // header. https://docs.github.com/en/rest/rate-limit/rate-limit
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
    label: 'GitHub release asset uploads',
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
    notes: 'Release asset uploads use a separate host. Store the same token as the GitHub service.',
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
 * The template of a service: its stored `template_id`, else the template with the same base URL
 * (services saved before template_id was persisted). Display and preset data only.
 */
export function templateForService(
  service: Pick<Service, 'base_url' | 'template_id'>,
): ServiceTemplate | null {
  if (service.template_id !== null) return getServiceTemplate(service.template_id);
  return SERVICE_TEMPLATES.find((template) => template.base_url === service.base_url) ?? null;
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
