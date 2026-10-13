import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  combineSchemaStates,
  resetSchemaStatusCacheForTests,
  schemaStateFromNames,
  schemaStatus,
  schemaStatusByDatabase,
} from '../../src/db/migrations';
import type { AppEnv } from '../../src/env';
import { SCHEMA_HEAD } from '../../src/generated/schema-head';

const lastName = (migrations: Array<{ name: string }>) =>
  migrations
    .map((m) => m.name)
    .sort()
    .at(-1);

describe('SCHEMA_HEAD', () => {
  it('names the newest file in migrations/', () => {
    expect(SCHEMA_HEAD.DB).toBe(lastName(env.TEST_MIGRATIONS));
  });

  it('names the newest file in migrations-telemetry/', () => {
    expect(SCHEMA_HEAD.TELEMETRY_DB).toBe(lastName(env.TEST_TELEMETRY_MIGRATIONS));
  });
});

describe('schemaStateFromNames', () => {
  it.each([
    [['0001_initial.sql'], '0001_initial.sql', 'ok'],
    [['0001_initial.sql', '0002_more.sql'], '0002_more.sql', 'ok'],
    [['0001_initial.sql'], '0002_more.sql', 'behind'],
    [[], '0001_initial.sql', 'behind'],
    [['0001_initial.sql', '0002_more.sql'], '0001_initial.sql', 'ahead'],
    [['0001_initial.sql', '0010_later.sql'], '0002_more.sql', 'ahead'],
    // Same number, different file: the head itself is not applied.
    [['0001_initial.sql', '0002_other.sql'], '0002_more.sql', 'behind'],
    [['0001_initial.sql'], 'not-a-migration.sql', 'unknown'],
  ] as const)('%j vs %s → %s', (applied, head, expected) => {
    expect(schemaStateFromNames(applied, head)).toBe(expected);
  });
});

describe('combineSchemaStates', () => {
  it('reports the state operators must act on first', () => {
    expect(combineSchemaStates(['ok', 'ok'])).toBe('ok');
    expect(combineSchemaStates(['ahead', 'ok'])).toBe('ahead');
    expect(combineSchemaStates(['ahead', 'unknown'])).toBe('unknown');
    expect(combineSchemaStates(['unknown', 'behind'])).toBe('behind');
  });
});

describe('schemaStatus', () => {
  beforeEach(() => resetSchemaStatusCacheForTests());

  it('is ok for the test databases (migrations applied by the setup file)', async () => {
    const deps = { env: env as unknown as AppEnv, now: () => 0 };
    expect(await schemaStatusByDatabase(deps)).toEqual({ DB: 'ok', TELEMETRY_DB: 'ok' });
    expect(await schemaStatus(deps)).toBe('ok');
  });

  it('is unknown when the migrations table cannot be read, and re-reads after a minute', async () => {
    let calls = 0;
    const broken = {
      prepare: () => {
        calls++;
        throw new Error('D1 down');
      },
    } as unknown as D1Database;
    let now = 0;
    const deps = {
      env: { ...(env as unknown as AppEnv), TELEMETRY_DB: broken },
      now: () => now,
    };
    expect(await schemaStatus(deps)).toBe('unknown');
    expect(await schemaStatus(deps)).toBe('unknown');
    expect(calls).toBe(1);
    now = 61_000;
    await schemaStatus(deps);
    expect(calls).toBe(2);
  });

  it('caches an ok result for the life of the isolate', async () => {
    let calls = 0;
    const counting = new Proxy(env.DB, {
      get(target, key) {
        if (key === 'prepare') calls++;
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    let now = 0;
    const deps = { env: { ...(env as unknown as AppEnv), DB: counting }, now: () => now };
    await schemaStatus(deps);
    now = 10 * 3_600_000;
    await schemaStatus(deps);
    expect(calls).toBe(1);
  });
});
