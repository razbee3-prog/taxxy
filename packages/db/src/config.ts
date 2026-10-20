import { z } from "zod";

const schema = z.object({
  SURREAL_URL: z.string().default("ws://127.0.0.1:8000/rpc"),
  SURREAL_NS: z.string().default("taxxy"),
  SURREAL_DB: z.string().default("taxxy"),
  SURREAL_LANGGRAPH_NS: z.string().default("langgraph"),
  SURREAL_USER: z.string().default("root"),
  SURREAL_PASS: z.string().default("root"),
  VAULT_KEY: z.string().optional(),
});

export interface SurrealConfig {
  url: string;
  username: string;
  password: string;
  namespace: string;
  database: string;
}

export interface DbConfig {
  /** App tables (`taxxy` namespace). */
  app: SurrealConfig;
  /** Checkpoints + store owned by @surrealdb/langgraph (`langgraph` namespace). */
  langgraph: SurrealConfig;
  vaultKey: string | undefined;
}

export function dbConfigFromEnv(source: NodeJS.ProcessEnv = process.env): DbConfig {
  const e = schema.parse(source);
  const base = { url: e.SURREAL_URL, username: e.SURREAL_USER, password: e.SURREAL_PASS };
  return {
    app: { ...base, namespace: e.SURREAL_NS, database: e.SURREAL_DB },
    langgraph: { ...base, namespace: e.SURREAL_LANGGRAPH_NS, database: e.SURREAL_DB },
    vaultKey: e.VAULT_KEY,
  };
}
