// Service mutations for the admin UI. base_url and injection change only together with a newly
// entered credential, sealed with AAD over (id, base_url, injection) (I-CRED-2); plaintext never
// reaches results, audit diffs or logs (I-CRED-1); each change writes one audit row (I-AUDIT-1).
import {
  credentialAad,
  type OpenCredentialError,
  openCredential,
  sealCredential,
  sealedKid,
} from '../../crypto/envelope';
import { type Keyring, loadKeyring } from '../../crypto/keyring';
import { deleteGrantsByIdsStatement, exactGrantSetGuard, listGrants } from '../../db/grants';
import {
  deleteServiceStatement,
  getService,
  getServiceBySlug,
  insertServiceStatement,
  listServices,
  type ServiceFields,
  serviceCredentialGuard,
  serviceExistsGuard,
  serviceUnreferencedGuard,
  serviceVersionGuard,
  setServiceEnabledStatement,
  updateServiceCredentialStatement,
  updateServiceFieldsStatement,
} from '../../db/services';
import {
  getAdminHosts,
  getAllowedUpstreamHosts,
  getState,
  recordKeyCheckValueStatement,
} from '../../db/settings';
import type { Actor, Grant, Service } from '../../db/types';
import type { Deps } from '../../deps';
import { newId } from '../../lib/ids';
import { canonicalJson } from '../../lib/json';
import type { Injection, VerifyCheck } from '../../policy/types';
import {
  normalizeCredential,
  normalizeInjection,
  validateBaseUrl,
  validateServiceFields,
} from '../../policy/validate';
import { getServiceTemplate, templateIdFor } from '../service-templates';
import {
  allOf,
  booleanErrors,
  commitOrConstraintFailure,
  concurrentChange,
  descriptionErrors,
  type FieldError,
  fieldError,
  nextVersion,
  type OpFailure,
  opFailure,
  pick,
  staleEdit,
  timestampErrors,
  trimmed,
} from './shared';
import { runVerifyCheck, type VerifyOutcome } from './verify';

/** Request-derived inputs of service validation. */
export interface OpContext {
  /** Hostname of the current request; base URLs may not point at it or at the admin hosts. */
  requestHost: string;
}

export function opContextFor(requestUrl: URL): OpContext {
  return { requestHost: requestUrl.hostname };
}

/** The admin hosts and the request host: base URLs may not point at this gateway (I-SSRF-1). */
async function gatewayHosts(db: D1Database, context: OpContext): Promise<string[]> {
  return [...((await getAdminHosts(db)) ?? []), context.requestHost];
}

export const DEFAULT_TIMEOUT_MS = 120_000;

/** A service as shown to admins and stored in audit diffs: no ciphertext, no plaintext. */
export type ServiceView = Omit<Service, 'credential_sealed' | 'injection_json'> & {
  credential_set: boolean;
};

export function serviceView(service: Service): ServiceView {
  const { credential_sealed, injection_json: _injectionJson, ...rest } = service;
  return { ...rest, credential_set: credential_sealed !== null };
}

export type CredentialOpResult =
  | { ok: true; service: ServiceView; verify: VerifyOutcome | null; warnings: string[] }
  | (OpFailure & { verify?: VerifyOutcome });

// ---------------------------------------------------------------------------------------------
// Create

export interface ServiceCreateInput {
  slug: string;
  name: string;
  description?: string;
  base_url: string;
  injection: unknown;
  forward_headers?: string[];
  timeout_ms?: number;
  verify?: VerifyCheck | null;
  enabled?: boolean;
  credential_expires_at?: number | null;
  /** Optional initial credential; empty means none. */
  secret?: string | null;
  /** Store the credential even if the verify check fails. */
  save_anyway?: boolean;
}

/** The validated parts of a create, before the keyring and the credential check. */
interface CreatePlan {
  base: string;
  injection: Injection;
  injectionJson: string;
  verify: VerifyCheck | null;
  credential: { value: string; hint: string | null } | null;
  warnings: string[];
}

/**
 * Every check of a create that sends nothing and writes nothing, in the order of A7.4: field
 * formats and the secret format, then the slug (a SELECT before anything is sent; the UNIQUE
 * constraint stays the race backstop), then the allowlist. `hostAllowed` skips only the allowlist
 * check, for a route that allows the host itself first (allow_host).
 */
export async function checkServiceCreate(
  deps: Pick<Deps, 'env'>,
  input: ServiceCreateInput,
  context: OpContext,
  options: { hostAllowed?: boolean } = {},
): Promise<{ ok: true; warnings: string[] } | OpFailure> {
  const plan = await planCreate(deps, input, context, options);
  if (!plan.ok) return plan;
  // A secret is stored only with a keyring (A7.4 step 4), checked before an owner's allow_host
  // commits.
  if (plan.plan.credential) {
    const keyring = await loadKeyring(deps.env);
    if (!keyring.ok) return keyringUnavailable(keyring.error);
  }
  return { ok: true, warnings: plan.plan.warnings };
}

