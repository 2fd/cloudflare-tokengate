declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
    TEST_TELEMETRY_MIGRATIONS: import('cloudflare:test').D1Migration[];
    /** Empty D1 database; migration tests apply migrations to it themselves. */
    MIGRATION_TEST_DB: D1Database;
  }
}
