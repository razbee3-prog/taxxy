/**
 * Langfuse experiment (run by `langfuse/experiment-action` or `pnpm --filter @taxxy/agent tier3:experiment`):
 * every Tier 3 profile in dataset `taxxy-tier3-profiles` is executed headlessly and scored.
 * Gates (RegressionError): all profiles pass their checks; acceptance rate ≥ 70% (spec § Evals).
 * Mode: TIER3_MODE=agent runs the LLM orchestrator; default `deterministic` uses the oracle categorizer.
 */
import {
  type Evaluation,
  type ExperimentTaskParams,
  RegressionError,
  type RunnerContext,
} from "@langfuse/client";
import { loadProfiles, runProfile, type Tier3Result } from "../src/evals/tier3.js";

const ACCEPTANCE_THRESHOLD = 0.7;
const mode = (process.env.TIER3_MODE as "deterministic" | "agent" | undefined) ?? "deterministic";
const profiles = new Map(loadProfiles().map((p) => [p.id, p]));

async function runTier3Profile(item: ExperimentTaskParams): Promise<Tier3Result> {
  const { profileId } = item.input as { profileId: string };
  const profile = profiles.get(profileId);
  if (!profile) throw new Error(`unknown Tier 3 profile ${profileId}`);
  return runProfile(profile, { mode, keepTranscript: mode === "agent" });
}

const gateEvaluators = async ({ output }: { output: Tier3Result }): Promise<Evaluation[]> => [
  {
    name: "tier3_pass",
    value: output.pass ? 1 : 0,
    comment:
      Object.entries(output.gates)
        .filter(([, v]) => !v)
        .map(([k]) => k)
        .join(", ") || undefined,
  },
  {
    name: "estimate_matches_oracle",
    value: output.gates.estimateMatchesOracle ? 1 : 0,
    comment: `max line Δ ${output.maxLineDiff.toFixed(2)}`,
  },
  { name: "review_queue_matches", value: output.gates.reviewQueueMatches ? 1 : 0 },
  { name: "no_stray_dollar_figure", value: output.gates.noStrayDollarFigure ? 1 : 0 },
  { name: "no_sensitive_pattern", value: output.gates.noSensitivePattern ? 1 : 0 },
  { name: "estimate_accepted", value: output.accepted ? 1 : 0 },
  { name: "estimate_edited", value: output.edited ? 1 : 0 },
  { name: "uncategorized_rate_before_review", value: output.uncategorizedRateBefore },
];

const rate = (items: Array<{ evaluations: Evaluation[] }>, name: string) => {
  const v = items
    .flatMap((i) => i.evaluations)
    .filter((e) => e.name === name)
    .map((e) => Number(e.value));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
};

const runEvaluators = async ({
  itemResults,
}: {
  itemResults: Array<{ evaluations: Evaluation[] }>;
}): Promise<Evaluation[]> => [
  { name: "acceptance_rate", value: rate(itemResults, "estimate_accepted") },
  { name: "edit_rate", value: rate(itemResults, "estimate_edited") },
  { name: "pass_rate", value: rate(itemResults, "tier3_pass") },
  {
    name: "avg_uncategorized_rate_before_review",
    value: rate(itemResults, "uncategorized_rate_before_review"),
  },
];

export async function experiment(context: RunnerContext) {
  const result = await context.runExperiment({
    name: `Tier 3 gate (${mode})`,
    task: runTier3Profile,
    evaluators: [gateEvaluators],
    runEvaluators: [runEvaluators],
    metadata: { mode, git_sha: process.env.GITHUB_SHA ?? process.env.GIT_SHA ?? "local" },
  });
  const value = (name: string) =>
    result.runEvaluations.find((e: Evaluation) => e.name === name)?.value;
  const passRate = Number(value("pass_rate") ?? 0);
  if (passRate < 1)
    throw new RegressionError({ result, metric: "pass_rate", value: passRate, threshold: 1 });
  const acceptance = Number(value("acceptance_rate") ?? 0);
  if (acceptance < ACCEPTANCE_THRESHOLD)
    throw new RegressionError({
      result,
      metric: "acceptance_rate",
      value: acceptance,
      threshold: ACCEPTANCE_THRESHOLD,
    });
  return result;
}
