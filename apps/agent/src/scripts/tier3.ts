// Usage: pnpm --filter @taxxy/agent tier3 [deterministic|agent] [profileId]
import { gitSha, langfuseClient, postExperiment } from "@taxxy/evals";
import { formatSummary, loadProfiles, runProfile, summarize } from "../evals/tier3.js";

const mode = (process.argv[2] as "deterministic" | "agent" | undefined) ?? "deterministic";
const only = process.argv[3];
const profiles = loadProfiles().filter((p) => !only || p.id === only);
const results = [];
for (const p of profiles) {
  const r = await runProfile(p, { mode, keepTranscript: mode === "agent" });
  results.push(r);
  console.log(`${r.profile} ${r.pass ? "ok" : "FAIL"}`);
}
const summary = summarize(results);
console.log(formatSummary(summary));
const lf = langfuseClient();
if (lf) {
  await postExperiment(
    lf,
    `taxxy-tier3-${mode}`,
    gitSha(),
    results.map((r) => ({
      item: {
        id: r.profile,
        input: { profile: r.profile, mode },
        expectedOutput: { installmentDue: r.details.expected },
      },
      output: {
        installmentDue: r.details.installmentDue,
        gates: r.gates,
        transcript: r.transcript,
      },
      scores: [
        { name: "tier3_pass", value: r.pass ? 1 : 0 },
        { name: "estimate_accepted", value: r.accepted ? 1 : 0 },
        { name: "estimate_edited", value: r.edited ? 1 : 0 },
        { name: "uncategorized_rate", value: r.uncategorizedRateBefore },
        {
          name: "review_queue_size",
          value: r.queueDiff.extra.length + (r.details.stray as unknown[]).length,
        },
      ],
    })),
    { mode, profiles: results.length },
  );
  console.log("posted to Langfuse experiment");
}
process.exit(summary.gates.pass ? 0 : 1);
