import { describe, expect, it } from "vitest";
import { canonicalJson, computeEstimate, ENGINE_VERSION, getConstants } from "../src/index.js";
import { annualInput } from "./helpers.js";

describe("determinism", () => {
  it("same input ⇒ byte-identical result across calls and key order", () => {
    const a = annualInput({
      priorYear: { totalTax: 8_000, agi: 70_000 },
      paymentsMadeThisYear: [{ amount: 1, date: "2026-04-01" }],
    });
    const reordered = JSON.parse(
      JSON.stringify(Object.fromEntries(Object.entries(a).reverse())),
    ) as typeof a;
    const r1 = computeEstimate(a);
    const r2 = computeEstimate(reordered);
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
    expect(r1.inputSnapshotId).toBe(r2.inputSnapshotId);
    expect(r1.inputSnapshotId).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("different input ⇒ different snapshot id", () => {
    const r1 = computeEstimate(annualInput());
    const r2 = computeEstimate(annualInput({ ytdBusinessIncome: 60_000.01 }));
    expect(r1.inputSnapshotId).not.toBe(r2.inputSnapshotId);
  });

  it("stamps engine and constants versions", () => {
    const r = computeEstimate(annualInput());
    expect(r.engineVersion).toBe(ENGINE_VERSION);
    expect(r.constantsVersion).toBe(getConstants(2026).constantsVersion);
    expect(r.disclaimer).toMatch(/not tax advice/);
  });

  it("canonicalJson sorts keys recursively and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: undefined, c: [{ z: 1, y: 2 }] } })).toBe(
      '{"a":{"c":[{"y":2,"z":1}]},"b":1}',
    );
  });
});
