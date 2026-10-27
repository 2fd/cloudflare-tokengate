import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { toBase64 } from '../../src/lib/encoding';
import { canonicalJson } from '../../src/lib/json';
import { setupProxy } from '../helpers/proxy-fixtures';

async function expectCredentialUnavailable(
  fx: Awaited<ReturnType<typeof setupProxy>>,
  reason: string,
): Promise<void> {
  const response = await fx.call('/a');
  expect(response.status).toBe(503);
  expect(response.headers.get('x-tokengate-error')).toBe('credential_unavailable');
  expect(fx.upstreamCalls).toHaveLength(0);
  const [record] = await fx.records();
  expect(record).toMatchObject({ outcome: 'error', reason });
}

describe('I-CRED-2: the credential only opens for the service, base URL and injection it was sealed for', () => {
  it('a D1 edit of base_url to another valid host → 503 credential_unavailable, no fetch', async () => {
    const fx = await setupProxy();
    await env.DB.prepare('UPDATE credentials SET base_url = ? WHERE id = ?')
      .bind('https://attacker.example/v1', fx.serviceId)
      .run();
    await expectCredentialUnavailable(fx, 'credential_binding_mismatch');
  });

  it('a D1 edit of the injection (bearer → query) → 503 credential_unavailable, no fetch', async () => {
    const fx = await setupProxy();
    await env.DB.prepare('UPDATE credentials SET injection = ? WHERE id = ?')
      .bind(canonicalJson({ kind: 'query', param: 'leak' }), fx.serviceId)
      .run();
    await expectCredentialUnavailable(fx, 'credential_binding_mismatch');
  });

  it('a ciphertext copied from another service does not open', async () => {
    const fx = await setupProxy();
    const other = await fx.addService({ slug: 'other', secret: 'other-service-secret-value' });
    await env.DB.prepare(
      'UPDATE credentials SET credential_sealed = (SELECT credential_sealed FROM credentials WHERE id = ?) WHERE id = ?',
    )
      .bind(other.id, fx.serviceId)
      .run();
    await expectCredentialUnavailable(fx, 'credential_binding_mismatch');
  });

  it('a tampered sealed value does not open', async () => {
    const fx = await setupProxy();
    await env.DB.prepare('UPDATE credentials SET credential_sealed = ? WHERE id = ?')
      .bind('{"v":1}', fx.serviceId)
      .run();
    await expectCredentialUnavailable(fx, 'sealed_malformed');
  });

  it('a credential sealed under a key that is no longer in the keyring does not open', async () => {
    const fx = await setupProxy();
    // A replaced TOKENGATE_KEK has another key id (its check value), so the old id is not loaded.
    fx.app.deps.env.TOKENGATE_KEK = toBase64(new Uint8Array(32).fill(9));
    await expectCredentialUnavailable(fx, 'keyring_missing_key');
  });

  it('a different key under the legacy kid k1 does not open', async () => {
    const fx = await setupProxy();
    await env.DB.prepare(
      "UPDATE credentials SET credential_sealed = json_set(credential_sealed, '$.kid', 'k1') WHERE id = ?",
    )
      .bind(fx.serviceId)
      .run();
    fx.app.deps.env.TOKENGATE_KEK = toBase64(new Uint8Array(32).fill(7));
    await expectCredentialUnavailable(fx, 'credential_binding_mismatch');
  });

  it('an injection that fails validation is refused before decryption', async () => {
    const fx = await setupProxy();
    await env.DB.prepare('UPDATE credentials SET injection = ? WHERE id = ?')
      .bind('{"kind":"header","name":"host"}', fx.serviceId)
      .run();
    await expectCredentialUnavailable(fx, 'injection_invalid');
  });
});
