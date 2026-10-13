// Request list filters that no index serves (outcome, service slug) scan a bounded window of rows,
// so a viewer cannot make one page load read the whole request_log.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { REQUEST_SCAN_ROWS, searchRequests } from '../../src/db/requests';
import { idLowerBound } from '../../src/lib/ids';
import { adminGet, createUser, loginAs, resetControlPlane } from '../helpers/admin-auth';
import { createTestApp } from '../helpers/app';
import { TEST_EPOCH_MS } from '../helpers/jwt';

const db = () => env.TELEMETRY_DB;

/** `count` denied rows for slug `slug` at `ms`, ids ordered, generated in SQL. */
async function seed(ms: number, count: number, tag: string, slug: string, repo: string) {
  // `tag` must be Crockford base32 (no I, L, O, U) so the ids pass REQUEST_ID in the routes.
  const prefix = idLowerBound('req', ms).slice(0, 14) + tag.padEnd(6, '0').toUpperCase();
  await db()
    .prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?2)
       INSERT INTO request_log (id, ts, outcome, status, method, path, service_slug, caller_repository, claims_verified, duration_ms)
       SELECT ?1 || printf('%010d', i), ?3, 'denied', 403, 'GET', '/', ?4, ?5, 0, 5 FROM n`,
    )
    .bind(prefix, count, ms, slug, repo)
    .run();
}

let rareId: string;

beforeEach(async () => {
  await db().prepare('DELETE FROM request_log').run();
  // One old match, then a full scan window of newer rows that do not match.
  await seed(TEST_EPOCH_MS - 60_000, 1, 'rare', 'rare', 'acme/rare');
  await seed(TEST_EPOCH_MS - 1_000, REQUEST_SCAN_ROWS, 'many', 'busy', 'acme/busy');
  rareId = (await db().prepare('SELECT MIN(id) AS id FROM request_log').first<{ id: string }>())
    ?.id as string;
});

describe('request list filters are bounded', () => {
  it('a slug filter searches one window and points to the next one', async () => {
    const first = await searchRequests(db(), { slug: 'rare' });
    expect(first.records).toEqual([]);
    expect(first.olderBefore).not.toBeNull();

    const second = await searchRequests(db(), {
      slug: 'rare',
      before: first.olderBefore as string,
    });
    expect(second.records.map((r) => r.id)).toEqual([rareId]);
    expect(second.olderBefore).toBeNull();
  });

  it('an outcome filter is bounded the same way', async () => {
    const page = await searchRequests(db(), { outcome: 'allowed' });
    expect(page).toEqual({ records: [], olderBefore: expect.any(String) });
  });

  it('an index-served filter needs no window', async () => {
    const page = await searchRequests(db(), { repository: 'acme/rare' });
    expect(page).toEqual({ records: [expect.objectContaining({ id: rareId })], olderBefore: null });
  });

  it('the page links to the next window', async () => {
    await resetControlPlane();
    const app = createTestApp({ now: () => TEST_EPOCH_MS });
    const session = await loginAs(
      app,
      await createUser({ email: 'v@example.com', role: 'viewer' }),
    );
    const html = await (await adminGet(app, session, '/admin/requests?slug=rare')).text();
    expect(html).toContain('No requests match these filters in this range');
    const next = /href="(\/admin\/requests\?[^"]*before=req_[0-9A-Z]{26}[^"]*)"/.exec(html)?.[1];
    expect(next).toBeDefined();
    const older = await (
      await adminGet(app, session, (next as string).replaceAll('&amp;', '&'))
    ).text();
    expect(older).toContain(`/admin/requests/${rareId}`);
  });
});
