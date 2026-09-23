import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { migrationDatabaseUrlFromEnvironment } from "./store.js";

export interface MigrationReport {
  database: string;
  schema: string;
  applied: string[];
  pending: string[];
}

interface Migration { version: string; sql: string; checksum: string; }

/** Ordered, checksummed, forward-only migration runner for Observatory only. */
export async function runMigrations(options: { connectionString?: string; migrationDirectory?: string; allowProduction?: boolean } = {}): Promise<MigrationReport> {
  if (process.env.NODE_ENV === "production" && !options.allowProduction && process.env.OBSERVATORY_MIGRATE_PRODUCTION !== "true") {
    throw new Error("Production migrations require OBSERVATORY_MIGRATE_PRODUCTION=true.");
  }
  const connectionString = options.connectionString ?? migrationDatabaseUrlFromEnvironment();
  if (!connectionString) throw new Error("A provider-managed PostgreSQL connection is required (POSTGRES_URL_NON_POOLING or POSTGRES_URL).");
  const migrationDirectory = options.migrationDirectory ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");
  const migrations = await readMigrations(migrationDirectory);
  const pool = new Pool({ connectionString, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("CREATE TABLE IF NOT EXISTS observatory_schema_migrations (version TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
    const identity = await client.query<{ database: string; schema: string }>("SELECT current_database() AS database, current_schema() AS schema");
    const appliedRows = await client.query<{ version: string; checksum: string }>("SELECT version, checksum FROM observatory_schema_migrations ORDER BY version");
    const appliedByVersion = new Map(appliedRows.rows.map((row) => [row.version, row.checksum]));
    const applied: string[] = [];
    const pending: string[] = [];
    for (const migration of migrations) {
      const priorChecksum = appliedByVersion.get(migration.version);
      if (priorChecksum) {
        if (priorChecksum !== migration.checksum) throw new Error(`Migration checksum mismatch for ${migration.version}; refusing to continue.`);
        continue;
      }
      pending.push(migration.version);
      await client.query("BEGIN");
      try {
        await client.query(migration.sql);
        await client.query("INSERT INTO observatory_schema_migrations (version, checksum) VALUES ($1, $2)", [migration.version, migration.checksum]);
        await client.query("COMMIT");
        applied.push(migration.version);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
    return { database: identity.rows[0]?.database ?? "unknown", schema: identity.rows[0]?.schema ?? "unknown", applied, pending };
  } finally {
    client.release();
    await pool.end();
  }
}

async function readMigrations(directory: string): Promise<Migration[]> {
  const names = (await fs.readdir(directory)).filter((name) => /^\d+_.+\.sql$/i.test(name)).sort((left, right) => left.localeCompare(right, "en", { numeric: true }));
  if (names.length === 0) throw new Error("No Observatory SQL migrations were found.");
  return Promise.all(names.map(async (name) => {
    const sql = await fs.readFile(path.join(directory, name), "utf8");
    return { version: name, sql, checksum: createHash("sha256").update(sql).digest("hex") };
  }));
}

if (process.argv[1] && new URL(`file://${process.argv[1].replaceAll("\\", "/")}`).href === import.meta.url) {
  runMigrations().then((report) => {
    // Deliberately prints target identity and filenames, never a connection value.
    console.log(JSON.stringify(report));
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : "Migration failed.");
    process.exitCode = 1;
  });
}
