import { readFileSync } from "node:fs";
import {
  type CategorizationContext,
  type Categorizer,
  categorizeTransactions,
  type Decision,
  type Label,
  type ModelLabel,
  type NormalizedTransaction,
} from "@taxxy/integrations";

export interface Tier2Fixture {
  profile: string;
  context: {
    businessDescription: string | null;
    mostlyBusinessAccounts: string[];
    linkedAccountIds: string[];
    payers: { counterparty: string; is_income: boolean }[];
    merchantRules: {
      merchant_key: string;
      label: ModelLabel;
      is_business: boolean;
      condition?: string | null;
    }[];
    recentUserLabels: {
      merchant_key: string | null;
      description: string;
      amount: number;
      label: ModelLabel;
      is_business: boolean;
    }[];
  };
  transactions: Array<NormalizedTransaction & { expected: { label: Label; is_business: boolean } }>;
}

export function loadFixture(path: string | URL): Tier2Fixture {
  return JSON.parse(readFileSync(path, "utf8")) as Tier2Fixture;
}

export function contextFrom(f: Tier2Fixture): CategorizationContext {
  return {
    businessDescription: f.context.businessDescription,
    mostlyBusinessAccounts: new Set(f.context.mostlyBusinessAccounts),
    linkedAccountIds: new Set(f.context.linkedAccountIds),
    payers: f.context.payers,
    merchantRules: f.context.merchantRules,
    recentUserLabels: f.context.recentUserLabels,
  };
}

export interface LabelStats {
  label: string;
  support: number;
  precision: number;
  recall: number;
  f1: number;
}

export interface Tier2Report {
  profile: string;
  n: number;
  labelAccuracy: number;
  businessF1: number;
  businessPrecision: number;
  businessRecall: number;
  ece: number;
  autoRate: number;
  autoAccuracy: number;
  queuedAccuracy: number;
  perLabel: LabelStats[];
  calibration: Array<{ bucket: string; n: number; confidence: number; accuracy: number }>;
  gates: { businessF1: boolean; ece: boolean; pass: boolean };
}

export const GATES = { businessF1: 0.92, ece: 0.05 };

function f1(p: number, r: number): number {
  return p + r === 0 ? 0 : (2 * p * r) / (p + r);
}

/** Precision/recall per label, business-vs-personal F1, and ECE over 10 confidence buckets. */
export function score(f: Tier2Fixture, decisions: Decision[]): Tier2Report {
  const byId = new Map(decisions.map((d) => [d.plaid_txn_id, d]));
  const pairs = f.transactions.map((t) => ({ t, d: byId.get(t.plaid_txn_id) as Decision }));
  const n = pairs.length;
  const labels = [...new Set(pairs.flatMap((p) => [p.t.expected.label, p.d.label]))].sort();
  const perLabel: LabelStats[] = labels.map((label) => {
    const tp = pairs.filter((p) => p.d.label === label && p.t.expected.label === label).length;
    const fp = pairs.filter((p) => p.d.label === label && p.t.expected.label !== label).length;
    const fn = pairs.filter((p) => p.d.label !== label && p.t.expected.label === label).length;
    const precision = tp + fp ? tp / (tp + fp) : 0;
    const recall = tp + fn ? tp / (tp + fn) : 0;
    return { label, support: tp + fn, precision, recall, f1: f1(precision, recall) };
  });
  const btp = pairs.filter((p) => p.d.is_business && p.t.expected.is_business).length;
  const bfp = pairs.filter((p) => p.d.is_business && !p.t.expected.is_business).length;
  const bfn = pairs.filter((p) => !p.d.is_business && p.t.expected.is_business).length;
  const businessPrecision = btp + bfp ? btp / (btp + bfp) : 0;
  const businessRecall = btp + bfn ? btp / (btp + bfn) : 0;
  const correct = (p: (typeof pairs)[number]) =>
    p.d.label === p.t.expected.label && p.d.is_business === p.t.expected.is_business;

  const buckets = Array.from({ length: 10 }, (_, i) => ({
    lo: i / 10,
    hi: (i + 1) / 10,
    items: [] as typeof pairs,
  }));
  for (const p of pairs) {
    const idx = Math.min(9, Math.floor(p.d.confidence * 10));
    buckets[idx]?.items.push(p);
  }
  let ece = 0;
  const calibration = buckets
    .filter((b) => b.items.length)
    .map((b) => {
      const conf = b.items.reduce((a, p) => a + p.d.confidence, 0) / b.items.length;
      const acc = b.items.filter(correct).length / b.items.length;
      ece += (b.items.length / n) * Math.abs(acc - conf);
      return {
        bucket: `${b.lo.toFixed(1)}-${b.hi.toFixed(1)}`,
        n: b.items.length,
        confidence: conf,
        accuracy: acc,
      };
    });
  const auto = pairs.filter((p) => p.d.status === "auto");
  const queued = pairs.filter((p) => p.d.status === "uncertain");
  const businessF1 = f1(businessPrecision, businessRecall);
  const gates = { businessF1: businessF1 >= GATES.businessF1, ece: ece <= GATES.ece, pass: false };
  gates.pass = gates.businessF1 && gates.ece;
  return {
    profile: f.profile,
    n,
    labelAccuracy: pairs.filter(correct).length / n,
    businessF1,
    businessPrecision,
    businessRecall,
    ece,
    autoRate: auto.length / n,
    autoAccuracy: auto.length ? auto.filter(correct).length / auto.length : 0,
    queuedAccuracy: queued.length ? queued.filter(correct).length / queued.length : 0,
    perLabel,
    calibration,
    gates,
  };
}

