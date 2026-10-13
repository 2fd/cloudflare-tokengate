declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
    TEST_TELEMETRY_MIGRATIONS: import('cloudflare:test').D1Migration[];
  }
}
