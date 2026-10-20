import { SurrealDBSaver, SurrealDBStore } from "@surrealdb/langgraph";
import { connectSurreal } from "./client.js";
import type { SurrealConfig } from "./config.js";

/** Namespace in the LangGraph store that holds one user's virtual filesystem (AGENTS.md, skills). */
export function userFilesystemNamespace(userId: string): string[] {
  return ["filesystem", userId];
}

export function memoryFilePath(userId: string): string {
  return `/users/${userId}/AGENTS.md`;
}

export function threadId(userId: string, taxYear: number, quarter: number): string {
  return `${userId}:${taxYear}:${quarter}`;
}

export function createCheckpointer(cfg: SurrealConfig): SurrealDBSaver {
  return new SurrealDBSaver({ surreal: cfg });
}

/**
 * SurrealDBStore upserts with `CONTENT`, which drops `created_at` on the second write of a key
 * ("Expected datetime but found NONE"). After its own setup we redefine the field to keep the
 * previous value on update.
 */
export function createStore(cfg: SurrealConfig): SurrealDBStore {
  const store = new SurrealDBStore({ surreal: cfg });
  const setup = store.setup.bind(store);
  let patched = false;
  store.setup = async () => {
    await setup();
    if (patched) return;
    const db = await connectSurreal(cfg);
    try {
      await db.query(
        "DEFINE FIELD OVERWRITE created_at ON langgraph_store TYPE datetime DEFAULT time::now() VALUE $value ?? $before ?? time::now();",
      );
      patched = true;
    } finally {
      await db.close();
    }
  };
  return store;
}