async function planCreate(
  deps: Pick<Deps, 'env'>,
  input: ServiceCreateInput,
  context: OpContext,
  options: { hostAllowed?: boolean },
): Promise<{ ok: true; plan: CreatePlan } | OpFailure> {
  const db = deps.env.DB;
  const errors: string[] = [];
  const base = validateBaseUrl(input.base_url, {
    gatewayHosts: await gatewayHosts(db, context),
    allowedUpstreamHosts: options.hostAllowed ? null : await getAllowedUpstreamHosts(db),
  });
  if (!base.ok) errors.push(base.error);
  const injection = normalizeInjection(input.injection);
  const verify = normalizeVerify(input.verify);
  const fields = validateServiceFields({
    slug: input.slug,
    name: input.name,
    timeout_ms: input.timeout_ms ?? DEFAULT_TIMEOUT_MS,
    forward_headers: input.forward_headers ?? [],
    // validateServiceFields reports an invalid injection itself.
    injection: input.injection as Injection,
    verify,
  });
  errors.push(...fields.errors);
  errors.push(...descriptionErrors(input.description));
  errors.push(...booleanErrors('enabled', input.enabled));
  errors.push(...timestampErrors('credential expiry', input.credential_expires_at));

  const secretText = typeof input.secret === 'string' ? input.secret : '';
  const credential =
    secretText.trim() !== '' && injection.ok
      ? normalizeCredential(secretText, injection.injection)
      : null;
  if (credential && !credential.ok) errors.push(credential.error);
  if (errors.length > 0 || !base.ok || !injection.ok || (credential && !credential.ok)) {
    return opFailure('invalid', serviceFieldErrors(errors), fields.warnings);
  }
  if (await getServiceBySlug(db, input.slug)) {
    const free = await freeSlug(db, input.slug);
    return opFailure(
      'conflict',
      [fieldError('slug', `another token already uses ${input.slug}; leave empty to use ${free}`)],
      fields.warnings,
    );
  }
  return {
    ok: true,
    plan: {
      base: base.normalized,
      injection: injection.injection,
      injectionJson: injection.json,
      verify,
      credential: credential ? { value: credential.value, hint: credential.hint } : null,
      warnings: fields.warnings,
    },
  };
}

export async function createService(
  deps: Deps,
  actor: Actor,
  input: ServiceCreateInput,
  context: OpContext,
): Promise<CredentialOpResult> {
  const planned = await planCreate(deps, input, context, {});
  if (!planned.ok) return planned;
  const { plan } = planned;
  const credential = plan.credential;

  const now = deps.now();
  const id = newId('svc', now, deps.random);
  let sealed: { sealed: string; hint: string | null; verify: VerifyOutcome | null } | null = null;
  let sealingKeyring: Keyring | null = null;
  if (credential) {
    const keyring = await loadKeyring(deps.env);
    if (!keyring.ok) return keyringUnavailable(keyring.error);
    sealingKeyring = keyring.keyring;
    const outcome = plan.verify
      ? await runVerifyCheck(
          deps,
          {
            base_url: plan.base,
            injection: plan.injection,
            timeout_ms: input.timeout_ms ?? DEFAULT_TIMEOUT_MS,
            verify: plan.verify,
          },
          credential.value,
        )
      : null;
    if (outcome && !outcome.passed && input.save_anyway !== true) {
      return verifyFailed(outcome, plan.warnings);
    }
    const aad = credentialAad(id, plan.base, plan.injectionJson);
    sealed = {
      sealed: await sealCredential(keyring.keyring, credential.value, aad, deps.random),
      hint: credential.hint,
      verify: outcome,
    };
  }

  const row = {
    id,
    slug: input.slug,
    name: input.name.trim(),
    description: (input.description ?? '').trim(),
    base_url: plan.base,
    injection_json: plan.injectionJson,
    forward_headers: input.forward_headers ?? [],
    timeout_ms: input.timeout_ms ?? DEFAULT_TIMEOUT_MS,
    credential_sealed: sealed?.sealed ?? null,
    credential_hint: sealed?.hint ?? null,
    credential_updated_at: sealed ? now : null,
    credential_expires_at: input.credential_expires_at ?? sealed?.verify?.expiresAt ?? null,
    verify: plan.verify,
    template_id: templateIdFor(plan.base, plan.injectionJson),
    enabled: input.enabled ?? true,
    created_at: now,
  };
  const after = serviceView({ ...row, injection: plan.injection, updated_at: now });
  const outcome = await commitOrConstraintFailure(
    deps,
    actor,
    {
      action: 'service.create',
      targetType: 'service',
      targetId: id,
      summary: `Created service ${row.slug}${sealed ? ' with a credential' : ''}`,
      diff: { after, ...(sealed?.verify ? { verify: verifyAuditView(sealed.verify) } : {}) },
    },
    null,
    [
      insertServiceStatement(deps.env.DB, row),
      ...kcvStatements(deps, sealingKeyring, sealed !== null, row.id),
    ],
  );
  if (!outcome.ok) return outcome;
  return { ok: true, service: after, verify: sealed?.verify ?? null, warnings: plan.warnings };
}

/** The highest suffixed slug or name tried before giving up (then the clash is a 409). */
const FREE_SUFFIX_MAX = 99;

/** `base` when no token uses it, else `base-2`, `base-3`, … (within the 63-character limit). */
export async function freeSlug(db: D1Database, base: string): Promise<string> {
  return freeSlugAmong(
    base,
    (await listServices(db)).map((service) => service.slug),
  );
}

/** `base` when no token has that name, else `base 2`, `base 3`, … */
export async function freeName(db: D1Database, base: string): Promise<string> {
  return freeNameAmong(
    base,
    (await listServices(db)).map((service) => service.name),
  );
}

export function freeSlugAmong(base: string, taken: Iterable<string>): string {
  return freeValue(
    base,
    new Set(taken),
    (value, n) => `${value.slice(0, 63 - `-${n}`.length)}-${n}`,
  );
}

export function freeNameAmong(base: string, taken: Iterable<string>): string {
  return freeValue(base, new Set(taken), (value, n) => `${value} ${n}`);
}

function freeValue(
  base: string,
  taken: Set<string>,
  suffixed: (base: string, n: number) => string,
) {
  if (!taken.has(base)) return base;
  for (let n = 2; n <= FREE_SUFFIX_MAX; n++) {
    const candidate = suffixed(base, n);
    if (!taken.has(candidate)) return candidate;
  }
  return base;
}

