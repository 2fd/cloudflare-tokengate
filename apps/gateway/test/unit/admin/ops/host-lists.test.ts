import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { updateUpstreamHosts } from '../../../../src/admin/ops/upstream-hosts';
import { getAllowedUpstreamHosts } from '../../../../src/db/settings';
import { auditRows, ACTOR, opsDeps } from './helpers';

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM settings'),
    env.DB.prepare('DELETE FROM audit_log'),
  ]);
});

describe('I-SSRF-1: upstream host edits are guarded on the stored value', () => {
  it('saves and clears the allowlist through the guarded write', async () => {
    expect(await updateUpstreamHosts(opsDeps(), ACTOR, 'api.github.com')).toMatchObject({
      ok: true,
      changed: true,
    });
    expect(await getAllowedUpstreamHosts(env.DB)).toEqual(['api.github.com']);
    expect(await updateUpstreamHosts(opsDeps(), ACTOR, '')).toMatchObject({
      ok: true,
      changed: true,
    });
    expect(await getAllowedUpstreamHosts(env.DB)).toBeNull();
    expect(await auditRows()).toHaveLength(2);
  });
});
