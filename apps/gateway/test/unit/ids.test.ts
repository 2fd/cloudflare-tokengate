import { describe, expect, it } from 'vitest';
import { idLowerBound, idTimestamp, newId } from '../../src/lib/ids';

const fixedRandom = (length: number) => new Uint8Array(length).fill(0xff);

describe('ids', () => {
  it('encodes prefix, time and randomness in 26 ULID characters', () => {
    const id = newId('req', 1_760_000_000_000, fixedRandom);
    expect(id).toMatch(/^req_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(idTimestamp(id)).toBe(1_760_000_000_000);
  });

  it('orders ids by creation time, with lower bounds below every id of that ms', () => {
    const early = newId('req', 1_000, fixedRandom);
    const late = newId('req', 2_000, () => new Uint8Array(10));
    expect(early < late).toBe(true);
    expect(idLowerBound('req', 2_000) <= late).toBe(true);
    expect(idLowerBound('req', 2_000) > early).toBe(true);
  });

  it('applies migrations to both databases', async () => {
    const { env } = await import('cloudflare:workers');
    const tables = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'grants'",
    ).all();
    expect(tables.results).toHaveLength(1);
    const telemetry = await env.TELEMETRY_DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'request_log'",
    ).all();
    expect(telemetry.results).toHaveLength(1);
  });
});