/**
 * The slug a custom token gets by default: the first DNS label of the base URL's host that is not
 * `api` or `www` (api.example.com → example), reduced to the slug alphabet; `custom` otherwise.
 */
export function slugBaseFor(baseUrl: string): string {
  let host = '';
  try {
    host = new URL(baseUrl.trim()).hostname.toLowerCase();
  } catch {
    return 'custom';
  }
  const labels = host.split('.');
  const label = labels.slice(0, -1).find((part) => part !== 'api' && part !== 'www') ?? '';
  const slug = label
    .replace(/[^a-z0-9-]/g, '')
    .replace(/^-+/, '')
    .slice(0, 63);
  return slug === '' ? 'custom' : slug;
}

/**
 * The form field each validation message is about (the messages of policy/validate.ts and the
 * shared checks start with their subject). Unknown messages belong to the whole form.
 */
export function serviceFieldErrors(errors: readonly string[]): FieldError[] {
  return errors.map((message) => fieldError(serviceFieldOf(message), message));
}

const FIELD_PREFIXES: ReadonlyArray<readonly [prefix: string, field: string]> = [
  ['base URL', 'base_url'],
  ['slug', 'slug'],
  ['name', 'name'],
  ['description', 'description'],
  ['credential expiry', 'credential_expires_at'],
  ['credential', 'credential'],
  ['timeout', 'timeout_ms'],
  ['verify method', 'verify_method'],
  ['verify expected status', 'verify_expect_status'],
  ['verify', 'verify_path'],
  ['injection: header name', 'injection_header_name'],
  ['injection: header prefix', 'injection_header_prefix'],
  ['injection: username', 'injection_username'],
  ['injection: query', 'injection_param'],
  ['injection: path prefix', 'injection_path_prefix'],
  ['injection', 'injection_kind'],
  ['forward header', 'forward_headers'],
  ['at most 32 forward headers', 'forward_headers'],
];

function serviceFieldOf(message: string): string | null {
  return FIELD_PREFIXES.find(([prefix]) => message.startsWith(prefix))?.[1] ?? null;
}

// ---------------------------------------------------------------------------------------------
// Non-binding fields

/** Fields updateServiceFields may change. base_url and injection are not among them (I-CRED-2). */
export type ServiceFieldsInput = Partial<ServiceFields> & {
  /** `updated_at` the edit form was opened at; a newer stored version is a conflict. */
  expected_updated_at?: number;
};

/** The only keys updateServiceFields accepts; anything else (base_url, injection, slug, …) is refused. */
const UPDATABLE_FIELDS: ReadonlyArray<keyof ServiceFields> = [
  'name',
  'description',
  'forward_headers',
  'timeout_ms',
  'verify',
  'enabled',
  'credential_expires_at',
];
const INPUT_KEYS: readonly string[] = [...UPDATABLE_FIELDS, 'expected_updated_at'];

export async function updateServiceFields(
  deps: Deps,
  actor: Actor,
  serviceId: string,
  input: ServiceFieldsInput,
): Promise<{ ok: true; service: ServiceView; warnings: string[]; changed?: boolean } | OpFailure> {
  const rejected = Object.keys(input).filter((key) => !INPUT_KEYS.includes(key));
  if (rejected.length > 0) {
    return opFailure('invalid', [
      `${rejected.join(', ')} cannot be changed here; the destination and injection change only together with the credential (I-CRED-2)`,
    ]);
  }
  const flagErrors = booleanErrors('enabled', input.enabled);
  if (flagErrors.length > 0) return opFailure('invalid', flagErrors);
  const existing = await getService(deps.env.DB, serviceId);
  if (!existing) return opFailure('not_found', ['service not found']);
  const stale = staleEdit('the service', input.expected_updated_at, existing.updated_at);
  if (stale) return stale;
  const given = (UPDATABLE_FIELDS as readonly string[]).filter(
    (key) => input[key as keyof ServiceFieldsInput] !== undefined,
  );
  if (given.length === 1 && input.enabled === false) return disableService(deps, actor, existing);

  const next: ServiceFields = {
    name: input.name !== undefined ? trimmed(input.name) : existing.name,
    description:
      input.description !== undefined ? trimmed(input.description) : existing.description,
    forward_headers: input.forward_headers ?? existing.forward_headers,
    timeout_ms: input.timeout_ms ?? existing.timeout_ms,
    verify: input.verify !== undefined ? normalizeVerify(input.verify) : existing.verify,
    enabled: input.enabled ?? existing.enabled,
    credential_expires_at:
      input.credential_expires_at !== undefined
        ? input.credential_expires_at
        : existing.credential_expires_at,
  };
  const validation = validateServiceFields({
    slug: existing.slug,
    name: next.name,
    timeout_ms: next.timeout_ms,
    forward_headers: next.forward_headers,
    injection: existing.injection,
    verify: next.verify,
  });
  const errors = [
    ...validation.errors,
    ...descriptionErrors(next.description),
    ...timestampErrors('credential expiry', next.credential_expires_at),
  ];
  if (errors.length > 0) return opFailure('invalid', errors, validation.warnings);

  const changed = (Object.keys(next) as Array<keyof ServiceFields>).filter(
    (key) => canonicalJson(next[key]) !== canonicalJson(existing[key]),
  );
  // A save that changes nothing writes nothing: no audit row, no version bump.
  if (changed.length === 0 && input.enabled === undefined) {
    return {
      ok: true,
      service: serviceView(existing),
      warnings: validation.warnings,
      changed: false,
    };
  }
  // An enable/disable request is recorded as such even when the flag already had that value.
  const onlyEnabled = input.enabled !== undefined && changed.every((key) => key === 'enabled');
  const action = onlyEnabled
    ? next.enabled
      ? 'service.enable'
      : 'service.disable'
    : 'service.update';
  const now = deps.now();
  const guard = serviceVersionGuard(existing);
  const outcome = await commitOrConstraintFailure(
    deps,
    actor,
    {
      action,
      targetType: 'service',
      targetId: existing.id,
      summary: onlyEnabled
        ? `${next.enabled ? 'Enabled' : 'Disabled'} service ${existing.slug}`
        : `Updated service ${existing.slug}${changed.length ? ` (${changed.join(', ')})` : ''}`,
      diff: {
        before: pick(existing, changed),
        after: pick(next, changed),
      },
    },
    guard,
    [updateServiceFieldsStatement(deps.env.DB, existing.id, next, now, guard)],
  );
  if (!outcome.ok) return outcome;
  if (!outcome.committed) return concurrentChange('the service');
  return {
    ok: true,
    service: serviceView({
      ...existing,
      ...next,
      updated_at: nextVersion(existing.updated_at, now),
    }),
    warnings: validation.warnings,
    changed: true,
  };
}

