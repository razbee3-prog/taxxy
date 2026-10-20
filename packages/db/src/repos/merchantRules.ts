import { recordAudit } from "../audit.js";
import type { Row, ScopedDb } from "../tenancy.js";

export interface MerchantRuleRow extends Row {
  merchant_key: string;
  label: string;
  is_business: boolean;
  condition: string | null;
}

export async function listMerchantRules(s: ScopedDb): Promise<MerchantRuleRow[]> {
  return s.select<MerchantRuleRow>("merchant_rule", "true", {}, "ORDER BY merchant_key");
}

export async function setMerchantRule(
  s: ScopedDb,
  rule: { merchant_key: string; label: string; is_business: boolean; condition?: string | null },
): Promise<MerchantRuleRow> {
  const existing = (
    await s.select<MerchantRuleRow>("merchant_rule", "merchant_key = $k", { k: rule.merchant_key })
  )[0];
  const patch = { ...rule, condition: rule.condition ?? null };
  const row = existing
    ? await s.update<MerchantRuleRow>(existing.id, patch)
    : await s.create<MerchantRuleRow>("merchant_rule", patch);
  await recordAudit(s, {
    actor: "user",
    action: "merchant_rule.set",
    target: row.id,
    before: existing ?? null,
    after: patch,
  });
  return row;
}
