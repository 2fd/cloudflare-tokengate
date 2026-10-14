// Parses TOKENGATE_KEK / TOKENGATE_KEYRING into non-extractable AES-256-GCM key-encryption keys,
// failing closed with a named error. Each key is bound to the login variables (I-CRED-3): the AES
// key is HKDF-SHA256 of the secret with the AUTH_ACCESS_* values as info, so changing any of them
// makes every stored credential impossible to open. Has no value imports so scripts/keyring.ts can
// load this file under Node type stripping and validate a keyring exactly like the Worker does.

export type KeyringError =
  | 'keyring_absent'
  | 'keyring_malformed'
  | 'active_kid_missing'
  | 'key_not_32_bytes'
  | 'both_kek_and_keyring_set'
  | 'dev_placeholder_key';

/** The variables a keyring reads: the secrets and the login variables its keys are bound to. */
export interface KeyringEnv {
  TOKENGATE_KEK?: string;
  TOKENGATE_KEYRING?: string;
  AUTH_ACCESS_TEAM_DOMAIN?: string;
  AUTH_ACCESS_AUD?: string;
  AUTH_ACCESS_DEVELOPMENT?: string;
}

export interface Keyring {
  /** Key id used for new seals. */
  activeKid: string;
  /** All key ids, sorted. */
  kids: string[];
  /** kid → key check value (see keyCheckValue). Safe to display. */
  kcv: Record<string, string>;
  /** Non-extractable AES-GCM key for `kid`, usages encrypt/decrypt. */
  key(kid: string): CryptoKey | undefined;
}

export type LoadKeyringResult = { ok: true; keyring: Keyring } | { ok: false; error: KeyringError };

/** Kid assigned to a bare TOKENGATE_KEK. */
export const SHORTHAND_KID = 'k1';

/** Key ids appear in sealed blobs, logs and the admin UI, so they use a small closed alphabet. */
export const KID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const KEY_BYTES = 32;
const KCV_LABEL = 'tokengate/v1/kek-check';
const BINDING_LABEL = 'tokengate/v1/kek-binding';
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * TOKENGATE_KEK in .dev.vars.example: base64 of "DEV-ONLY-KEY-NOT-FOR-PRODUCTION!". Accepted only
 * in development mode (AUTH_ACCESS_DEVELOPMENT set, no Access variable), in any keyring slot.
 */
export const DEV_PLACEHOLDER_KEK = 'REVWLU9OTFktS0VZLU5PVC1GT1ItUFJPRFVDVElPTiE=';

let cache: { id: string; result: Promise<LoadKeyringResult> } | null = null;

/**
 * Loads the keyring from the Worker secrets. Exactly one of TOKENGATE_KEK (standard base64 of
 * 32 bytes, kid "k1") or TOKENGATE_KEYRING (JSON `{"active":"k2","keys":{"k1":"<b64>","k2":"<b64>"}}`)
 * must be set; empty or whitespace-only values count as absent.
 * Check order: presence, JSON shape and kid syntax, active kid present, each key 32 bytes, no
 * development placeholder outside development mode. Every key is then bound to the login
 * variables (`kekBindingInfo`). The last result is cached per isolate, keyed by all inputs.
 */
export function loadKeyring(env: KeyringEnv): Promise<LoadKeyringResult> {
  const kek = env.TOKENGATE_KEK ?? '';
  const keyring = env.TOKENGATE_KEYRING ?? '';
  const info = kekBindingInfo(env);
  const id = JSON.stringify([kek, keyring, info]);
  if (cache && cache.id === id) return cache.result;
  const result = parseAndImport(kek, keyring, info, developmentMode(env));
  cache = { id, result };
  return result;
}

/**
 * HKDF info binding the keys to the login variables (I-CRED-3). Values are trimmed, nothing
 * else: any other change to AUTH_ACCESS_TEAM_DOMAIN, AUTH_ACCESS_AUD or AUTH_ACCESS_DEVELOPMENT
 * (setting, removing or rewriting one) yields different keys.
 */
export function kekBindingInfo(env: KeyringEnv): string {
  const values = [env.AUTH_ACCESS_TEAM_DOMAIN, env.AUTH_ACCESS_AUD, env.AUTH_ACCESS_DEVELOPMENT];
  return `${BINDING_LABEL}\n${JSON.stringify(values.map((value) => value?.trim() ?? ''))}`;
}

/** AUTH_ACCESS_DEVELOPMENT set and no Access variable (config.ts turns off any other mix). */
function developmentMode(env: KeyringEnv): boolean {
  const set = (value: string | undefined) => (value?.trim() ?? '') !== '';
  return (
    set(env.AUTH_ACCESS_DEVELOPMENT) &&
    !set(env.AUTH_ACCESS_TEAM_DOMAIN) &&
    !set(env.AUTH_ACCESS_AUD)
  );
}

