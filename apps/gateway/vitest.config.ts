import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, 'migrations'));
  const telemetryMigrations = await readD1Migrations(
    path.join(import.meta.dirname, 'migrations-telemetry'),
  );
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            TEST_TELEMETRY_MIGRATIONS: telemetryMigrations,
            // Local sign-in settings must not leak into isolated test identities or key bindings.
            TOKENGATE_KEK: '',
            AUTH_ACCESS_DEVELOPMENT: '',
            AUTH_ACCESS_TEAM_DOMAIN: '',
            AUTH_ACCESS_AUD: '',
          },
          // Empty database for migration tests, which apply the migrations themselves.
          d1Databases: { MIGRATION_TEST_DB: 'migration-test' },
        },
      }),
    ],
    test: {
      setupFiles: ['./test/helpers/apply-migrations.ts'],
    },
  };
});
