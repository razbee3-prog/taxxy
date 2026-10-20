import { type Actor, recordAudit } from "../audit.js";
import type { Row, ScopedDb } from "../tenancy.js";

export interface PriorYear {
  total_tax: number;
  agi: number;
  confirmed: boolean;
}

export interface TaxProfile extends Row {
  filing_status: "single";
  state: string | null;
  business_description: string | null;
  naics: string | null;
  w2_wages: number;
  w2_withholding_expected: number;
  prior_year: PriorYear | null;
  se_health_premiums: number;
  sep_contribution: number;
  home_office: boolean;
  complete: boolean;
}

export type TaxProfilePatch = Partial<Omit<TaxProfile, keyof Row>>;

export async function getTaxProfile(s: ScopedDb): Promise<TaxProfile | null> {
  const rows = await s.select<TaxProfile>("tax_profile", "true", {}, "LIMIT 1");
  return rows[0] ?? null;
}

/** One profile per user; every patch is audited with before/after. */
export async function upsertTaxProfile(
  s: ScopedDb,
  patch: TaxProfilePatch,
  actor: Actor = "agent",
): Promise<TaxProfile> {
  const before = await getTaxProfile(s);
  const after = before
    ? await s.update<TaxProfile>(before.id, patch)
    : await s.create<TaxProfile>("tax_profile", patch);
  await recordAudit(s, {
    actor,
    action: "tax_profile.upsert",
    target: after.id,
    before,
    after: patch,
  });
  return after;
}
