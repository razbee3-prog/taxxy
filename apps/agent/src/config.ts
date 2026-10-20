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
  SURREAL_USER: z.string().default("root"),
  SURREAL_PASS: z.string().default("root"),
  TAXXY_ENV: z.string().default("dev"),
});

export type Env = z.infer<typeof envSchema> & { llmApiKey: string | undefined };

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.parse(source);
  return { ...parsed, llmApiKey: parsed.LLM_API_KEY ?? parsed.ANTHROPIC_API_KEY };
}

export const env = loadEnv();
