import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().default(8787),
  LLM_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  ORCHESTRATOR_MODEL: z.string().default("claude-sonnet-5-5"),
  CATEGORIZER_MODEL: z.string().default("claude-haiku-5-5"),
  CATEGORIZER_THRESHOLD: z.coerce.number().min(0).max(1).default(0.8),
  LANGFUSE_PUBLIC_KEY: z.string().optional(),
  LANGFUSE_SECRET_KEY: z.string().optional(),
  LANGFUSE_BASE_URL: z.string().optional(),
  SURREAL_URL: z.string().default("ws://127.0.0.1:8000/rpc"),
  SURREAL_NS: z.string().default("taxxy"),
  SURREAL_DB: z.string().default("taxxy"),
  SURREAL_LANGGRAPH_NS: z.string().default("langgraph"),
  SURREAL_USER: z.string().default("root"),
  SURREAL_PASS: z.string().default("root"),
  VAULT_KEY: z.string().optional(),
  PLAID_MODE: z.enum(["live", "fixture"]).default("fixture"),
  PLAID_CLIENT_ID: z.string().optional(),
  PLAID_SECRET: z.string().optional(),
  PLAID_SANDBOX_SECRET: z.string().optional(),
  PLAID_ENV: z.enum(["sandbox", "development", "production"]).default("sandbox"),
  PLAID_WEBHOOK_URL: z.string().optional(),
  PLAID_WEBHOOK_VERIFY: z
    .union([z.string(), z.boolean()])
    .optional()
    .transform((v) => v === true || v === "true" || v === "1"),
  GMAIL_MODE: z.enum(["live", "fixture"]).default("fixture"),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.string().default("http://localhost:8787/gmail/callback"),
  FILES_DIR: z.string().default("data/files"),
  TAXXY_ENV: z.string().default("dev"),
});

export type Env = z.infer<typeof envSchema> & {
  llmApiKey: string | undefined;
  plaidSecret: string | undefined;
};

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.parse(source);
  return {
    ...parsed,
    llmApiKey: parsed.LLM_API_KEY ?? parsed.ANTHROPIC_API_KEY,
    plaidSecret:
      parsed.PLAID_SECRET ??
      (parsed.PLAID_ENV === "sandbox" ? parsed.PLAID_SANDBOX_SECRET : undefined),
  };
}

export const env = loadEnv();
