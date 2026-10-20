import { describe, expect, it } from "vitest";
import { gate, needsReceipt, withEvidence } from "../src/categorize/gate.js";
import { categorizeTransactions } from "../src/categorize/pipeline.js";
import { applyRules } from "../src/categorize/rules.js";
import type { CategorizationContext, Categorizer } from "../src/categorize/types.js";
import type { NormalizedTransaction } from "../src/plaid/types.js";

function txn(over: Partial<NormalizedTransaction>): NormalizedTransaction {
  return {
    plaid_txn_id: over.plaid_txn_id ?? Math.random().toString(36).slice(2),
    plaid_account_id: "acc_checking",
    date: "2026-03-02",
    amount: 42,
    description: "SOMETHING",
    normalized_description: "SOMETHING",
    merchant_key: null,
    plaid_pfc: null,
    counterparties: [],
    pending: false,
    pending_transaction_id: null,
    ...over,
  };
}

const ctx: CategorizationContext = {
  businessDescription: "freelance web developer",
  mostlyBusinessAccounts: new Set(["acc_checking"]),
  linkedAccountIds: new Set(["acc_checking", "acc_credit"]),
  payers: [{ counterparty: "Acme Corp", is_income: true }],
  merchantRules: [{ merchant_key: "adobe", label: "software_subscriptions", is_business: true }],
  recentUserLabels: [
    {
      merchant_key: "uber",
      description: "Uber",
      amount: 18,
      label: "personal",
      is_business: false,
    },
  ],
};

describe("rules", () => {
  it("payer list → income_1099 on inflows only", () => {
    expect(
      applyRules(txn({ amount: -2500, description: "ACH CREDIT ACME CORP PAYROLL" }), ctx)?.label,
    ).toBe("income_1099");
    expect(applyRules(txn({ amount: 2500, description: "ACME CORP" }), ctx)).toBeNull();
  });
  it("merchant rule", () => {
    const hit = applyRules(txn({ merchant_key: "adobe", amount: 59.99 }), ctx);
    expect(hit).toMatchObject({
      label: "software_subscriptions",
      is_business: true,
      confidence: 1,
      rule_id: "merchant:adobe",
    });
  });
  it("own-account transfer only when ≥ 2 accounts are linked", () => {
    const t = txn({ plaid_pfc: "TRANSFER_OUT_ACCOUNT_TRANSFER", amount: 1000 });
    expect(applyRules(t, ctx)?.label).toBe("transfer_out");
    expect(applyRules(t, { ...ctx, linkedAccountIds: new Set(["acc_checking"]) })).toBeNull();
  });
  it("exact prior user label for same merchant and sign", () => {
    expect(applyRules(txn({ merchant_key: "uber", amount: 23 }), ctx)?.label).toBe("personal");
    expect(applyRules(txn({ merchant_key: "uber", amount: -23 }), ctx)).toBeNull();
  });
});

describe("gate", () => {
  it("auto at or above threshold, uncertain below", () => {
    expect(gate(0.8)).toBe("auto");
    expect(gate(0.799)).toBe("uncertain");
    expect(gate(0.84, 0.85)).toBe("uncertain");
  });
  it("needs_receipt for business expenses ≥ $75 without evidence; evidence bumps confidence", () => {
    expect(needsReceipt({ label: "supplies", is_business: true }, 75, false)).toBe(true);
    expect(needsReceipt({ label: "supplies", is_business: true }, 74.99, false)).toBe(false);
    expect(needsReceipt({ label: "supplies", is_business: true }, 500, true)).toBe(false);
    expect(needsReceipt({ label: "income_1099", is_business: true }, 500, false)).toBe(false);
    expect(withEvidence(0.75)).toBe(0.85);
    expect(withEvidence(0.95)).toBe(1);
  });
});

describe("pipeline", () => {
  const fake: Categorizer = {
    model: "fake",
    async categorize(items) {
      return items.map((i) => ({
        ref: i.ref,
        label: i.description.includes("STARBUCKS") ? "meals" : "office",
        isBusiness: true,
        confidence: i.description.includes("STARBUCKS") ? 0.55 : 0.9,
        rationale: "fake",
      }));
    },
  };
  it("rules first, then the model, then the gate; order preserved", async () => {
    const txns = [
      txn({ plaid_txn_id: "a", amount: -2500, description: "ACME CORP" }),
      txn({
        plaid_txn_id: "b",
        description: "STARBUCKS",
        normalized_description: "STARBUCKS",
        amount: 6,
      }),
      txn({
        plaid_txn_id: "c",
        description: "STAPLES",
        normalized_description: "STAPLES",
        amount: 120,
      }),
    ];
    const d = await categorizeTransactions(txns, ctx, fake);
    expect(d.map((x) => x.plaid_txn_id)).toEqual(["a", "b", "c"]);
    expect(d[0]).toMatchObject({ source: "rule", status: "auto", label: "income_1099" });
    expect(d[1]).toMatchObject({
      source: "llm",
      status: "uncertain",
      label: "meals",
      model: "fake",
    });
    expect(d[2]).toMatchObject({
      source: "llm",
      status: "auto",
      label: "office",
      needs_receipt: true,
    });
  });
  it("without a categorizer, unmatched items go to the queue with confidence 0", async () => {
    const d = await categorizeTransactions([txn({ description: "MYSTERY" })], ctx, null);
    expect(d[0]).toMatchObject({ status: "uncertain", confidence: 0 });
  });
});
