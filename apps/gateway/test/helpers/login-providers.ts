// Fake Cloudflare Access served through an injected `fetch`: a team certs endpoint and a signer for
// Access application JWTs. `testAccess()` is the shared instance the test apps trust by default.
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

type FetchHandler = (url: URL, init: RequestInit | undefined) => Promise<Response | null>;

/** Combines fakes; the first handler returning a Response wins, anything else throws. */
export function combineFetch(...handlers: FetchHandler[]): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    for (const handler of handlers) {
      const response = await handler(url, init);
      if (response) return response;
    }
    throw new Error(`unexpected outbound fetch in test: ${url.href}`);
  };
}

export interface FakeAccess {
  team: string;
  teamDomain: string;
  aud: string;
  handler: FetchHandler;
  /** Signs an Access application JWT. `now` (ms) sets iat; exp is 30 days later. */
  sign(
    claims: Record<string, unknown>,
    options?: { aud?: string; iss?: string; now?: number; ttlSeconds?: number },
  ): Promise<string>;
}

export async function fakeAccess(team = 'acme'): Promise<FakeAccess> {
  const teamDomain = `https://${team}.cloudflareaccess.com`;
  const aud = 'a'.repeat(64);
  const kid = `access-key-${crypto.randomUUID()}`;
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };
  return {
    team,
    teamDomain,
    aud,
    handler: async (url) =>
      url.href === `${teamDomain}/cdn-cgi/access/certs` ? Response.json({ keys: [jwk] }) : null,
    async sign(claims, signOptions = {}) {
      const iat = Math.floor((signOptions.now ?? Date.now()) / 1000);
      return new SignJWT({
        type: 'app',
        iat,
        exp: iat + (signOptions.ttlSeconds ?? 30 * 86_400),
        ...claims,
      })
        .setProtectedHeader({ alg: 'RS256', kid })
        .setIssuer(signOptions.iss ?? teamDomain)
        .setAudience(signOptions.aud ?? aud)
        .sign(privateKey);
    },
  };
}

export const TEST_ACCESS_TEAM = 'tokengate-test';

let shared: Promise<FakeAccess> | null = null;

/** The Access team every test app trusts unless its env overrides AUTH_ACCESS_*. */
export function testAccess(): Promise<FakeAccess> {
  shared ??= fakeAccess(TEST_ACCESS_TEAM);
  return shared;
}

/** Serves the shared team's certs, then defers to `fallback`. */
export function withTestAccessCerts(fallback: typeof fetch): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const response = await (await testAccess()).handler(url, init);
    return response ?? fallback(input, init);
  };
}
