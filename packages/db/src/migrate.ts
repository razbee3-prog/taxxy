import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Surreal } from "surrealdb";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

/**
 * SurrealKV aborts concurrent schema writes with "Transaction conflict ... can be retried"
 * (e.g. several test files migrating their own namespaces at once). Retry those a few times.
 */
export async function retryConflict<T>(fn: () => Promise<T>, attempts = 6): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts || !/Transaction conflict|can be retried/i.test(String(err))) throw err;
      await new Promise((r) => setTimeout(r, 40 * i + Math.random() * 40));
    }
  }
}

/** Applies every `NNN_name.surql` once, in order, recording each in `_migration`. */
export async function migrate(db: Surreal): Promise<string[]> {
  await retryConflict(() =>
    db.query(
      "DEFINE TABLE IF NOT EXISTS _migration SCHEMAFULL; DEFINE FIELD IF NOT EXISTS name ON _migration TYPE string; DEFINE FIELD IF NOT EXISTS applied_at ON _migration TYPE datetime DEFAULT time::now(); DEFINE INDEX IF NOT EXISTS _migration_name ON _migration FIELDS name UNIQUE;",
    ),
  );
  const [applied] = await db.query<[{ name: string }[]]>("SELECT name FROM _migration");
  const done = new Set((applied ?? []).map((r) => r.name));
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".surql")).sort();
  const ran: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
    await retryConflict(() => db.query(sql));
    await retryConflict(() => db.query("CREATE _migration SET name = $name", { name: file }));
    ran.push(file);
  }
  return ran;
}
