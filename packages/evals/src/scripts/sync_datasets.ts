// Pushes the Tier 3 profile matrix to Langfuse as dataset `taxxy-tier3-profiles` (one item per profile; idempotent).
// Usage: pnpm --filter @taxxy/evals sync-datasets   (needs LANGFUSE_* keys)
import { readdirSync, readFileSync } from "node:fs";
import { langfuseClient, syncDataset } from "../langfuse.js";

interface ProfileFile {
  id: string;
  _note: string;
  matrix: Record<string, unknown>;
  expectedReviewQueue: string[];
  expectedEstimate: {
    quarter: number;
    result: { installmentDue: number; dueDate: string; safeHarborUsed: string };
  };
}

const dir = new URL("../../fixtures/tier3/", import.meta.url);
const profiles = readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => JSON.parse(readFileSync(new URL(f, dir), "utf8")) as ProfileFile);

const client = langfuseClient();
if (!client) {
  console.error("LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY not set");
  process.exit(1);
}
await syncDataset(
  client,
  "taxxy-tier3-profiles",
  "Tier 3 end-to-end profiles (placeholder data). input = profile id; expectedOutput = engine worksheet + review queue.",
  profiles.map((p) => ({
    id: p.id,
    input: { profileId: p.id, taxYear: 2026, quarter: p.expectedEstimate.quarter },
    expectedOutput: {
      installmentDue: p.expectedEstimate.result.installmentDue,
      dueDate: p.expectedEstimate.result.dueDate,
      safeHarborUsed: p.expectedEstimate.result.safeHarborUsed,
      reviewQueue: p.expectedReviewQueue,
    },
    metadata: { ...p.matrix, placeholder: true, note: p._note },
  })),
);
await client.flush();
console.log(`synced ${profiles.length} items to taxxy-tier3-profiles`);