/**
 * Disabling changes only `enabled` and skips validation, so a service whose stored row no longer
 * validates can still be switched off. Takes effect on the next proxied request.
 */
async function disableService(
  deps: Deps,
  actor: Actor,
  existing: Service,
): Promise<{ ok: true; service: ServiceView; warnings: string[] } | OpFailure> {
  const now = deps.now();
  const guard = serviceExistsGuard(existing.id);
  const outcome = await commitOrConstraintFailure(
    deps,
    actor,
    {
      action: 'service.disable',
      targetType: 'service',
      targetId: existing.id,
      summary: `Disabled service ${existing.slug}`,
      diff: { before: { enabled: existing.enabled }, after: { enabled: false } },
    },
    guard,
    [setServiceEnabledStatement(deps.env.DB, existing.id, false, now, guard)],
  );
  if (!outcome.ok) return outcome;
  if (!outcome.committed) return concurrentChange('the service');
  const service = {
    ...existing,
    enabled: false,
    updated_at: nextVersion(existing.updated_at, now),
  };
  return { ok: true, service: serviceView(service), warnings: [] };
}

// ---------------------------------------------------------------------------------------------
// Credential + destination

export interface ServiceCredentialInput {
  base_url: string;
  injection: unknown;
  secret: string;
  save_anyway?: boolean;
  /** Overrides the expiry; default: GitHub's reported expiry, else none. */
  credential_expires_at?: number | null;
  /**
   * Host of `base_url`, typed by the admin. Required when no credential is stored, or when the
   * stored credential does not open under the stored row: in both cases the stored destination
   * may have been written straight into D1, waiting for a credential (I-CRED-2).
   */
  confirm_destination?: string;
}

/** The validated parts of a credential change, before the check sends the secret. */
interface CredentialPlan {
  existing: Service;
  keyring: Keyring;
  base: string;
  injection: Injection;
  injectionJson: string;
  credential: { value: string; hint: string | null };
  host: string;
  /** Why the stored destination is not attested, or null when the stored secret opens. */
  unattested: OpenCredentialError | 'no_credential' | null;
  warnings: string[];
}

/**
 * Every check of a credential change that sends nothing and writes nothing, in the order of A7.4:
 * field formats and the secret format, then the allowlist (skipped with `hostAllowed`, for a route
 * that allows the host itself first), then the keyring, then the destination confirmation of an
 * unattested or absent binding (I-CRED-2).
 */
async function planCredential(
  deps: Pick<Deps, 'env'>,
  serviceId: string,
  input: ServiceCredentialInput,
  context: OpContext,
  options: { hostAllowed?: boolean },
): Promise<{ ok: true; plan: CredentialPlan } | OpFailure> {
  const existing = await getService(deps.env.DB, serviceId);
  if (!existing) return opFailure('not_found', ['service not found']);

  const errors: string[] = [];
  const base = validateBaseUrl(input.base_url, {
    gatewayHosts: await gatewayHosts(deps.env.DB, context),
    allowedUpstreamHosts: options.hostAllowed ? null : await getAllowedUpstreamHosts(deps.env.DB),
  });
  if (!base.ok) errors.push(base.error);
  const injection = normalizeInjection(input.injection);
  const fields = validateServiceFields({
    slug: existing.slug,
    name: existing.name,
    timeout_ms: existing.timeout_ms,
    forward_headers: existing.forward_headers,
    injection: input.injection as Injection,
    verify: existing.verify,
  });
  errors.push(...fields.errors);
  errors.push(...timestampErrors('credential expiry', input.credential_expires_at));
  const credential = injection.ok
    ? normalizeCredential(typeof input.secret === 'string' ? input.secret : '', injection.injection)
    : null;
  if (credential && !credential.ok) errors.push(credential.error);
  if (errors.length > 0 || !base.ok || !injection.ok || !credential?.ok) {
    return opFailure('invalid', serviceFieldErrors(errors), fields.warnings);
  }

  const keyring = await loadKeyring(deps.env);
  if (!keyring.ok) return keyringUnavailable(keyring.error);

  // Before the verify check, which sends the plaintext: a stored destination the credential does
  // not attest, or one with no credential at all, may be a D1 writer's repoint waiting for the
  // credential (I-CRED-2).
  const unattested = existing.credential_sealed
    ? await openStoredCredential(keyring.keyring, existing).then((opened) =>
        opened.ok ? null : opened.error,
      )
    : 'no_credential';
  const host = new URL(base.normalized).host;
  if (unattested !== null && !destinationConfirmed(input.confirm_destination, host)) {
    const why =
      unattested === 'no_credential'
        ? 'no credential is stored, so nothing attests the stored base URL and injection'
        : `the stored credential does not open under this service's stored base URL and injection (${unattested}); they may have been changed outside the admin UI`;
    return opFailure(
      'confirmation_required',
      [
        fieldError(
          'confirm_destination',
          `${why}. Check the base URL and injection against an out-of-band source, then type the destination host ${host} under "Confirm destination host"`,
        ),
      ],
      fields.warnings,
    );
  }
  return {
    ok: true,
    plan: {
      existing,
      keyring: keyring.keyring,
      base: base.normalized,
      injection: injection.injection,
      injectionJson: injection.json,
      credential: { value: credential.value, hint: credential.hint },
      host,
      unattested,
      warnings: fields.warnings,
    },
  };
}

