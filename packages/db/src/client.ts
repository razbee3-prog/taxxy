import { Surreal } from "surrealdb";
import type { SurrealConfig } from "./config.js";
import { retryConflict } from "./migrate.js";

export async function connectSurreal(cfg: SurrealConfig): Promise<Surreal> {
  const db = new Surreal();
  await db.connect(cfg.url, { authentication: { username: cfg.username, password: cfg.password } });
  assertIdent(cfg.namespace);
  assertIdent(cfg.database);
  await retryConflict(() => db.query(`DEFINE NAMESPACE IF NOT EXISTS ${cfg.namespace}`));
  await db.use({ namespace: cfg.namespace });
  await retryConflict(() => db.query(`DEFINE DATABASE IF NOT EXISTS ${cfg.database}`));
  await db.use({ namespace: cfg.namespace, database: cfg.database });
  return db;
}

function assertIdent(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    throw new Error(`invalid SurrealDB identifier: ${name}`);
}

/** SurrealDB returns bigint for integer fields and Date for datetimes; normalise for JSON. */
export function plain<T>(value: unknown): T {
  return JSON.parse(
    JSON.stringify(value, (_k, v) => {
      if (typeof v === "bigint") return Number(v);
      if (v && typeof v === "object" && "tb" in v && "id" in v) return `${v.tb}:${v.id}`;
      return v;
    }),
  ) as T;
}
