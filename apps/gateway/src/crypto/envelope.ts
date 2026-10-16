// Sealed credential format v1: AES-256-GCM envelope encryption with a fresh DEK per seal, both
// layers bound to the same AAD (service id, base URL, injection) so tampering fails closed (I-CRED-2).
import { fromBase64Url, toBase64Url, utf8 } from '../lib/encoding';
import { type Keyring, KID_PATTERN } from './keyring';

/**
 * Sealed v1 is the JSON text, in this key order, of:
 *   v      1
 *   kid    key id of the KEK that wrapped the DEK
 *   iv     12-byte nonce for the payload
 *   wdek   AES-GCM(KEK, dek_iv, aad, DEK): 32-byte DEK + 16-byte tag
 *   dek_iv 12-byte nonce for the DEK wrap
 *   ct     AES-GCM(DEK, iv, aad, UTF-8 plaintext): ciphertext + 16-byte tag
 * All byte fields are unpadded base64url. Frozen by test/vectors/sealed.json.
 */
interface SealedV1 {
  v: 1;
  kid: string;
  iv: Uint8Array;
  wdek: Uint8Array;
  dek_iv: Uint8Array;
  ct: Uint8Array;
}

const DEK_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const SEALED_FIELDS = ['v', 'kid', 'iv', 'wdek', 'dek_iv', 'ct'];
const AAD_LABEL = 'tokengate/v1/service-credential';
// Keeps a leading U+FEFF (lib/encoding's decoder strips it): open returns exactly what was sealed.
const plaintextDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export type OpenCredentialError =
  | 'sealed_malformed'
  | 'keyring_missing_key'
  | 'credential_binding_mismatch';

/**
 * Additional authenticated data binding a credential to its service row.
 * serviceId and baseUrl cannot contain '\n' (asserted), so the encoding is unambiguous;
 * injectionJson is last and is canonical JSON as stored.
 */
export function credentialAad(
  serviceId: string,
  baseUrl: string,
  injectionJson: string,
): Uint8Array {
  if (serviceId.includes('\n') || baseUrl.includes('\n')) {
    throw new Error('credentialAad: serviceId and baseUrl must not contain newlines');
  }
  return utf8(`${AAD_LABEL}\n${serviceId}\n${baseUrl}\n${injectionJson}`);
}

/** A different label from AAD_LABEL: a draft never opens as a stored credential, nor the reverse. */
const DRAFT_AAD_LABEL = 'tokengate/v1/credential-draft';

/** What a credential draft (ADR 0020) is bound to: who typed it, for which destination, until when. */
export interface CredentialDraftBinding {
  userId: string;
  loginProvider: string;
  subject: string;
  /** `new` (a token being created) or the service id. */
  target: string;
  /** Normalized base URL. */
  baseUrl: string;
  /** Canonical injection JSON. */
  injectionJson: string;
  /** Milliseconds since the epoch; carried in clear in the draft and bound here. */
  expiresAt: number;
}

/**
 * Additional authenticated data of a sealed credential draft. No field may contain '\n'
 * (asserted), so the encoding is unambiguous; the injection JSON is last.
 */
export function credentialDraftAad(binding: CredentialDraftBinding): Uint8Array {
  const fields = [
    binding.userId,
    binding.loginProvider,
    binding.subject,
    binding.target,
    binding.baseUrl,
    String(binding.expiresAt),
    binding.injectionJson,
  ];
  if (fields.some((field) => typeof field !== 'string' || field.includes('\n'))) {
    throw new Error('credentialDraftAad: fields must be strings without newlines');
  }
  return utf8([DRAFT_AAD_LABEL, ...fields].join('\n'));
}

/**
 * Seals `plaintext` under the keyring's active KEK.
 * `random` is called exactly three times, in this order: DEK (32), iv (12), dek_iv (12).
 * Throws if `plaintext` has lone surrogates (UTF-8 encoding would silently replace them) or if the
 * active kid could not be parsed back by openCredential.
 */