/**
 * The checks of setServiceCredential that send nothing and write nothing (planCredential). The
 * destination route runs it before an owner's `allow_host` commits, so a destination that would be
 * refused anyway never changes the allowlist.
 */
export async function checkServiceCredential(
  deps: Pick<Deps, 'env'>,
  serviceId: string,
  input: ServiceCredentialInput,
  context: OpContext,
  options: { hostAllowed?: boolean } = {},
): Promise<{ ok: true; warnings: string[] } | OpFailure> {
  const planned = await planCredential(deps, serviceId, input, context, options);
  return planned.ok ? { ok: true, warnings: planned.plan.warnings } : planned;
}

/**
 * Replaces the credential and, optionally, the base URL and injection it is bound to. The new
 * value is sealed with the AAD of the new configuration and written with it in one statement,
 * compare-and-swap on the binding fields read here (I-CRED-2).
 */
export async function setServiceCredential(
  deps: Deps,
  actor: Actor,
  serviceId: string,
  input: ServiceCredentialInput,
  context: OpContext,
): Promise<CredentialOpResult> {
  const planned = await planCredential(deps, serviceId, input, context, {});
  if (!planned.ok) return planned;
  const { plan } = planned;
  const { existing, keyring, credential, unattested, host } = plan;

  const verify = existing.verify
    ? await runVerifyCheck(
        deps,
        {
          base_url: plan.base,
          injection: plan.injection,
          timeout_ms: existing.timeout_ms,
          verify: existing.verify,
        },
        credential.value,
      )
    : null;
  if (verify && !verify.passed && input.save_anyway !== true) {
    return verifyFailed(verify, plan.warnings);
  }

  const aad = credentialAad(existing.id, plan.base, plan.injectionJson);
  const sealed = await sealCredential(keyring, credential.value, aad, deps.random);
  const values = {
    base_url: plan.base,
    injection_json: plan.injectionJson,
    credential_sealed: sealed,
    credential_hint: credential.hint,
    credential_expires_at: input.credential_expires_at ?? verify?.expiresAt ?? null,
    template_id: templateIdFor(plan.base, plan.injectionJson),
  };
  const now = deps.now();
  const repointed =
    values.base_url !== existing.base_url || values.injection_json !== existing.injection_json;
  // Binding unchanged (compare-and-swap) and no concurrent field edit: forward_headers were
  // validated against the new injection above.
  const guard = allOf(serviceCredentialGuard(existing), serviceVersionGuard(existing));
  const outcome = await commitOrConstraintFailure(
    deps,
    actor,
    {
      action: 'service.credential.set',
      targetType: 'service',
      targetId: existing.id,
      summary: `${existing.credential_sealed ? 'Replaced' : 'Set'} credential of service ${existing.slug}${
        // An unattested stored row is no trustworthy "before": name the confirmed destination.
        unattested === 'no_credential'
          ? ` and set its destination to ${values.base_url} (confirmed)`
          : unattested !== null
            ? ` and set its destination to ${values.base_url} (confirmed; the stored destination was not attested: ${unattested})`
            : repointed
              ? ' and changed its destination'
              : ''
      }`,
      diff: {
        before: credentialAuditView(existing),
        after: credentialAuditView({
          ...values,
          injection: plan.injection,
          credential_updated_at: now,
        }),
        ...(unattested !== null && unattested !== 'no_credential'
          ? { stored_binding: { attested: false, error: unattested, confirmed_destination: host } }
          : unattested === 'no_credential'
            ? { stored_binding: { attested: false, confirmed_destination: host } }
            : {}),
        ...(verify ? { verify: verifyAuditView(verify) } : {}),
      },
    },
    guard,
    [
      updateServiceCredentialStatement(deps.env.DB, existing.id, values, now, guard),
      ...kcvStatements(deps, keyring, true, existing.id),
    ],
  );
  if (!outcome.ok) return outcome;
  if (!outcome.committed) return concurrentChange('the service credential');
  const service = serviceView({
    ...existing,
    ...values,
    injection: plan.injection,
    credential_updated_at: now,
    updated_at: nextVersion(existing.updated_at, now),
  });
  return { ok: true, service, verify, warnings: plan.warnings };
}

export interface ServiceRotateInput {
  secret: string;
  save_anyway?: boolean;
  /** Overrides the expiry; default: GitHub's reported expiry, else none. */
  credential_expires_at?: number | null;
  /** Ids of tokens to replace the same secret in (rotationSiblings), each re-checked here. */
  siblings?: readonly string[];
}

export type RotateResult =
  | (Extract<CredentialOpResult, { ok: true }> & {
      /** One entry per requested sibling, in request order. */
      siblings: Array<{ id: string; slug: string; ok: boolean; error?: string }>;
    })
  | (OpFailure & { verify?: VerifyOutcome });

/**
 * Replaces the secret of a token whose stored binding is attested, keeping its destination: the
 * base URL and injection come from the stored row, never from the form (I-CRED-2). Siblings are
 * replaced only after this token commits, each with its own op and audit row (I-AUDIT-1), and only
 * while it is still attested and holds the same secret this token held before.
 */
