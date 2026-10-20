import { LangfuseClient } from "@langfuse/client";

export interface LangfuseEnv {
  LANGFUSE_PUBLIC_KEY?: string;
  LANGFUSE_SECRET_KEY?: string;
  LANGFUSE_BASE_URL?: string;
}

/** Null when keys are absent so eval runs stay local; nothing else changes. */
export function langfuseClient(env: LangfuseEnv = process.env): LangfuseClient | null {
  if (!env.LANGFUSE_PUBLIC_KEY || !env.LANGFUSE_SECRET_KEY) return null;
  return new LangfuseClient({
    publicKey: env.LANGFUSE_PUBLIC_KEY,
    secretKey: env.LANGFUSE_SECRET_KEY,
    baseUrl: env.LANGFUSE_BASE_URL,
  });
}

export interface DatasetItemInput<I, E> {
  id: string;
  input: I;
  expectedOutput: E;
  metadata?: Record<string, unknown>;
}

/** Idempotent: creates the dataset if missing and upserts items by id. */
export async function syncDataset<I, E>(
  client: LangfuseClient,
  name: string,
  description: string,
  items: DatasetItemInput<I, E>[],
): Promise<void> {
  try {
    await client.dataset.get(name);
  } catch {
    await client.api.datasets.create({ name, description });
  }
  for (const it of items) {
    await client.dataset.createItem({
      datasetName: name,
      id: it.id,
      input: it.input,
      expectedOutput: it.expectedOutput,
      metadata: it.metadata,
    });
  }
}

export interface Score {
  name: string;
  value: number;
  comment?: string;
}

export interface RunResult<I, E> {
  item: DatasetItemInput<I, E>;
  output: unknown;
  scores: Score[];
}

/** Posts one experiment run (git SHA as run name) with per-item scores; `task` is replayed from precomputed results. */
export async function postExperiment<I, E>(
  client: LangfuseClient,
  name: string,
  runName: string,
  results: RunResult<I, E>[],
  metadata: Record<string, unknown> = {},
): Promise<void> {
  const byInput = (input: unknown) =>
    results.find((r) => JSON.stringify(r.item.input) === JSON.stringify(input));
  await client.experiment.run({
    name,
    runName,
    metadata,
    data: results.map((r) => ({
      id: r.item.id,
      input: r.item.input,
      expectedOutput: r.item.expectedOutput,
      metadata: r.item.metadata,
    })),
    task: async ({ input }) => byInput(input)?.output ?? null,
    evaluators: [
      async ({ input }) =>
        (byInput(input)?.scores ?? []).map((s) => ({
          name: s.name,
          value: s.value,
          comment: s.comment,
        })),
    ],
  });
  await client.flush();
}

export function gitSha(): string {
  return (process.env.GITHUB_SHA ?? process.env.GIT_SHA ?? "local").slice(0, 12);
}
