import type { Surreal } from "surrealdb";
import { connectSurreal } from "../src/client.js";
import { dbConfigFromEnv } from "../src/config.js";
import { migrate } from "../src/migrate.js";

const cfg = dbConfigFromEnv();

export async function reachable(): Promise<boolean> {
  try {
    const u = new URL(cfg.app.url.replace(/^ws/, "http"));
    const r = await fetch(`${u.origin}/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

/** Fresh namespace per test file so runs never see each other's rows. */
export async function testDb(
  prefix: string,
): Promise<{ db: Surreal; ns: string; close: () => Promise<void> }> {
  const ns = `test_${prefix}_${Date.now().toString(36)}`;
  const db = await connectSurreal({ ...cfg.app, namespace: ns });
  await migrate(db);
  return {
    db,
    ns,
    close: async () => {
      await db.query(`REMOVE NAMESPACE IF EXISTS ${ns}`);
      await db.close();
    },
  };
}

export function langgraphCfg(ns: string) {
  return { ...cfg.langgraph, namespace: ns };
}

export const SKIP_REASON = `SurrealDB not reachable at ${cfg.app.url}; start one with \`surreal start --user root --pass root memory\``;
