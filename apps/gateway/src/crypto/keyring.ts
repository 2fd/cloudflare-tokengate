// Parses TOKENGATE_KEK (the current key) and TOKENGATE_KEYRING (the next key, during a rotation)
// into non-extractable AES-256-GCM key-encryption keys, failing closed with a named error (ADR
// 0028). Each key is bound to the login variables (I-CRED-3): the AES key is HKDF-SHA256 of the
// secret with the AUTH_ACCESS_* values as info, so changing any of them makes every stored
// credential impossible to open. A key's id is its key check value, so a key keeps its id when it
// moves from one secret to the other. Has no value imports so scripts/keyring.ts can load this
// file under Node type stripping and validate a key exactly like the Worker does.

export type KeyringError =
  | 'keyring_absent'
  | 'keyring_malformed'
  | 'key_not_32_bytes'
  | 'key_not_random'
  | 'dev_placeholder_key';

/**
 * TOKENGATE_KEYRING: `absent`; `ready` (a new key, active); `same` (the value of TOKENGATE_KEK);
 * or why it is not used: not base64, not 32 bytes, the public development key, or not random.
 */
export type NextKeyStatus =
  | 'absent'
  | 'ready'
  | 'same'
  | 'malformed'
  | 'not_32_bytes'
  | 'dev_placeholder'
  | 'not_random';

/** The variables a keyring reads: the secrets and the login variables its keys are bound to. */
export interface KeyringEnv {
  TOKENGATE_KEK?: string;
  TOKENGATE_KEYRING?: string;
  AUTH_ACCESS_TEAM_DOMAIN?: string;
  AUTH_ACCESS_AUD?: string;
  AUTH_ACCESS_DEVELOPMENT?: string;
}

export interface Keyring {
  /** Key id used for new seals: the next key when it is ready, else the current key. */
  activeKid: string;
  /** Loaded key ids (key check values), sorted. The legacy id `k1` is not listed. */
  kids: string[];
  /** Key id → key check value, `k1` included. Safe to display. */
  kcv: Record<string, string>;
  /** Non-extractable AES-GCM key for `kid` (`k1` included), usages encrypt/decrypt. */
  key(kid: string): CryptoKey | undefined;
  /** The loaded key id a sealed kid refers to (`k1` → TOKENGATE_KEK), or null. */
  resolve(kid: string): string | null;
  /** Key id of TOKENGATE_KEK; null when only TOKENGATE_KEYRING is set. */
  currentKid: string | null;
  /** State of TOKENGATE_KEYRING. */
  next: NextKeyStatus;
  /** Key id of TOKENGATE_KEYRING when `ready` or `same`. */
  nextKid: string | null;
}

export type LoadKeyringResult = { ok: true; keyring: Keyring } | { ok: false; error: KeyringError };

/** Id that sealed values from before ADR 0027 use for TOKENGATE_KEK. */
export const LEGACY_KID = 'k1';

/** Key ids appear in sealed blobs, logs and the admin UI, so they use a small closed alphabet. */
export const KID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const KEY_BYTES = 32;
/** A random 32-byte key has about 30 distinct byte values; fewer than this is not random. */
const MIN_DISTINCT_BYTES = 16;
const KCV_LABEL = 'tokengate/v1/kek-check';
const BINDING_LABEL = 'tokengate/v1/kek-binding';
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * TOKENGATE_KEK in .dev.vars.example: base64 of "DEV-ONLY-KEY-NOT-FOR-PRODUCTION!". Accepted as
 * TOKENGATE_KEK only in development mode (AUTH_ACCESS_DEVELOPMENT set, no Access variable), never
 * as TOKENGATE_KEYRING.
 */
export const DEV_PLACEHOLDER_KEK = 'REVWLU9OTFktS0VZLU5PVC1GT1ItUFJPRFVDVElPTiE=';

let cache: { id: string; result: Promise<LoadKeyringResult> } | null = null;

/**
 * Loads the keyring from the Worker secrets; empty or whitespace-only values count as absent.
 * TOKENGATE_KEK must be standard base64 of 32 bytes, and not the development key outside
 * development mode. TOKENGATE_KEYRING is used only when it also passes checkNextKey; otherwise
 * it is ignored and reported in `next`. Without TOKENGATE_KEK, TOKENGATE_KEYRING is the only key
 * and must pass the same checks. Every key is bound to the login variables (`kekBindingInfo`).
 * The last result is cached per isolate, keyed by all inputs.
 */
