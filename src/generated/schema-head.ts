// Newest migration file per D1 database, compiled into the bundle so the running code can tell
// whether the database schema is behind it (src/db/migrations.ts). test/unit/schema-head.test.ts
// fails when this drifts from migrations/ or migrations-telemetry/.
export const SCHEMA_HEAD = {
  DB: '0002_admin_redesign.sql',
  TELEMETRY_DB: '0001_initial.sql',
} as const;

export type SchemaDatabase = keyof typeof SCHEMA_HEAD;