export async function rotateServiceSecret(
  deps: Deps,
  actor: Actor,
  serviceId: string,
  input: ServiceRotateInput,
  context: OpContext,
): Promise<RotateResult> {
  const existing = await getService(deps.env.DB, serviceId);
  if (!existing) return opFailure('not_found', ['service not found']);
  // The secret format first, against the stored injection (A7.4), then the keyring.
  const format = normalizeCredential(
    typeof input.secret === 'string' ? input.secret : '',
    existing.injection,
  );
  if (!format.ok) return opFailure('invalid', serviceFieldErrors([format.error]));
  const keyring = await loadKeyring(deps.env);
  if (!keyring.ok) return keyringUnavailable(keyring.error);
  const old = await openStoredCredential(keyring.keyring, existing);
  if (!old.ok) {
    return opFailure('confirmation_required', [
      fieldError(
        null,
        existing.credential_sealed === null
          ? 'no secret is stored yet; set it under Change destination, where you confirm the host'
          : `the stored secret does not open (${old.error}); set it under Change destination, where you confirm the host`,
      ),
    ]);
  }
  const main = await setServiceCredential(
    deps,
    actor,
    serviceId,
    {
      base_url: existing.base_url,
      injection: existing.injection,
      secret: input.secret,
      save_anyway: input.save_anyway,
      credential_expires_at: input.credential_expires_at,
    },
    context,
  );
  if (!main.ok) return main;
  const siblings: Array<{ id: string; slug: string; ok: boolean; error?: string }> = [];
  for (const siblingId of input.siblings ?? []) {
    if (siblingId === serviceId) continue;
    const sibling = await getService(deps.env.DB, siblingId);
    if (!sibling) {
      siblings.push({ id: siblingId, slug: siblingId, ok: false, error: 'not found' });
      continue;
    }
    if (!sameFamily(existing, sibling)) {
      siblings.push({ id: sibling.id, slug: sibling.slug, ok: false, error: 'another type' });
      continue;
    }
    const opened = await openStoredCredential(keyring.keyring, sibling);
    if (!opened.ok || opened.plaintext !== old.plaintext) {
      siblings.push({
        id: sibling.id,
        slug: sibling.slug,
        ok: false,
        error: opened.ok ? 'it holds another secret now' : 'its stored secret does not open',
      });
      continue;
    }
    const result = await setServiceCredential(
      deps,
      actor,
      sibling.id,
      {
        base_url: sibling.base_url,
        injection: sibling.injection,
        secret: input.secret,
        save_anyway: input.save_anyway,
        // The same secret expires at the same time.
        credential_expires_at: main.service.credential_expires_at,
      },
      context,
    );
    siblings.push(
      result.ok
        ? { id: sibling.id, slug: sibling.slug, ok: true }
        : { id: sibling.id, slug: sibling.slug, ok: false, error: result.errors.join('; ') },
    );
  }
  return { ...main, siblings };
}

/**
 * Tokens of the same template family (GitHub API and uploads) whose stored secret opens and equals
 * this token's: the rotate form offers to replace it there too. Compared in memory only; nothing
 * about the other secrets is returned.
 */
export async function rotationSiblings(
  deps: Pick<Deps, 'env'>,
  service: Service,
): Promise<Service[]> {
  if (familyOf(service) === null || service.credential_sealed === null) return [];
  const keyring = await loadKeyring(deps.env);
  if (!keyring.ok) return [];
  const own = await openStoredCredential(keyring.keyring, service);
  if (!own.ok) return [];
  const candidates = (await listServices(deps.env.DB)).filter(
    (other) =>
      other.id !== service.id && other.credential_sealed !== null && sameFamily(service, other),
  );
  const out: Service[] = [];
  for (const other of candidates) {
    const opened = await openStoredCredential(keyring.keyring, other);
    if (opened.ok && opened.plaintext === own.plaintext) out.push(other);
  }
  return out;
}

function familyOf(service: Pick<Service, 'template_id'>): string | null {
  const template = service.template_id === null ? null : getServiceTemplate(service.template_id);
  return template?.family ?? null;
}

function sameFamily(a: Pick<Service, 'template_id'>, b: Pick<Service, 'template_id'>): boolean {
  const family = familyOf(a);
  return family !== null && family === familyOf(b);
}

/** The latest audit row that set this token's secret: who and when, for display only. */
export async function lastSecretChange(
  db: D1Database,
  serviceId: string,
): Promise<{ ts: number; actor_email: string | null } | null> {
  return db
    .prepare(
      `SELECT ts, actor_email FROM audit_log WHERE target_id = ?
         AND (action = 'service.credential.set'
              OR (action = 'service.create' AND json_extract(diff, '$.after.credential_set') = 1))
       ORDER BY ts DESC, rowid DESC LIMIT 1`,
    )
    .bind(serviceId)
    .first<{ ts: number; actor_email: string | null }>();
}

/**
 * Runs the verify check with the stored credential. The 'service.credential.test' audit row,
 * with its actor check (I-SESS-1), commits before the request is sent: no request carries the
 * stored credential unless that audited, authority-checked write committed first (I-AUDIT-1).
 * The result goes to the `service.credential.test_result` log line, keyed by the audit row id.
 */
