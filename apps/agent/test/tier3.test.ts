import { dbConfigFromEnv } from "@taxxy/db";
import { describe, expect, it } from "vitest";
import { loadProfiles, runProfile, summarize } from "../src/evals/tier3.js";

const cfg = dbConfigFromEnv();
async function reachable() {
  try {
    const u = new URL(cfg.app.url.replace(/^ws/, "http"));
    return (await fetch(`${u.origin}/health`, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    return false;
  }
}
const up = await reachable();
if (!up && process.env.CI) throw new Error("SurrealDB not reachable in CI");

describe.skipIf(!up)("Tier 3 runner (deterministic mode, 20 placeholder profiles)", () => {
  const profiles = loadProfiles();
  it("loads the 20-profile matrix", () => {
    expect(profiles).toHaveLength(20);
    expect(profiles.filter((p) => p.matrix.w2).length).toBe(5);
    expect(profiles.filter((p) => p.matrix.prior === "none").length).toBe(6);
    expect(profiles.filter((p) => p.matrix.prior === "110").length).toBe(4);
    expect(profiles.filter((p) => p.matrix.receipts).length).toBe(8);
  });

  it("every profile passes its gates and acceptance is ≥ 70%", async () => {
    const results = [];
    for (const p of profiles) results.push(await runProfile(p, { mode: "deterministic" }));
    const s = summarize(results);
    const failures = s.results
      .filter((r) => !r.pass)
      .map(
        (r) =>
          `${r.profile}: ${JSON.stringify({ gates: r.gates, queueDiff: r.queueDiff, details: r.details })}`,
      );
    expect(failures).toEqual([]);
    expect(s.acceptanceRate).toBeGreaterThanOrEqual(0.7);
    // Spec target is ≤ 10% on real data; placeholder profiles mark ~2 items/month ambiguous on purpose.
    expect(s.meanUncategorizedBefore).toBeLessThanOrEqual(0.2);
    expect(s.meanUncategorizedAfter).toBe(0);
  }, 300_000);
});
