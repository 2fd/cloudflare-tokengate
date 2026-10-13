// Parses TOKENGATE_KEK / TOKENGATE_KEYRING into non-extractable AES-256-GCM key-encryption keys,
// failing closed with a named error. Has no value imports so scripts/keyring.ts can load this file
// under Node type stripping and validate a keyring exactly like the Worker does.

export type KeyringError =
  | 'keyring_absent'
  | 'keyring_malformed'
  | 'active_kid_missing'
  | 'key_not_32_bytes'
  | 'both_kek_and_keyring_set';

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
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

let cache: { kek: string; keyring: string; result: Promise<LoadKeyringResult> } | null = null;

/**
 * Loads the keyring from the Worker secrets. Exactly one of TOKENGATE_KEK (standard base64 of
 * 32 bytes, kid "k1") or TOKENGATE_KEYRING (JSON `{"active":"k2","keys":{"k1":"<b64>","k2":"<b64>"}}`)
 * must be set; empty or whitespace-only values count as absent.
 * Check order: presence, JSON shape and kid syntax, active kid present, each key 32 bytes.
 * The last result is cached per isolate, keyed by the raw secret strings.
 */
export function loadKeyring(env: {
  TOKENGATE_KEK?: string;
  TOKENGATE_KEYRING?: string;
}): Promise<LoadKeyringResult> {
  const kek = env.TOKENGATE_KEK ?? '';
  const keyring = env.TOKENGATE_KEYRING ?? '';
  if (cache && cache.kek === kek && cache.keyring === keyring) return cache.result;
  const result = parseAndImport(kek, keyring);
  cache = { kek, keyring, result };
  return result;
}

/**
 * Hex of the first 8 bytes of HMAC-SHA256(rawKey, "tokengate/v1/kek-check"). Identifies a key
 * without revealing it.
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
): Promise<LoadKeyringResult> {
  const parsed = parseSecrets(kekSecret.trim(), keyringSecret.trim());
  if (!parsed.ok) return parsed;

  const kids = [...parsed.rawKeys.keys()].sort();
  const keys = new Map<string, CryptoKey>();
  // Null prototype: `kcv["constructor"]` must be undefined, like any other unknown kid.
  const kcv: Record<string, string> = Object.create(null);
  for (const kid of kids) {
    const raw = parsed.rawKeys.get(kid) as Uint8Array<ArrayBuffer>;
    kcv[kid] = await keyCheckValue(raw);
    keys.set(
      kid,
      await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']),
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
