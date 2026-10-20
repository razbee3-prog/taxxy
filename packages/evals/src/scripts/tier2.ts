// Usage: pnpm --filter @taxxy/evals tier2 [fixture.json] — uses the live categorizer when LLM_API_KEY/ANTHROPIC_API_KEY is set.
import { readdirSync } from "node:fs";
import { formatReport, loadFixture, runTier2 } from "../tier2.js";

const dir = new URL("../../fixtures/tier2/", import.meta.url);
const files = process.argv[2]
  ? [process.argv[2]]
  : readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => new URL(f, dir).pathname);
const key = process.env.LLM_API_KEY ?? process.env.ANTHROPIC_API_KEY;
let categorizer = null;
if (key) {
  const { ChatAnthropic } = await import("@langchain/anthropic");
  const { llmCategorizer } = await import("@taxxy/integrations");
  const model = process.env.CATEGORIZER_MODEL ?? "claude-haiku-5-5";
  categorizer = llmCategorizer(new ChatAnthropic({ model, apiKey: key, maxTokens: 8192 }), model);
}
let allPass = true;
for (const f of files) {
  const report = await runTier2(
    loadFixture(f),
    categorizer,
    Number(process.env.CATEGORIZER_THRESHOLD ?? 0.8),
  );
  console.log(formatReport(report));
  console.log(`model: ${categorizer?.model ?? "rules only"}\n`);
  allPass &&= report.gates.pass;
}
if (!categorizer) console.log("(no LLM key: rules-only run, gates are informational)");
else if (!allPass) process.exitCode = 1;
