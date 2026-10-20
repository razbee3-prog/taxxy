import { describe, expect, it } from "vitest";

describe("fixturePlaid isolateLinks", () => {
  it("gives every link distinct item/account/transaction ids that sync consistently", async () => {
    const { fixturePlaid } = await import("../src/plaid/client.js");
    const { readFileSync } = await import("node:fs");
    const fixture = JSON.parse(
      readFileSync(new URL("./fixtures/plaid-sandbox-sync.json", import.meta.url), "utf8"),
    );
    const p = fixturePlaid(fixture, { isolateLinks: true });
    const a = await p.exchangePublicToken("public-fixture");
    const b = await p.exchangePublicToken("public-fixture");
    expect(a.itemId).not.toBe(b.itemId);
    expect(a.accounts[0]?.plaid_account_id).not.toBe(b.accounts[0]?.plaid_account_id);
    const pageA = await p.syncTransactions(a.accessToken, null);
    const pageB = await p.syncTransactions(b.accessToken, null);
    expect(pageA.added[0]?.plaid_txn_id).not.toBe(pageB.added[0]?.plaid_txn_id);
    expect(new Set(a.accounts.map((x) => x.plaid_account_id))).toContain(
      pageA.added[0]?.plaid_account_id,
    );
    await expect(p.syncTransactions("access-fixture-bogus", null)).rejects.toThrow(
      /unknown access token/,
    );
  });
});
