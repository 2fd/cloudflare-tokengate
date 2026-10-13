// Service mutations for the admin UI. base_url and injection change only together with a newly
// entered credential, sealed with AAD over (id, base_url, injection) (I-CRED-2); plaintext never
// reaches results, audit diffs or logs (I-CRED-1); each change writes one audit row (I-AUDIT-1).
import { parseConfig } from '../../config';
import {
  credentialAad,
  type OpenCredentialError,
  openCredential,
  sealCredential,
  sealedKid,
} from '../../crypto/envelope';
import { type Keyring, loadKeyring } from '../../crypto/keyring';
import { listGrants } from '../../db/grants';
import {
  deleteServiceStatement,
  getService,
  insertServiceStatement,
  type ServiceFields,
  serviceCredentialGuard,
  serviceExistsGuard,
  serviceUnreferencedGuard,
  serviceVersionGuard,
  setServiceEnabledStatement,
  updateServiceCredentialStatement,
  updateServiceFieldsStatement,
} from '../../db/services';
import { getState, recordKeyCheckValueStatement } from '../../db/settings';
import type { Actor, Service } from '../../db/types';
import type { Deps } from '../../deps';
import type { AppEnv } from '../../env';
import { newId } from '../../lib/ids';
import { canonicalJson } from '../../lib/json';
import type { Injection, VerifyCheck } from '../../policy/types';
import {
  normalizeCredential,
  normalizeInjection,
  validateBaseUrl,
  validateServiceFields,
} from '../../policy/validate';
import {
  allOf,
  booleanErrors,
  commitOrConstraintFailure,
  concurrentChange,
  descriptionErrors,
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
  /** Host of this gateway (PUBLIC_URL host, else the request host); base URLs may not point at it. */
  publicHost: string | null;
}

