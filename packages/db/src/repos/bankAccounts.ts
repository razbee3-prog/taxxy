import { type Row, type ScopedDb, toRecordId } from "../tenancy.js";

export interface BankAccount extends Row {
  bank_item: string;
  plaid_account_id: string;
  name: string;
  mask: string | null;
  type: string;
  mostly_business: boolean;
}

export interface AccountInput {
  plaid_account_id: string;
  name: string;
  mask: string | null;
  type: string;
}

export async function upsertBankAccounts(
  s: ScopedDb,
  bankItemId: string,
  accounts: AccountInput[],
): Promise<BankAccount[]> {
  const out: BankAccount[] = [];
  for (const a of accounts) {
    const id = `bank_account:${a.plaid_account_id}`;
    const existing = await s.get<BankAccount>(id);
    out.push(
      existing
        ? await s.update<BankAccount>(id, { name: a.name, mask: a.mask, type: a.type })
        : await s.createWithId<BankAccount>(id, {
            plaid_account_id: a.plaid_account_id,
            name: a.name,
            mask: a.mask,
            type: a.type,
            bank_item: toRecordId(bankItemId),
          }),
    );
  }
  return out;
}

export async function listBankAccounts(s: ScopedDb): Promise<BankAccount[]> {
  return s.select<BankAccount>("bank_account");
}

export async function setMostlyBusiness(
  s: ScopedDb,
  accountId: string,
  mostlyBusiness: boolean,
): Promise<BankAccount> {
  return s.update<BankAccount>(accountId, { mostly_business: mostlyBusiness });
}
