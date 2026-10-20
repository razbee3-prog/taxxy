import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Surreal } from "surrealdb";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

/** Applies every `NNN_name.surql` once, in order, recording each in `_migration`. */
export async function migrate(db: Surreal): Promise<string[]> {
  await db.query(
    "DEFINE TABLE IF NOT EXISTS _migration SCHEMAFULL; DEFINE FIELD IF NOT EXISTS name ON _migration TYPE string; DEFINE FIELD IF NOT EXISTS applied_at ON _migration TYPE datetime DEFAULT time::now(); DEFINE INDEX IF NOT EXISTS _migration_name ON _migration FIELDS name UNIQUE;",
  );
  const [applied] = await db.query<[{ name: string }[]]>("SELECT name FROM _migration");
  const done = new Set((applied ?? []).map((r) => r.name));
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".surql")).sort();
  const ran: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
    await db.query(sql);
    await db.query("CREATE _migration SET name = $name", { name: file });
    ran.push(file);
  }
  return ran;
}