/** The 32-byte AES key for a secret key under a binding: HKDF-SHA256, empty salt. */
export async function boundKey(rawKey: Uint8Array, info: string): Promise<Uint8Array<ArrayBuffer>> {
  const ikm = await crypto.subtle.importKey('raw', new Uint8Array(rawKey), 'HKDF', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: new TextEncoder().encode(info),
    },
    ikm,
    KEY_BYTES * 8,
  );
  return new Uint8Array(bits);
}

/**
 * Hex of the first 8 bytes of HMAC-SHA256(key, "tokengate/v1/kek-check"). Identifies a key
 * without revealing it. The keyring passes the bound key, so a change of the login variables
 * shows as a changed key check value.
 */
export async function keyCheckValue(rawKey: Uint8Array): Promise<string> {
  const hmacKey = await crypto.subtle.importKey(
    'raw',
    new Uint8Array(rawKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign('HMAC', hmacKey, new TextEncoder().encode(KCV_LABEL)),
  );
  let hex = '';
  for (const byte of mac.subarray(0, 8)) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

async function parseAndImport(
  kekSecret: string,
  keyringSecret: string,
  bindingInfo: string,
  development: boolean,
): Promise<LoadKeyringResult> {
  const parsed = parseSecrets(kekSecret.trim(), keyringSecret.trim());
  if (!parsed.ok) return parsed;
  if (!development) {
    const placeholder = decodeKey(DEV_PLACEHOLDER_KEK) as Uint8Array;
    for (const raw of parsed.rawKeys.values()) {
      if (raw.every((byte, i) => byte === placeholder[i])) {
        return { ok: false, error: 'dev_placeholder_key' };
      }
    }
  }

  const kids = [...parsed.rawKeys.keys()].sort();
  const keys = new Map<string, CryptoKey>();
  // Null prototype: `kcv["constructor"]` must be undefined, like any other unknown kid.
  const kcv: Record<string, string> = Object.create(null);
  for (const kid of kids) {
    const bound = await boundKey(parsed.rawKeys.get(kid) as Uint8Array, bindingInfo);
    kcv[kid] = await keyCheckValue(bound);
    keys.set(
      kid,
      await crypto.subtle.importKey('raw', bound, 'AES-GCM', false, ['encrypt', 'decrypt']),
    );
  }
  const keyring: Keyring = {
    activeKid: parsed.activeKid,
    kids: Object.freeze(kids) as string[],
    kcv: Object.freeze(kcv),
    key: (kid) => keys.get(kid),
  };
  return { ok: true, keyring: Object.freeze(keyring) };
}

type ParsedSecrets =
  | { ok: true; activeKid: string; rawKeys: Map<string, Uint8Array<ArrayBuffer>> }
  | { ok: false; error: KeyringError };

function parseSecrets(kek: string, keyringJson: string): ParsedSecrets {
  if (kek !== '' && keyringJson !== '') return { ok: false, error: 'both_kek_and_keyring_set' };
  if (kek === '' && keyringJson === '') return { ok: false, error: 'keyring_absent' };

  if (kek !== '') {
    const raw = decodeKey(kek);
    if (typeof raw === 'string') return { ok: false, error: raw };
    return { ok: true, activeKid: SHORTHAND_KID, rawKeys: new Map([[SHORTHAND_KID, raw]]) };
  }

  let doc: unknown;
  try {
    doc = JSON.parse(keyringJson);
  } catch {
    return { ok: false, error: 'keyring_malformed' };
  }
  if (!isPlainObject(doc) || !hasExactlyKeys(doc, ['active', 'keys'])) {
    return { ok: false, error: 'keyring_malformed' };
  }
  const { active, keys } = doc;
  if (typeof active !== 'string' || !KID_PATTERN.test(active) || !isPlainObject(keys)) {
    return { ok: false, error: 'keyring_malformed' };
  }
  const entries = Object.entries(keys);
  for (const [kid, value] of entries) {
    if (!KID_PATTERN.test(kid) || typeof value !== 'string') {
      return { ok: false, error: 'keyring_malformed' };
    }
  }
  if (!Object.hasOwn(keys, active)) return { ok: false, error: 'active_kid_missing' };

  const rawKeys = new Map<string, Uint8Array<ArrayBuffer>>();
  for (const [kid, value] of entries) {
    const raw = decodeKey((value as string).trim());
    if (typeof raw === 'string') return { ok: false, error: raw };
    rawKeys.set(kid, raw);
  }
  return { ok: true, activeKid: active, rawKeys };
}

/** Strict standard base64 (padding optional) of exactly 32 bytes. */
function decodeKey(
  text: string,
): Uint8Array<ArrayBuffer> | 'keyring_malformed' | 'key_not_32_bytes' {
  if (!BASE64_PATTERN.test(text)) return 'keyring_malformed';
  let binary: string;
  try {
    binary = atob(text);
  } catch {
    return 'keyring_malformed';
  }
  if (binary.length !== KEY_BYTES) return 'key_not_32_bytes';
  const bytes = new Uint8Array(KEY_BYTES);
  for (let i = 0; i < KEY_BYTES; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactlyKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}
