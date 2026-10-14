// Static checks on deployment files that the Worker never sees at runtime.
// Behaviour of the get-token action itself is covered by test/security/get-token-action.sh.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import devVarsExample from '../../.dev.vars.example?raw';
import actionYml from '../../actions/get-token/action.yml?raw';
import { DEV_PLACEHOLDER_KEK, loadKeyring } from '../../src/crypto/keyring';
import wranglerJsonc from '../../wrangler.jsonc?raw';

// Same comment stripping as scripts/check-config.sh: drop comment-only lines and trailing comments.
function parseJsonc(text: string): Record<string, unknown> {
  const lines = text
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .map((line) => line.replace(/\s\/\/[^"]*$/, ''));
  return JSON.parse(lines.join('\n'));
}

// config.ts reads a blank value as unset, which turns admin sign-in off for AUTH_ACCESS_*.
const isBlank = (value: unknown): boolean => typeof value === 'string' && value.trim() === '';

const OPERATOR_VARS = ['AUTH_ACCESS_TEAM_DOMAIN', 'AUTH_ACCESS_AUD', 'AUTH_ACCESS_DEVELOPMENT'];

describe('I-DEPLOY-1 / I-SSRF-1: deploys do not wipe operator vars set in the dashboard', () => {
  const config = parseJsonc(wranglerJsonc);

  it('sets keep_vars so wrangler deploy keeps dashboard vars', () => {
    expect(config.keep_vars).toBe(true);
  });

  it('declares no blank vars (a listed var is re-uploaded and overwrites the dashboard)', () => {
    const vars = (config.vars ?? {}) as Record<string, unknown>;
    expect(Object.keys(vars).filter((name) => isBlank(vars[name]))).toEqual([]);
  });

  it('leaves no operator var as an empty placeholder in the deployed env', () => {
    // The test env is built from wrangler.jsonc, so a committed "" shows up here.
    const vars = env as unknown as Record<string, unknown>;
    expect(OPERATOR_VARS.filter((name) => isBlank(vars[name]))).toEqual([]);
  });
});

describe('I-DEPLOY-1: .dev.vars.example works locally and its defaults fail closed in production', () => {
  it('sets only the development key and the development login; Access stays commented', () => {
    const assignments = devVarsExample.split('\n').filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line));
    expect(assignments).toEqual([
      `TOKENGATE_KEK=${DEV_PLACEHOLDER_KEK}`,
      'AUTH_ACCESS_DEVELOPMENT=dev@example.com',
    ]);
  });

  it('its key is refused once an Access variable is set', async () => {
    const env = { TOKENGATE_KEK: DEV_PLACEHOLDER_KEK, AUTH_ACCESS_DEVELOPMENT: 'dev@example.com' };
    expect((await loadKeyring(env)).ok).toBe(true);
    expect(await loadKeyring({ ...env, AUTH_ACCESS_AUD: 'a'.repeat(64) })).toEqual({
      ok: false,
      error: 'dev_placeholder_key',
    });
  });
});

describe('I-LOG-1: get-token action masks every token the tokengate-token helper prints', () => {
  const helper = actionYml.split("<<'HELPER'\n")[1]?.split(/\n\s*HELPER\n/)[0] ?? '';

  it('registers the token with the runner masker on stderr before printing it', () => {
    const mask = helper.indexOf(`printf '::add-mask::%s\\n' "$token" >&2`);
    const print = helper.indexOf(`printf '%s\\n' "$token"`);
    expect(mask).toBeGreaterThan(-1);
    expect(print).toBeGreaterThan(mask);
  });

  it('accepts only a compact JWS before emitting the mask command', () => {
    const shape = helper.indexOf(
      '[[ ! "$token" =~ ^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$ ]]',
    );
    expect(shape).toBeGreaterThan(-1);
    expect(shape).toBeLessThan(helper.indexOf('::add-mask::'));
  });
});
