import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pool } from "./index.js";

const migrationsDirectory = resolve(import.meta.dir, "../../db/migrations");
const migrationLock = "guildhall-backend-migrations-v2";

async function migrationNames() {
  return (await readdir(migrationsDirectory))
    .filter((file) => /^\d+_[a-z0-9_-]+\.sql$/.test(file))
    .sort();
}

export async function migrationStatus() {
  const expected = await migrationNames();
  const result = await pool.query<{ name: string }>("SELECT name FROM schema_migrations");
  const applied = new Set(result.rows.map((row) => row.name));
  return { pending: expected.filter((name) => !applied.has(name)) };
}

export async function migrate() {
  const client = await pool.connect();
  try {
    // Session locks are unsafe through a transaction pooler: each statement may
    // use a different PostgreSQL session, leaving locks behind after release.
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [migrationLock]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    const result = await client.query<{ name: string }>("SELECT name FROM schema_migrations");
    await client.query("COMMIT");

    const files = await migrationNames();
    const appliedNames = new Set(result.rows.map((row) => row.name));

    for (const name of files) {
      if (appliedNames.has(name)) continue;
      await client.query("BEGIN");
      try {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [migrationLock]);
        const applied = await client.query("SELECT 1 FROM schema_migrations WHERE name = $1", [name]);
        if (applied.rowCount) {
          await client.query("COMMIT");
          continue;
        }

        const sql = await readFile(resolve(migrationsDirectory, name), "utf8");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
        await client.query("COMMIT");
        appliedNames.add(name);
        console.log(`Applied migration ${name}`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    client.release();
  }
}
