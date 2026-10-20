import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BaseCheckpointSaver, BaseStore } from "@langchain/langgraph-checkpoint";
import {
  connectSurreal,
  createCheckpointer,
  createStore,
  dbConfigFromEnv,
  migrate,
  Vault,
} from "@taxxy/db";
import {
  type Categorizer,
  type FileStore,
  type FixtureMailbox,
  fixtureGmail,
  fixturePlaid,
  type GmailClientLike,
  gmailClient,
  llmCategorizer,
  localFileStore,
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
  /** LangGraph store (per-user filesystem: AGENTS.md, skills) and checkpointer. */
  store: BaseStore | null;
  checkpointer: BaseCheckpointSaver | null;
  files: FileStore;
  /** Builds a Gmail client for a user from their sealed refresh token (fixture mode ignores the token). */
  gmailFor: (
    refreshToken: string,
    onRefresh?: (t: { access_token?: string }) => Promise<void>,
  ) => GmailClientLike;
  /** Model for document extraction (receipts, 1040); null = deterministic heuristics. */
  extractionModel: ReturnType<typeof chatModel> | null;
}

/**
 * Dev only: without VAULT_KEY, generate one and keep it under FILES_DIR so sealed bank/Gmail tokens
 * survive agent restarts (a fresh key per process would make every linked bank unreadable).
 */
export function devVaultKey(env: Env): string {
  const file = join(env.FILES_DIR, "vault.dev.key");
  try {
    const existing = readFileSync(file, "utf8").trim();
    if (existing) return existing;
  } catch {
    // first run
  }
  const key = Vault.generateKey();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${key}\n`, { mode: 0o600 });
  console.warn(
    `VAULT_KEY not set: generated a dev key at ${file} (set VAULT_KEY in .env for anything real)`,
  );
  return key;
}

export function loadMailboxFixture(): FixtureMailbox {
  const url = new URL(
    "../../../packages/integrations/test/fixtures/gmail-mailbox.json",
    import.meta.url,
  );
  return JSON.parse(readFileSync(url, "utf8")) as FixtureMailbox;
}

export function buildGmailFactory(env: Env): AppDeps["gmailFor"] {
  if (env.GMAIL_MODE === "live") {
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET)
      throw new Error("GMAIL_MODE=live needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET");
    const g = {
      GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET: env.GOOGLE_CLIENT_SECRET,
      GOOGLE_REDIRECT_URI: env.GOOGLE_REDIRECT_URI,
    };
    return (refresh_token, onRefresh) => gmailClient(g, { refresh_token }, onRefresh);
  }
  const box = loadMailboxFixture();
  return () => fixtureGmail(box);
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
  return fixturePlaid(loadPlaidFixture(), { isolateLinks: true });
}

export function buildCategorizer(env: Env): Categorizer | null {
  if (!env.llmApiKey) return null;
  return llmCategorizer(chatModel(env, env.CATEGORIZER_MODEL), env.CATEGORIZER_MODEL);
}

export async function buildDeps(env: Env, over: Partial<AppDeps> = {}): Promise<AppDeps> {
  const cfg = dbConfigFromEnv(env as unknown as NodeJS.ProcessEnv);
  const db = over.db ?? (await connectSurreal(cfg.app));
  await migrate(db);
  const vaultKey = env.VAULT_KEY ?? (env.TAXXY_ENV === "dev" ? devVaultKey(env) : undefined);
  if (!vaultKey) throw new Error("VAULT_KEY is required outside dev");
  let store = over.store;
  let checkpointer = over.checkpointer;
  if (store === undefined) {
    const s = createStore(cfg.langgraph);
    await s.setup();
    store = s;
  }
  if (checkpointer === undefined) {
    const c = createCheckpointer(cfg.langgraph);
    await c.setup();
    checkpointer = c;
  }
  return {
    env,
    db,
    vault: over.vault ?? new Vault(vaultKey),
    plaid: over.plaid ?? buildPlaid(env),
    categorizer: over.categorizer === undefined ? buildCategorizer(env) : over.categorizer,
    store,
    checkpointer,
    files: over.files ?? localFileStore(env.FILES_DIR),
    gmailFor: over.gmailFor ?? buildGmailFactory(env),
    extractionModel:
      over.extractionModel === undefined
        ? env.llmApiKey
          ? chatModel(env, env.CATEGORIZER_MODEL)
          : null
        : over.extractionModel,
  };
}
