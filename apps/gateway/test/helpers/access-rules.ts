// Fixtures for the credential and global access rule integration tests: a fresh control plane, an app over a
// fake network that records every outbound call, sessions per role, and seeders for labels and
// request records.
import { env } from 'cloudflare:workers';
import { insertRequestRecordsStatements } from '../../src/db/requests';
import type { Role } from '../../src/db/types';
import type { RequestRecord } from '../../src/telemetry/types';
import {
  type FetchCall,
  fakeNetwork,
  GITHUB_ISSUER,
  GITHUB_JWKS,
  KEK_1,
} from '../unit/admin/ops/helpers';
import { type AdminSession, createUser, loginAs, resetControlPlane } from './admin-auth';
import { createTestApp, type TestApp } from './app';

export const GITLAB_ISSUER = 'https://gitlab.com';
export const BUILDKITE_ISSUER = 'https://agent.buildkite.com';
/** Vercel's team issuer mode for the team `acme`; the global mode is `https://oidc.vercel.com`. */
export const VERCEL_TEAM_ISSUER = 'https://oidc.vercel.com/acme';
export const VERCEL_GLOBAL_ISSUER = 'https://oidc.vercel.com';

export interface RulesWorld {
  app: TestApp;
  calls: FetchCall[];
  sessions: Record<Role, AdminSession>;
}

/** Resets both databases and logs one user per role into an app over a recording fake network. */
export async function rulesWorld(
  extraIssuers: Record<string, string> = {},
  discovery: Record<string, unknown> = {},
): Promise<RulesWorld> {
  await resetControlPlane();
  await env.TELEMETRY_DB.batch([
    env.TELEMETRY_DB.prepare('DELETE FROM request_log'),
    env.TELEMETRY_DB.prepare('DELETE FROM request_rollup_hourly'),
  ]);
  const issuers: Record<string, string> = {
    [GITHUB_ISSUER]: GITHUB_JWKS,
    [GITLAB_ISSUER]: `${GITLAB_ISSUER}/oauth/discovery/keys`,
    [BUILDKITE_ISSUER]: `${BUILDKITE_ISSUER}/.well-known/jwks`,
    [VERCEL_TEAM_ISSUER]: `${VERCEL_TEAM_ISSUER}/.well-known/jwks`,
    [VERCEL_GLOBAL_ISSUER]: `${VERCEL_GLOBAL_ISSUER}/.well-known/jwks`,
    ...extraIssuers,
  };
  const net = fakeNetwork(undefined, issuers);
  const fetchWithAlgs: typeof fetch = async (input, init) => {
    const response = await net.fetch(input, init);
    const url = String(input instanceof Request ? input.url : input);
    if (!url.endsWith('/.well-known/openid-configuration') || response.status !== 200)
      return response;
    const document = (await response.json()) as Record<string, unknown>;
    return Response.json({ ...document, ...discovery });
  };
  const app = createTestApp({ fetch: fetchWithAlgs, env: { TOKENGATE_KEK: KEK_1 } });
  const roles: Role[] = ['viewer', 'token_manager', 'access_manager', 'admin', 'owner'];
  const sessions = {} as Record<Role, AdminSession>;
  for (const role of roles) {
    const user = await createUser({ email: `${role.replace('_', '-')}@example.com`, role });
    sessions[role] = await loginAs(app, user);
  }
  return { app, calls: net.calls, sessions };
}

