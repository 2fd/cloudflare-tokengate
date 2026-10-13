// Applies both schemas before tests. Idempotent: setup files may run more than once.
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
await applyD1Migrations(env.TELEMETRY_DB, env.TEST_TELEMETRY_MIGRATIONS);
