export interface PlaidAccountSummary {
  plaid_account_id: string;
  name: string;
  /** Last 4 digits only. */
  mask: string | null;
  type: string;
  subtype: string | null;
}

/** What Taxxy keeps from a Plaid transaction. `amount` keeps Plaid's sign: > 0 money out, < 0 money in. */
export interface NormalizedTransaction {
  plaid_txn_id: string;
  plaid_account_id: string;
  date: string;
  amount: number;
  description: string;
  normalized_description: string;
  merchant_key: string | null;
  plaid_pfc: string | null;
  counterparties: string[];
  pending: boolean;
  pending_transaction_id: string | null;
}

export interface PlaidSyncPage {
  added: NormalizedTransaction[];
  modified: NormalizedTransaction[];
  removed: string[];
  nextCursor: string;
  hasMore: boolean;
}

export interface LinkedItem {
  itemId: string;
  accessToken: string;
  institution: string | null;
  accounts: PlaidAccountSummary[];
}

/** The slice of Plaid the app uses; `sandboxPlaid()` and `fixturePlaid()` implement the same shape. */
export interface PlaidClientLike {
  createLinkToken(
    userId: string,
    webhookUrl?: string,
  ): Promise<{ linkToken: string; expiration: string }>;
  exchangePublicToken(publicToken: string): Promise<LinkedItem>;
  syncTransactions(accessToken: string, cursor: string | null): Promise<PlaidSyncPage>;
  /** Sandbox only: mint a public token for a test institution. */
  sandboxPublicToken?(): Promise<string>;
}

export class PlaidItemLoginRequired extends Error {
  constructor(public readonly itemId: string) {
    super(`Plaid item ${itemId} needs the user to re-link (ITEM_LOGIN_REQUIRED)`);
    this.name = "PlaidItemLoginRequired";
  }
}
