import { describe, expect, it } from "vitest";
import { fixturePlaid } from "../src/plaid/client.js";
import { merchantKey, normalizeDescription, normalizeTransaction } from "../src/plaid/normalize.js";
import { loadSandboxFixture } from "./fixture.js";

describe("normalize", () => {
  it("strips card suffixes, dates and reference numbers", () => {
    expect(normalizeDescription("Uber 063015 SF**POOL**")).toBe("Uber SF POOL");
    expect(normalizeDescription("CREDIT CARD 3333 PAYMENT *//")).toBe("CREDIT 3333");
    expect(normalizeDescription("ACH Electronic CreditGUSTO PAY 123456")).toBe("CreditGUSTO PAY");
    expect(normalizeDescription("AMZN Mktp US*2K4Y78 ref 1234567890 xxxx4321 01/14")).toBe(
      "AMZN Mktp US 2K4Y78",
    );
  });

  it("derives a stable merchant key from merchant_name, counterparties or the description", () => {
    const fx = loadSandboxFixture();
    const uber = fx.added.find((t) => t.name.startsWith("Uber"));
    const uber2 = fx.added.filter((t) => t.name.startsWith("Uber"));
    expect(merchantKey(uber as never)).toBe("uber");
    expect(new Set(uber2.map((t) => merchantKey(t as never))).size).toBe(1);
    expect(
      merchantKey({ merchant_name: null, name: "Tectra Inc", counterparties: [] } as never),
    ).toBe("tectra");
  });

  it("normalizes a Plaid transaction into the stored shape (no raw JSON, no account numbers)", () => {
    const fx = loadSandboxFixture();
    const t = normalizeTransaction(fx.added[0] as never);
    expect(Object.keys(t).sort()).toEqual([
      "amount",
      "counterparties",
      "date",
      "description",
      "merchant_key",
      "normalized_description",
      "pending",
      "pending_transaction_id",
      "plaid_account_id",
      "plaid_pfc",
      "plaid_txn_id",
    ]);
    expect(t.plaid_pfc).toMatch(/^[A-Z_]+$/);
  });

  it("fixturePlaid pages through the fixture and then serves queued updates", async () => {
    const fx = loadSandboxFixture();
    const p = fixturePlaid(fx, { pageSize: 7 });
    const item = await p.exchangePublicToken(
      await (p.sandboxPublicToken as () => Promise<string>)(),
    );
    expect(item.accounts.every((a) => !a.mask || a.mask.length <= 4)).toBe(true);
    let cursor: string | null = null;
    const got: string[] = [];
    for (let i = 0; i < 10; i++) {
      const page = await p.syncTransactions(item.accessToken, cursor);
      got.push(...page.added.map((t) => t.plaid_txn_id));
      cursor = page.nextCursor;
      if (!page.hasMore) break;
    }
    expect(got).toHaveLength(fx.added.length);
    p.queueUpdate({
      added: [],
      modified: [fx.added[0] as never],
      removed: [{ transaction_id: fx.added[1]?.transaction_id as string, account_id: "x" }],
    });
    const upd = await p.syncTransactions(item.accessToken, cursor);
    expect(upd.modified).toHaveLength(1);
    expect(upd.removed).toEqual([fx.added[1]?.transaction_id]);
  });
});