export async function seedLabel(
  ruleId: string,
  claim: string,
  value: string,
  label: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO claim_labels (access_rule_id, claim, value, label, updated_at, updated_by)
     VALUES (?, ?, ?, ?, 1, NULL)
     ON CONFLICT (access_rule_id, claim, value) DO UPDATE SET label = excluded.label`,
  )
    .bind(ruleId, claim, value, label)
    .run();
}

export async function labels(ruleId?: string): Promise<Array<Record<string, unknown>>> {
  const statement = ruleId
    ? env.DB.prepare(
        'SELECT claim, value, label FROM claim_labels WHERE access_rule_id = ? ORDER BY claim, value',
      ).bind(ruleId)
    : env.DB.prepare('SELECT claim, value, label FROM claim_labels ORDER BY claim, value');
  return (await statement.all<Record<string, unknown>>()).results;
}

/** Audit actions except sign-ins, in insertion order. */
export async function auditActions(): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT action FROM audit_log WHERE action NOT LIKE 'user.%' ORDER BY rowid",
  ).all<{ action: string }>();
  return results.map((row) => row.action);
}

export async function lastAudit(action: string): Promise<Record<string, unknown> | null> {
  const row = await env.DB.prepare(
    'SELECT diff FROM audit_log WHERE action = ? ORDER BY rowid DESC LIMIT 1',
  )
    .bind(action)
    .first<{ diff: string | null }>();
  return row?.diff ? (JSON.parse(row.diff) as Record<string, unknown>) : null;
}

export function requestRecord(overrides: Partial<RequestRecord> & { id: string }): RequestRecord {
  return {
    ts: Date.now(),
    outcome: 'denied',
    reason: 'no_matching_rule',
    status: 403,
    upstream_status: null,
    method: 'GET',
    path: '/repos/acme/app',
    service_slug: 'github',
    service_id: null,
    credential_access_rule_id: null,
    global_access_rule_id: null,
    claims_verified: 1,
    caller_subject: null,
    caller_repository: null,
    caller_claims: null,
    jti: null,
    untrusted_iss: null,
    eval_trace: null,
    duration_ms: 5,
    upstream_ms: null,
    weight: 1,
    ip: null,
    user_agent: null,
    colo: null,
    ...overrides,
  };
}

export async function seedRequests(records: RequestRecord[]): Promise<void> {
  await env.TELEMETRY_DB.batch(insertRequestRecordsStatements(env.TELEMETRY_DB, records));
}

/** The value of the first input named `name` in a page, or null. */
export function inputValue(html: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`<input[^>]*name="${escaped}"[^>]*value="([^"]*)"`).exec(html);
  return match?.[1] ?? null;
}

/** The selected option value of the select named `name`, or null. */
export function selectedValue(html: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const select = new RegExp(`<select[^>]*name="${escaped}"[^>]*>([\\s\\S]*?)</select>`).exec(html);
  if (!select) return null;
  return /<option value="([^"]*)" selected/.exec(select[1] ?? '')?.[1] ?? null;
}

/** The ids of the checked radios/checkboxes named `name`. */
export function checkedValues(html: string, name: string): string[] {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const out: string[] = [];
  for (const match of html.matchAll(new RegExp(`<input[^>]*name="${escaped}"[^>]*>`, 'g'))) {
    if (!/\schecked(=""|\s|\/|>)/.test(match[0])) continue;
    const value = /value="([^"]*)"/.exec(match[0]);
    if (value) out.push(value[1] ?? '');
  }
  return out;
}

export function locationOf(response: Response): string {
  return response.headers.get('location') ?? '';
}

export function idFromLocation(location: string): string {
  return location.split('?')[0]?.split('/').at(-1) ?? '';
}

function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * The fields a browser submits for the form `formId` as rendered, without the CSRF token (the
 * test helpers add it): inputs (checked radios and checkboxes only, no buttons) and selects.
 */
export async function formFields(
  html: string,
  formId: string,
): Promise<Record<string, string | string[]>> {
  const out: Record<string, string | string[]> = {};
  const add = (name: string, value: string) => {
    if (name === '_csrf') return;
    const current = out[name];
    out[name] =
      current === undefined ? value : [...(Array.isArray(current) ? current : [current]), value];
  };
  let select: { name: string; value: string | null; first: string | null } | null = null;
  await new HTMLRewriter()
    .on(`form#${formId} input`, {
      element(element) {
        const name = element.getAttribute('name');
        const type = element.getAttribute('type') ?? 'text';
        if (!name || element.hasAttribute('disabled')) return;
        if (['submit', 'button', 'reset'].includes(type)) return;
        if ((type === 'radio' || type === 'checkbox') && !element.hasAttribute('checked')) return;
        add(
          name,
          decodeEntities(element.getAttribute('value') ?? (type === 'checkbox' ? 'on' : '')),
        );
      },
    })
    .on(`form#${formId} select`, {
      element(element) {
        const name = element.getAttribute('name');
        if (!name) return;
        const current = { name, value: null as string | null, first: null as string | null };
        select = current;
        element.onEndTag(() => {
          add(current.name, current.value ?? current.first ?? '');
          select = null;
        });
      },
    })
    .on(`form#${formId} select option`, {
      element(element) {
        const current = select as { value: string | null; first: string | null } | null;
        if (!current) return;
        const value = decodeEntities(element.getAttribute('value') ?? '');
        if (current.first === null) current.first = value;
        if (element.hasAttribute('selected')) current.value = value;
      },
    })
    .transform(new Response(html))
    .text();
  return out;
}
