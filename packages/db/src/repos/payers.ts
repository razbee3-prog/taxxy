import { recordAudit } from "../audit.js";
import type { Row, ScopedDb } from "../tenancy.js";

export interface PayerRow extends Row {
  counterparty: string;
  is_income: boolean;
  confirmed_at: string | null;
  source: "plaid" | "user" | "agent";
}

export async function listPayers(s: ScopedDb): Promise<PayerRow[]> {
  return s.select<PayerRow>("payer", "true", {}, "ORDER BY counterparty");
}

export async function setPayer(
  s: ScopedDb,
  counterparty: string,
  isIncome: boolean,
  source: PayerRow["source"] = "user",
): Promise<PayerRow> {
  const existing = (await s.select<PayerRow>("payer", "counterparty = $c", { c: counterparty }))[0];
  const patch = {
    counterparty,
    is_income: isIncome,
    source,
    confirmed_at:
      source === "user"
        ? new Date()
        : existing?.confirmed_at
          ? new Date(existing.confirmed_at)
          : null,
  };
  const row = existing
    ? await s.update<PayerRow>(existing.id, patch)
    : await s.create<PayerRow>("payer", patch);
  await recordAudit(s, {
    actor: source === "user" ? "user" : "agent",
    action: "payer.set",
    target: row.id,
    before: existing ?? null,
    after: patch,
  });
  return row;
}
