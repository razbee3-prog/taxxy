import { readFileSync } from "node:fs";
import { connectSurreal, dbConfigFromEnv, migrate, Vault } from "@taxxy/db";
import {
  type Categorizer,
  fixturePlaid,
  llmCategorizer,
  type PlaidClientLike,
  type PlaidFixture,
  plaidClient,
} from "@taxxy/integrations";
import type { Surreal } from "surrealdb";
import type { Env } from "./config.js";
import { chatModel } from "./model.js";

/** Everything the services and tools need; tests build one with fakes. */
export interface AppDeps {
  env: Env;
  db: Surreal;
  vault: Vault;
  plaid: PlaidClientLike;
  categorizer: Categorizer | null;
}

export function loadPlaidFixture(): PlaidFixture {
  const url = new URL(
    "../../../packages/integrations/test/fixtures/plaid-sandbox-sync.json",
    import.meta.url,
  );
  return JSON.parse(readFileSync(url, "utf8")) as PlaidFixture;
}

export function buildPlaid(env: Env): PlaidClientLike {
  if (env.PLAID_MODE === "live") {
    if (!env.PLAID_CLIENT_ID || !env.plaidSecret)
      throw new Error("PLAID_MODE=live needs PLAID_CLIENT_ID and PLAID_SECRET");
    return plaidClient({
      PLAID_CLIENT_ID: env.PLAID_CLIENT_ID,
      PLAID_SECRET: env.plaidSecret,
      PLAID_ENV: env.PLAID_ENV,
    });
  }
  return fixturePlaid(loadPlaidFixture());
}

export function buildCategorizer(env: Env): Categorizer | null {
  if (!env.llmApiKey) return null;
  return llmCategorizer(chatModel(env, env.CATEGORIZER_MODEL), env.CATEGORIZER_MODEL);
}

export async function buildDeps(env: Env, over: Partial<AppDeps> = {}): Promise<AppDeps> {
  const cfg = dbConfigFromEnv(env as unknown as NodeJS.ProcessEnv);
  const db = over.db ?? (await connectSurreal(cfg.app));
  await migrate(db);
  const vaultKey = env.VAULT_KEY ?? (env.TAXXY_ENV === "dev" ? Vault.generateKey() : undefined);
  if (!vaultKey) throw new Error("VAULT_KEY is required outside dev");
  return {
    env,
    db,
    vault: over.vault ?? new Vault(vaultKey),
    plaid: over.plaid ?? buildPlaid(env),
    categorizer: over.categorizer === undefined ? buildCategorizer(env) : over.categorizer,
  };
}