export async function testServiceCredential(
  deps: Deps,
  actor: Actor,
  serviceId: string,
  context: OpContext,
): Promise<{ ok: true; verify: VerifyOutcome; expirySaved: boolean } | OpFailure> {
  const service = await getService(deps.env.DB, serviceId);
  if (!service) return opFailure('not_found', ['service not found']);
  const check = service.verify;
  if (!check) return opFailure('invalid', ['this service has no verify check configured']);
  if (!service.credential_sealed) return opFailure('invalid', ['this service has no credential']);

  // Same use-time checks as the proxy: the stored row is not trusted (I-SSRF-1, I-CRED-2).
  const base = validateBaseUrl(service.base_url, {
    gatewayHosts: await gatewayHosts(deps.env.DB, context),
    allowedUpstreamHosts: await getAllowedUpstreamHosts(deps.env.DB),
  });
  if (!base.ok) return opFailure('unavailable', [`stored ${base.error}`]);
  const injection = normalizeInjection(service.injection);
  if (!injection.ok || injection.json !== service.injection_json) {
    return opFailure('unavailable', [
      'the stored injection is not valid; set the credential again',
    ]);
  }
  const keyring = await loadKeyring(deps.env);
  if (!keyring.ok) return keyringUnavailable(keyring.error);
  const secret = await openStoredCredential(keyring.keyring, service);
  if (!secret.ok) {
    return opFailure('unavailable', [`the stored credential cannot be opened (${secret.error})`]);
  }

  const outcome = await commitOrConstraintFailure(
    deps,
    actor,
    {
      action: 'service.credential.test',
      targetType: 'service',
      targetId: service.id,
      summary: `Tested credential of service ${service.slug} with ${check.method} ${check.path}`,
      diff: { base_url: service.base_url, verify: check },
    },
    null,
    [],
  );
  if (!outcome.ok) return outcome;

  const verify = await runVerifyCheck(
    deps,
    {
      base_url: service.base_url,
      injection: injection.injection,
      timeout_ms: service.timeout_ms,
      verify: check,
    },
    secret.plaintext,
  );
  console.info(
    JSON.stringify({
      type: 'service.credential.test_result',
      audit_id: outcome.event.id,
      service_id: service.id,
      ...verifyAuditView(verify),
    }),
  );
  // The upstream reports the secret's expiry (GitHub): keep the stored one current, as its own
  // audited change. A concurrent edit wins silently; the result still renders.
  let expirySaved = false;
  if (verify.expiresAt !== null && verify.expiresAt !== service.credential_expires_at) {
    const saved = await updateServiceFields(deps, actor, service.id, {
      credential_expires_at: verify.expiresAt,
      expected_updated_at: service.updated_at,
    });
    expirySaved = saved.ok && saved.changed === true;
  }
  return { ok: true, verify, expirySaved };
}

// ---------------------------------------------------------------------------------------------
// Delete

export interface ServiceDeleteOptions {
  /** Also delete the consumer access (grants) of the token: needs access:write too. */
  withAccesses?: boolean;
  /** The grant ids the admin confirmed; the delete applies only while they are exactly the set. */
  accessIds?: readonly string[];
}

/**
 * Deletes a token. While consumer access references it, it is refused unless `withAccesses` names
 * exactly the current set: then the accesses and the token go in one batch with one audit row
 * whose diff holds every deleted row (I-AUDIT-1), or nothing goes (a 409 when the set changed).
 */
export async function deleteService(
  deps: Deps,
  actor: Actor,
  serviceId: string,
  options: ServiceDeleteOptions = {},
): Promise<{ ok: true; deletedAccesses: number } | (OpFailure & { accesses?: Grant[] })> {
  const db = deps.env.DB;
  const existing = await getService(db, serviceId);
  if (!existing) return opFailure('not_found', ['service not found']);
  const grants = await listGrants(db, { service_id: serviceId });
  if (grants.length > 0 && options.withAccesses !== true) return referencedBy(grants);
  if (grants.length > 0 && !actorMayDeleteAccess(actor)) {
    return opFailure('conflict', [
      'deleting consumer access needs a role that also manages consumer access; nothing was deleted',
    ]);
  }
  const ids = grants.map((grant) => grant.id).sort();
  const confirmed = [...new Set(options.accessIds ?? [])].sort();
  if (grants.length > 0 && JSON.stringify(ids) !== JSON.stringify(confirmed)) {
    return accessSetChanged(grants);
  }

  // The audit row and the grant delete see the same state, so both apply or neither does. After
  // the grants are gone the token goes only if no grant references it any more.
  const guard =
    grants.length > 0
      ? allOf(serviceExistsGuard(serviceId), exactGrantSetGuard('service_id', serviceId, ids))
      : serviceUnreferencedGuard(serviceId);
  const view = serviceView(existing);
  const outcome = await commitOrConstraintFailure(
    deps,
    actor,
    {
      action: 'service.delete',
      targetType: 'service',
      targetId: serviceId,
      summary:
        grants.length > 0
          ? `Deleted service ${existing.slug} and its ${grants.length} consumer access${grants.length === 1 ? '' : 'es'}`
          : `Deleted service ${existing.slug}`,
      diff: { before: grants.length > 0 ? { ...view, accesses: grants } : view },
    },
    guard,
    [
      ...(grants.length > 0 ? [deleteGrantsByIdsStatement(db, ids, guard)] : []),
      deleteServiceStatement(db, serviceId, serviceUnreferencedGuard(serviceId)),
    ],
  );
  if (!outcome.ok) return outcome;
  if (!outcome.committed) {
    const current = await listGrants(db, { service_id: serviceId });
    if (grants.length > 0 || current.length > 0) {
      return options.withAccesses === true ? accessSetChanged(current) : referencedBy(current);
    }
    return concurrentChange('the service');
  }
  return { ok: true, deletedAccesses: grants.length };
}

/** The admin route passes access:write as a field permission; an op caller must hold it too. */
function actorMayDeleteAccess(actor: Actor): boolean {
  const authority = (actor as { authority?: { permissions?: readonly string[] } }).authority;
  return authority === undefined || (authority.permissions ?? []).includes('access:write');
}

