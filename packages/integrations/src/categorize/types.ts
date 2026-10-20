import type { NormalizedTransaction } from "../plaid/types.js";
import type { Label, ModelLabel } from "./taxonomy.js";

export type Source = "rule" | "llm" | "user";
export type Status = "auto" | "uncertain" | "accepted";

export interface Decision {
  plaid_txn_id: string;
  label: Label;
  is_business: boolean;
  confidence: number;
  source: Source;
  status: Status;
  rationale: string;
  rule_id?: string;
  model?: string;
  needs_receipt: boolean;
}

export interface MerchantRule {
  merchant_key: string;
  label: ModelLabel;
  is_business: boolean;
  condition?: string | null;
}

export interface Payer {
  counterparty: string;
  is_income: boolean;
}

export interface UserLabel {
  merchant_key: string | null;
  description: string;
  amount: number;
  label: ModelLabel;
  is_business: boolean;
}

/** Everything the rules and the model may see about the user. No ids, no tokens. */
export interface CategorizationContext {
  businessDescription: string | null;
  mostlyBusinessAccounts: Set<string>;
  linkedAccountIds: Set<string>;
  payers: Payer[];
  merchantRules: MerchantRule[];
  recentUserLabels: UserLabel[];
}

export interface CategorizerItem {
  ref: string;
  date: string;
  amount: number;
  description: string;
  merchant_key: string | null;
  plaid_pfc: string | null;
  counterparties: string[];
  account_mostly_business: boolean;
}

export interface CategorizerOutput {
  ref: string;
  label: ModelLabel;
  isBusiness: boolean;
  confidence: number;
  rationale: string;
}

/** The `categorizer` subagent: stateless, one batch in, one structured report back. */
export interface Categorizer {
  readonly model: string;
  categorize(items: CategorizerItem[], ctx: CategorizationContext): Promise<CategorizerOutput[]>;
}

export type TransactionLike = NormalizedTransaction;