/** PUBLIC_URL host when configured, otherwise the host of the current request. */
export function opContextFor(env: AppEnv, requestUrl: URL): OpContext {
  return { publicHost: parseConfig(env).publicUrl?.host ?? requestUrl.host };
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

export async function createService(
  deps: Deps,
  actor: Actor,
  input: ServiceCreateInput,
  context: OpContext,
): Promise<CredentialOpResult> {
  const errors: string[] = [];
  const base = validateBaseUrl(input.base_url, {
    publicHost: context.publicHost,
    allowedUpstreamHosts: parseConfig(deps.env).allowedUpstreamHosts,
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
    return opFailure('invalid', errors, fields.warnings);
  }

  const now = deps.now();
  const id = newId('svc', now, deps.random);
  let sealed: { sealed: string; hint: string | null; verify: VerifyOutcome | null } | null = null;
  let sealingKeyring: Keyring | null = null;
  if (credential) {
    const keyring = await loadKeyring(deps.env);
    if (!keyring.ok) return keyringUnavailable(keyring.error);
    sealingKeyring = keyring.keyring;
    const outcome = verify
      ? await runVerifyCheck(
          deps,
          {
            base_url: base.normalized,
            injection: injection.injection,
            timeout_ms: input.timeout_ms ?? DEFAULT_TIMEOUT_MS,
            verify,
          },
          credential.value,
        )
      : null;
    if (outcome && !outcome.passed && input.save_anyway !== true) {
      return verifyFailed(outcome, fields.warnings);
    }
    const aad = credentialAad(id, base.normalized, injection.json);
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
    base_url: base.normalized,
    injection_json: injection.json,
    forward_headers: input.forward_headers ?? [],
    timeout_ms: input.timeout_ms ?? DEFAULT_TIMEOUT_MS,
    credential_sealed: sealed?.sealed ?? null,
    credential_hint: sealed?.hint ?? null,
    credential_updated_at: sealed ? now : null,
    credential_expires_at: input.credential_expires_at ?? sealed?.verify?.expiresAt ?? null,
    verify,
    enabled: input.enabled ?? true,
    created_at: now,
  };
  const after = serviceView({
    ...row,
    injection: injection.injection,
    updated_at: now,
  });
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
  return { ok: true, service: after, verify: sealed?.verify ?? null, warnings: fields.warnings };
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
   * Host of `base_url`, typed by the admin. Required when the stored credential does not open
   * under the stored row: its destination may have been changed in D1 (I-CRED-2).
   */
  confirm_destination?: string;
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
  const existing = await getService(deps.env.DB, serviceId);
  if (!existing) return opFailure('not_found', ['service not found']);

  const errors: string[] = [];
  const base = validateBaseUrl(input.base_url, {
    publicHost: context.publicHost,
    allowedUpstreamHosts: parseConfig(deps.env).allowedUpstreamHosts,
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
    return opFailure('invalid', errors, fields.warnings);
  }

  const keyring = await loadKeyring(deps.env);
  if (!keyring.ok) return keyringUnavailable(keyring.error);

  // Before the verify check, which sends the plaintext: a stored destination the credential does
  // not attest may be a D1 writer's repoint waiting for the credential (I-CRED-2).
  const unattested = existing.credential_sealed
    ? await openStoredCredential(keyring.keyring, existing).then((opened) =>
        opened.ok ? null : opened.error,
      )
    : null;
  const host = new URL(base.normalized).host;
  if (unattested !== null && !destinationConfirmed(input.confirm_destination, host)) {
    return opFailure(
      'confirmation_required',
      [
        `the stored credential does not open under this service's stored base URL and injection (${unattested}); they may have been changed outside the admin UI. Check the base URL and injection against an out-of-band source, then type the destination host ${host} under "Confirm destination host"`,
      ],
      fields.warnings,
    );
  }

  const verify = existing.verify
    ? await runVerifyCheck(
        deps,
        {
          base_url: base.normalized,
          injection: injection.injection,
          timeout_ms: existing.timeout_ms,
          verify: existing.verify,
        },
        credential.value,
      )
    : null;
  if (verify && !verify.passed && input.save_anyway !== true) {
    return verifyFailed(verify, fields.warnings);
  }

  const aad = credentialAad(existing.id, base.normalized, injection.json);
  const sealed = await sealCredential(keyring.keyring, credential.value, aad, deps.random);
  const values = {
    base_url: base.normalized,
    injection_json: injection.json,
    credential_sealed: sealed,
    credential_hint: credential.hint,
    credential_expires_at: input.credential_expires_at ?? verify?.expiresAt ?? null,
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
        unattested !== null
          ? ` and set its destination to ${values.base_url} (confirmed; the stored destination was not attested: ${unattested})`
          : repointed
            ? ' and changed its destination'
            : ''
      }`,
      diff: {
        before: credentialAuditView(existing),
        after: credentialAuditView({
          ...values,
          injection: injection.injection,
          credential_updated_at: now,
        }),
        ...(unattested !== null
          ? { stored_binding: { attested: false, error: unattested, confirmed_destination: host } }
          : {}),
        ...(verify ? { verify: verifyAuditView(verify) } : {}),
      },
    },
    guard,
    [
      updateServiceCredentialStatement(deps.env.DB, existing.id, values, now, guard),
      ...kcvStatements(deps, keyring.keyring, true, existing.id),
    ],
  );
  if (!outcome.ok) return outcome;
  if (!outcome.committed) return concurrentChange('the service credential');
  const service = serviceView({
    ...existing,
    ...values,
    injection: injection.injection,
    credential_updated_at: now,
    updated_at: nextVersion(existing.updated_at, now),
  });
  return { ok: true, service, verify, warnings: fields.warnings };
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
): Promise<{ ok: true; verify: VerifyOutcome } | OpFailure> {
  const service = await getService(deps.env.DB, serviceId);
  if (!service) return opFailure('not_found', ['service not found']);
  const check = service.verify;
  if (!check) return opFailure('invalid', ['this service has no verify check configured']);
  if (!service.credential_sealed) return opFailure('invalid', ['this service has no credential']);

  // Same use-time checks as the proxy: the stored row is not trusted (I-SSRF-1, I-CRED-2).
  const base = validateBaseUrl(service.base_url, {
    publicHost: context.publicHost,
    allowedUpstreamHosts: parseConfig(deps.env).allowedUpstreamHosts,
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
  return { ok: true, verify };
}

// ---------------------------------------------------------------------------------------------
// Delete

/** Refused (conflict) while grants reference the service. The audit row keeps the full config. */
export async function deleteService(
  deps: Deps,
  actor: Actor,
  serviceId: string,
): Promise<{ ok: true } | OpFailure> {
  const db = deps.env.DB;
  const existing = await getService(db, serviceId);
  if (!existing) return opFailure('not_found', ['service not found']);
  const grants = await listGrants(db, { service_id: serviceId });
  if (grants.length > 0) return referencedBy(grants);

  const guard = serviceUnreferencedGuard(serviceId);
  const outcome = await commitOrConstraintFailure(
    deps,
    actor,
    {
      action: 'service.delete',
      targetType: 'service',
      targetId: serviceId,
      summary: `Deleted service ${existing.slug}`,
      diff: { before: serviceView(existing) },
    },
    guard,
    [deleteServiceStatement(db, serviceId, guard)],
  );
  if (!outcome.ok) return outcome;
  if (!outcome.committed) {
    const current = await listGrants(db, { service_id: serviceId });
    return current.length > 0 ? referencedBy(current) : concurrentChange('the service');
  }
  return { ok: true };
}

function referencedBy(grants: Array<{ name: string }>): OpFailure {
  const names = grants.map((grant) => JSON.stringify(grant.name)).join(', ');
  return opFailure('conflict', [
    `the service is used by ${grants.length} grant(s): ${names}; delete them first`,
  ]);
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
  const { method, path, expect_status, expect_ok_field } = verify as VerifyCheck;
  const out: VerifyCheck = { method, path, expect_status };
  if (expect_ok_field !== undefined && expect_ok_field !== false) {
    out.expect_ok_field = expect_ok_field;
  }
  return out;
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
