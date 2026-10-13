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
          bindings: { TEST_MIGRATIONS: migrations, TEST_TELEMETRY_MIGRATIONS: telemetryMigrations },
        },
      }),
    ],
    test: {
      setupFiles: ['./test/helpers/apply-migrations.ts'],
    },
  };
});
