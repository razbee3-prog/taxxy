import { describe, expect, it } from "vitest";
import { loadFixture, oracleCategorizer, runTier2, score } from "../src/tier2.js";

const f = loadFixture(new URL("../fixtures/tier2/placeholder-contractor-01.json", import.meta.url));

describe("Tier 2 harness", () => {
  it("fixture is well-formed", () => {
    expect(f.transactions.length).toBeGreaterThanOrEqual(40);
    expect(new Set(f.transactions.map((t) => t.plaid_txn_id)).size).toBe(f.transactions.length);
  });

  it("oracle categorizer hits the ceiling: F1 = 1, ECE = 1 − confidence for the model share", async () => {
    const r = await runTier2(f, oracleCategorizer(f, 0.9));
    expect(r.businessF1).toBe(1);
    expect(r.labelAccuracy).toBe(1);
    expect(r.autoRate).toBe(1);
    const ruleShare = r.calibration.find((c) => c.bucket === "0.9-1.0")?.n ?? 0;
    expect(ruleShare).toBe(f.transactions.length);
    expect(r.ece).toBeCloseTo((0.1 * (r.n - rulesHit(r))) / r.n, 6);
    expect(r.gates.businessF1).toBe(true);
  });

  it("rules-only run queues everything the rules miss and still scores", async () => {
    const r = await runTier2(f, null);
    expect(r.autoRate).toBeGreaterThan(0);
    expect(r.autoAccuracy).toBe(1); // deterministic rules never contradict the labels in this fixture
    expect(r.autoRate).toBeLessThan(0.5);
    expect(r.gates.pass).toBe(false);
  });

  it("score() computes per-label precision/recall and the ECE buckets", () => {
    const decisions = f.transactions.map((t, i) => ({
      plaid_txn_id: t.plaid_txn_id,
      label: i % 4 === 0 ? ("personal" as const) : t.expected.label,
      is_business: i % 4 === 0 ? false : t.expected.is_business,
      confidence: 0.8,
      source: "llm" as const,
      status: "auto" as const,
      rationale: "",
      needs_receipt: false,
    }));
    const r = score(f, decisions);
    const personal = r.perLabel.find((l) => l.label === "personal");
    expect(personal?.precision).toBeLessThan(1);
    expect(personal?.recall).toBe(1);
    expect(r.calibration).toHaveLength(1);
    expect(r.ece).toBeCloseTo(Math.abs(r.labelAccuracy - 0.8), 6);
  });
});

function rulesHit(r: {
  calibration: Array<{ bucket: string; n: number; confidence: number }>;
}): number {
  // rule decisions carry confidence 1.0 and sit in the top bucket with the 0.9 oracle ones; recover their count from the mean confidence
  const top = r.calibration.find((c) => c.bucket === "0.9-1.0");
  if (!top) return 0;
  return Math.round(((top.confidence - 0.9) / 0.1) * top.n);
}