export async function runTier2(
  f: Tier2Fixture,
  categorizer: Categorizer | null,
  threshold = 0.8,
): Promise<Tier2Report> {
  const decisions = await categorizeTransactions(f.transactions, contextFrom(f), categorizer, {
    threshold,
  });
  return score(f, decisions);
}

/** Answers with the fixture's expected labels at a fixed confidence: a ceiling for the harness. */
export function oracleCategorizer(f: Tier2Fixture, confidence = 0.9): Categorizer {
  const exp = new Map(f.transactions.map((t) => [t.plaid_txn_id, t.expected]));
  return {
    model: "oracle",
    async categorize(items) {
      return items.map((i) => {
        const match = f.transactions.find(
          (t) =>
            (t.normalized_description || t.description) === i.description &&
            t.amount === i.amount &&
            t.date === i.date,
        );
        const e = match ? exp.get(match.plaid_txn_id) : undefined;
        return {
          ref: i.ref,
          label: (e?.label ?? "personal") as ModelLabel,
          isBusiness: e?.is_business ?? false,
          confidence,
          rationale: "oracle",
        };
      });
    },
  };
}

export function formatReport(r: Tier2Report): string {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const lines = [
    `Tier 2 — ${r.profile} (n=${r.n})`,
    `label accuracy ${pct(r.labelAccuracy)} · business F1 ${r.businessF1.toFixed(3)} (P ${pct(r.businessPrecision)} / R ${pct(r.businessRecall)}) · ECE ${r.ece.toFixed(3)}`,
    `auto ${pct(r.autoRate)} of items, accuracy ${pct(r.autoAccuracy)}; queued accuracy ${pct(r.queuedAccuracy)}`,
    `gates: business F1 ≥ ${GATES.businessF1} ${r.gates.businessF1 ? "PASS" : "FAIL"}, ECE ≤ ${GATES.ece} ${r.gates.ece ? "PASS" : "FAIL"}`,
    "per label (support, P, R, F1):",
    ...r.perLabel.map(
      (l) =>
        `  ${l.label.padEnd(24)} ${String(l.support).padStart(3)}  ${l.precision.toFixed(2)}  ${l.recall.toFixed(2)}  ${l.f1.toFixed(2)}`,
    ),
    "calibration:",
    ...r.calibration.map(
      (c) =>
        `  ${c.bucket}  n=${c.n}  conf=${c.confidence.toFixed(2)}  acc=${c.accuracy.toFixed(2)}`,
    ),
  ];
  return lines.join("\n");
}