export async function sealCredential(
  keyring: Keyring,
  plaintext: string,
  aad: Uint8Array,
  random: (n: number) => Uint8Array,
): Promise<string> {
  if (!plaintext.isWellFormed()) {
    throw new Error('sealCredential: plaintext is not well-formed UTF-16');
  }
  if (!KID_PATTERN.test(keyring.activeKid)) throw new Error('sealCredential: invalid active kid');
  const kek = keyring.key(keyring.activeKid);
  if (!kek) throw new Error('sealCredential: active KEK not loaded');
  const dekRaw = randomBytes(random, DEK_BYTES);
  const iv = randomBytes(random, IV_BYTES);
  const dekIv = randomBytes(random, IV_BYTES);

  const dek = await crypto.subtle.importKey('raw', dekRaw, 'AES-GCM', false, ['encrypt']);
  const ct = await aesGcm('encrypt', dek, iv, aad, utf8(plaintext));
  const wdek = await aesGcm('encrypt', kek, dekIv, aad, dekRaw);

  return JSON.stringify({
    v: 1,
    kid: keyring.activeKid,
    iv: toBase64Url(iv),
    wdek: toBase64Url(wdek),
    dek_iv: toBase64Url(dekIv),
    ct: toBase64Url(ct),
  });
}

/**
 * Opens a sealed credential. Any authentication failure (wrong AAD, swapped fields, a different
 * key under the same kid) is reported as `credential_binding_mismatch`.
 */
export async function openCredential(
  keyring: Keyring,
  sealed: string,
  aad: Uint8Array,
): Promise<{ ok: true; plaintext: string } | { ok: false; error: OpenCredentialError }> {
  const parsed = parseSealed(sealed);
  if (!parsed) return { ok: false, error: 'sealed_malformed' };
  const kek = keyring.key(parsed.kid);
  if (!kek) return { ok: false, error: 'keyring_missing_key' };
  try {
    const dekRaw = await aesGcm('decrypt', kek, parsed.dek_iv, aad, parsed.wdek);
    const dek = await crypto.subtle.importKey('raw', dekRaw, 'AES-GCM', false, ['decrypt']);
    const plaintext = await aesGcm('decrypt', dek, parsed.iv, aad, parsed.ct);
    return { ok: true, plaintext: plaintextDecoder.decode(plaintext) };
  } catch {
    return { ok: false, error: 'credential_binding_mismatch' };
  }
}

/** Kid of a well-formed sealed v1 value, else null. Used to find credentials needing rewrap. */
export function sealedKid(sealed: string | null): string | null {
  if (sealed === null) return null;
  return parseSealed(sealed)?.kid ?? null;
}

/** Strict parser: exact field set, kid syntax, canonical base64url, exact nonce/DEK sizes. */
function parseSealed(sealed: string): SealedV1 | null {
  let doc: unknown;
  try {
    doc = JSON.parse(sealed);
  } catch {
    return null;
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return null;
  const record = doc as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== SEALED_FIELDS.length ||
    !SEALED_FIELDS.every((k) => Object.hasOwn(record, k))
  ) {
    return null;
  }
  if (record.v !== 1 || typeof record.kid !== 'string' || !KID_PATTERN.test(record.kid)) {
    return null;
  }
  const iv = decodeField(record.iv);
  const wdek = decodeField(record.wdek);
  const dekIv = decodeField(record.dek_iv);
  const ct = decodeField(record.ct);
  if (!iv || !wdek || !dekIv || !ct) return null;
  if (iv.length !== IV_BYTES || dekIv.length !== IV_BYTES) return null;
  if (wdek.length !== DEK_BYTES + TAG_BYTES || ct.length < TAG_BYTES) return null;
  return { v: 1, kid: record.kid, iv, wdek, dek_iv: dekIv, ct };
}

/** Decodes base64url, rejecting non-canonical encodings so each sealed value has one spelling. */
function decodeField(value: unknown): Uint8Array | null {
  if (typeof value !== 'string') return null;
  try {
    const bytes = fromBase64Url(value);
    return toBase64Url(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
}

function randomBytes(random: (n: number) => Uint8Array, length: number): Uint8Array {
  const bytes = random(length);
  if (bytes.length !== length) throw new Error('random source returned the wrong length');
  return bytes;
}

async function aesGcm(
  op: 'encrypt' | 'decrypt',
  key: CryptoKey,
  iv: Uint8Array,
  aad: Uint8Array,
  data: Uint8Array,
): Promise<Uint8Array> {
  const params = { name: 'AES-GCM', iv, additionalData: aad, tagLength: TAG_BYTES * 8 };
  return new Uint8Array(await crypto.subtle[op](params, key, data));
}