export function loadKeyring(env: KeyringEnv): Promise<LoadKeyringResult> {
  const kek = env.TOKENGATE_KEK ?? '';
  const keyring = env.TOKENGATE_KEYRING ?? '';
  const info = kekBindingInfo(env);
  const id = JSON.stringify([kek, keyring, info]);
  if (cache && cache.id === id) return cache.result;
  const result = parseAndImport(kek.trim(), keyring.trim(), info, developmentMode(env));
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

/**
 * Why a value cannot be the next key, or null when it can: standard base64 of exactly 32 bytes,
 * not the public development key, not printable text (a passphrase, not random bytes) and at
 * least MIN_DISTINCT_BYTES distinct byte values. A random key fails the last two with a
 * probability below 1e-13.
 */
export function checkNextKey(
  text: string,
): Exclude<NextKeyStatus, 'absent' | 'ready' | 'same'> | null {
  const raw = decodeKey(text);
  if (raw === 'keyring_malformed') return 'malformed';
  if (raw === 'key_not_32_bytes') return 'not_32_bytes';
  if (isDevPlaceholder(raw)) return 'dev_placeholder';
  if (raw.every((byte) => byte >= 0x20 && byte <= 0x7e)) return 'not_random';
  if (new Set(raw).size < MIN_DISTINCT_BYTES) return 'not_random';
  return null;
}

const NEXT_KEY_ERROR: Readonly<
  Record<Exclude<NextKeyStatus, 'absent' | 'ready' | 'same'>, KeyringError>
> = {
  malformed: 'keyring_malformed',
  not_32_bytes: 'key_not_32_bytes',
  dev_placeholder: 'dev_placeholder_key',
  not_random: 'key_not_random',
};

async function parseAndImport(
  kekSecret: string,
  nextSecret: string,
  bindingInfo: string,
  development: boolean,
): Promise<LoadKeyringResult> {
  if (kekSecret === '' && nextSecret === '') return { ok: false, error: 'keyring_absent' };

  let current: Uint8Array<ArrayBuffer> | null = null;
  if (kekSecret !== '') {
    const raw = decodeKey(kekSecret);
    if (typeof raw === 'string') return { ok: false, error: raw };
    if (!development && isDevPlaceholder(raw)) return { ok: false, error: 'dev_placeholder_key' };
    current = raw;
  }
  let next: NextKeyStatus = 'absent';
  let nextRaw: Uint8Array<ArrayBuffer> | null = null;
  if (nextSecret !== '') {
    const problem = checkNextKey(nextSecret);
    if (problem && current === null) return { ok: false, error: NEXT_KEY_ERROR[problem] };
    if (problem) next = problem;
    else {
      nextRaw = decodeKey(nextSecret) as Uint8Array<ArrayBuffer>;
      next = current && sameBytes(current, nextRaw) ? 'same' : 'ready';
    }
  }

  const keys = new Map<string, CryptoKey>();
  const importKey = async (raw: Uint8Array): Promise<string> => {
    const bound = await boundKey(raw, bindingInfo);
    const kid = await keyCheckValue(bound);
    keys.set(
      kid,
      await crypto.subtle.importKey('raw', bound, 'AES-GCM', false, ['encrypt', 'decrypt']),
    );
    return kid;
  };
  const currentKid = current ? await importKey(current) : null;
  const nextKid = nextRaw ? await importKey(nextRaw) : null;
  const kids = [...keys.keys()].sort();
  // Null prototype: `kcv["constructor"]` must be undefined, like any other unknown kid.
  const kcv: Record<string, string> = Object.create(null);
  for (const kid of kids) kcv[kid] = kid;
  if (currentKid) kcv[LEGACY_KID] = currentKid;
  const resolve = (kid: string): string | null =>
    kid === LEGACY_KID ? currentKid : keys.has(kid) ? kid : null;
  const keyring: Keyring = {
    activeKid: (next === 'ready' ? nextKid : currentKid) as string,
    kids: Object.freeze(kids) as string[],
    kcv: Object.freeze(kcv),
    key: (kid) => {
      const loaded = resolve(kid);
      return loaded === null ? undefined : keys.get(loaded);
    },
    resolve,
    currentKid,
    next,
    nextKid,
  };
  return { ok: true, keyring: Object.freeze(keyring) };
}

function isDevPlaceholder(raw: Uint8Array): boolean {
  return sameBytes(raw, decodeKey(DEV_PLACEHOLDER_KEK) as Uint8Array);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
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
