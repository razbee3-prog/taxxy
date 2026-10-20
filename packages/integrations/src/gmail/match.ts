export interface ReceiptCandidate {
  key: string;
  vendor: string | null;
  total: number | null;
  date: string | null;
}

export interface TxnCandidate {
  id: string;
  amount: number;
  date: string;
  description: string;
  merchant_key: string | null;
}

export const MATCH_THRESHOLD = 0.6;

function days(a: string, b: string): number {
  return Math.abs((Date.parse(a) - Date.parse(b)) / 86_400_000);
}

function tokens(s: string | null): Set<string> {
  return new Set(
    (s ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2),
  );
}

/** Amount match dominates; date proximity and vendor overlap break ties. */
export function scoreReceiptMatch(r: ReceiptCandidate, t: TxnCandidate): number {
  if (r.total === null || t.amount <= 0) return 0;
  const diff = Math.abs(r.total - t.amount);
  let score = diff < 0.005 ? 0.6 : diff / t.amount <= 0.02 ? 0.4 : 0;
  if (score === 0) return 0;
  if (r.date) {
    const d = days(r.date, t.date);
    score += d <= 1 ? 0.25 : d <= 3 ? 0.2 : d <= 7 ? 0.1 : 0;
  }
  const rv = tokens(r.vendor);
  const tv = new Set([
    ...tokens(t.description),
    ...tokens((t.merchant_key ?? "").replace(/_/g, " ")),
  ]);
  if ([...rv].some((x) => tv.has(x))) score += 0.15;
  return Math.min(1, Math.round(score * 1000) / 1000);
}

export interface Match {
  receiptKey: string;
  transactionId: string;
  score: number;
}

/** Greedy one-to-one assignment by descending score, keeping pairs at or above the threshold. */
export function matchReceipts(
  receipts: ReceiptCandidate[],
  txns: TxnCandidate[],
  threshold = MATCH_THRESHOLD,
): Match[] {
  const pairs: Match[] = [];
  for (const r of receipts)
    for (const t of txns) {
      const score = scoreReceiptMatch(r, t);
      if (score >= threshold) pairs.push({ receiptKey: r.key, transactionId: t.id, score });
    }
  pairs.sort((a, b) => b.score - a.score);
  const usedR = new Set<string>();
  const usedT = new Set<string>();
  const out: Match[] = [];
  for (const p of pairs) {
    if (usedR.has(p.receiptKey) || usedT.has(p.transactionId)) continue;
    usedR.add(p.receiptKey);
    usedT.add(p.transactionId);
    out.push(p);
  }
  return out;
}