function referencedBy(grants: Grant[]): OpFailure & { accesses: Grant[] } {
  const names = grants.map((grant) => JSON.stringify(grant.name)).join(', ');
  return {
    ...opFailure('conflict', [
      `the service is used by ${grants.length} consumer access${grants.length === 1 ? '' : 'es'}: ${names}; delete them first`,
    ]),
    accesses: grants,
  };
}

function accessSetChanged(grants: Grant[]): OpFailure & { accesses: Grant[] } {
  return {
    ...opFailure('conflict', [
      `the consumer access of this token changed since the page was loaded; nothing was deleted. Check the ${grants.length} listed now and confirm again`,
    ]),
    accesses: grants,
  };
}

// ---------------------------------------------------------------------------------------------
// Stored credential

/** Opens a stored credential with the AAD of the row as stored. */
export function openStoredCredential(
  keyring: Keyring,
  service: Pick<Service, 'id' | 'base_url' | 'injection_json' | 'credential_sealed'>,
): ReturnType<typeof openCredential> {
  if (service.credential_sealed === null) {
    return Promise.resolve({ ok: false, error: 'sealed_malformed' });
  }
  const aad = credentialAad(service.id, service.base_url, service.injection_json);
  return openCredential(keyring, service.credential_sealed, aad);
}

/** State of a service's stored binding, for the service page (I-CRED-2). */
export type StoredBinding =
  | { status: 'none' }
  /** The stored credential opens: base_url and injection are as the admin ops last sealed them. */
  | { status: 'attested' }
  | {
      status: 'unattested';
      error: OpenCredentialError;
      /**
       * For credential_binding_mismatch: whether the key behind the kid differs from the one
       * recorded at seal time (null: nothing recorded). false means the row itself was edited.
       */
      keyChanged: boolean | null;
    };

export async function storedBinding(
  db: D1Database,
  keyring: Keyring,
  service: Pick<Service, 'id' | 'base_url' | 'injection_json' | 'credential_sealed'>,
): Promise<StoredBinding> {
  if (service.credential_sealed === null) return { status: 'none' };
  const opened = await openStoredCredential(keyring, service);
  if (opened.ok) return { status: 'attested' };
  if (opened.error !== 'credential_binding_mismatch') {
    return { status: 'unattested', error: opened.error, keyChanged: null };
  }
  const kid = sealedKid(service.credential_sealed);
  const recorded = kid ? (await getState<Record<string, unknown>>(db, 'keyring_kcv'))?.[kid] : null;
  const keyChanged = typeof recorded === 'string' && kid ? recorded !== keyring.kcv[kid] : null;
  return { status: 'unattested', error: opened.error, keyChanged };
}

/** The admin typed the host of the submitted base URL (case-insensitive, surrounding space ignored). */
function destinationConfirmed(typed: string | undefined, host: string): boolean {
  return typeof typed === 'string' && typed.trim().toLowerCase() === host.toLowerCase();
}

// ---------------------------------------------------------------------------------------------
// Helpers

/**
 * The verify check reduced to its fields; `expect_ok_field: false` is the default and dropped.
 * Values of other types pass through so validateServiceFields reports them.
 */
function normalizeVerify(verify: unknown): VerifyCheck | null {
  if (verify === null || verify === undefined) return null;
  if (typeof verify !== 'object' || Array.isArray(verify)) return verify as VerifyCheck;
  const { method, path, expect_status, expect_ok_field, headers } = verify as VerifyCheck;
  const out: VerifyCheck = { method, path, expect_status };
  if (expect_ok_field !== undefined && expect_ok_field !== false) {
    out.expect_ok_field = expect_ok_field;
  }
  // Template check headers (validated by validateServiceFields); an empty set is dropped.
  if (headers !== undefined && !(isPlainObject(headers) && Object.keys(headers).length === 0)) {
    out.headers = headers;
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function keyringUnavailable(error: string): OpFailure {
  return opFailure('unavailable', [
    `credentials cannot be stored or used: keyring problem "${error}" (check TOKENGATE_KEK / TOKENGATE_KEYRING)`,
  ]);
}

function verifyFailed(
  verify: VerifyOutcome,
  warnings: string[],
): OpFailure & { verify: VerifyOutcome } {
  return {
    ...opFailure(
      'verify_failed',
      [`credential check failed: ${verify.error ?? 'unknown error'}`],
      warnings,
    ),
    verify,
  };
}

/** Audit form of a verify outcome: status and result only (the body preview stays out). */
function verifyAuditView(verify: VerifyOutcome): Record<string, unknown> {
  return { status: verify.status, passed: verify.passed, error: verify.error };
}

/** Audit form of the credential binding: destination, injection, hint and key id. */
function credentialAuditView(service: {
  base_url: string;
  injection: Injection;
  credential_sealed: string | null;
  credential_hint: string | null;
  credential_updated_at: number | null;
  credential_expires_at: number | null;
}): Record<string, unknown> {
  return {
    base_url: service.base_url,
    injection: service.injection,
    credential_hint: service.credential_hint,
    credential_kid: sealedKid(service.credential_sealed),
    credential_updated_at: service.credential_updated_at,
    credential_expires_at: service.credential_expires_at,
  };
}

/**
 * Key check value of the key that sealed, for detecting a KEK replaced under the same kid. Never
 * overwrites a different value recorded while other credentials use the kid (see the statement).
 */
function kcvStatements(
  deps: Pick<Deps, 'env' | 'now'>,
  keyring: Keyring | null,
  sealed: boolean,
  serviceId: string,
): D1PreparedStatement[] {
  const kcv = keyring?.kcv[keyring.activeKid];
  if (!sealed || !keyring || !kcv) return [];
  return [recordKeyCheckValueStatement(deps.env.DB, keyring.activeKid, kcv, deps.now(), serviceId)];
}
