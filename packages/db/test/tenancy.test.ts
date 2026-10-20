import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listAudit, recordAudit } from "../src/audit.js";
import { createBankItem, listBankItems, withAccessToken } from "../src/repos/bankItems.js";
import { acceptEstimate, insertEstimate, listEstimates } from "../src/repos/estimates.js";
import { getTaxProfile, upsertTaxProfile } from "../src/repos/taxProfile.js";
import { ensureUser } from "../src/repos/users.js";
import { scoped, TenancyError } from "../src/tenancy.js";
import { Vault } from "../src/vault.js";
import { reachable, SKIP_REASON, testDb } from "./setup.js";

const up = await reachable();
if (!up && process.env.CI) throw new Error(SKIP_REASON);

describe.skipIf(!up)("tenancy + app tables (SurrealDB)", () => {
  let t: Awaited<ReturnType<typeof testDb>>;
  const vault = new Vault(Vault.generateKey());
  beforeAll(async () => {
    t = await testDb("tenancy");
    await ensureUser(t.db, "alice", "alice@example.com");
    await ensureUser(t.db, "bob", "bob@example.com");
  });
  afterAll(async () => t?.close());

  it("applies the schema once and is idempotent", async () => {
    const [rows] = await t.db.query<[{ name: string }[]]>("SELECT name FROM _migration");
    expect(rows?.map((r) => r.name).sort()).toEqual([
      "001_init.surql",
      "002_needs_receipt.surql",
      "003_gmail.surql",
      "004_credential.surql",
    ]);
    const { migrate } = await import("../src/migrate.js");
    expect(await migrate(t.db)).toEqual([]);
  });

  it("tax_profile upsert is one-per-user and audited", async () => {
    const alice = scoped(t.db, "alice");
    expect(await getTaxProfile(alice)).toBeNull();
    const p1 = await upsertTaxProfile(alice, { state: "CA", w2_wages: 1000 }, "user");
    const p2 = await upsertTaxProfile(alice, {
      prior_year: { total_tax: 8000, agi: 70000, confirmed: true },
    });
    expect(p2.id).toBe(p1.id);
    expect(p2.state).toBe("CA");
    expect(p2.prior_year?.total_tax).toBe(8000);
    expect(p2.user).toBe("user:alice");
    const audit = await listAudit(alice, p1.id);
    expect(audit).toHaveLength(2);
    expect(audit.map((a) => a.actor).sort()).toEqual(["agent", "user"]);
  });

  it("cross-user reads return nothing and cross-user writes throw", async () => {
    const alice = scoped(t.db, "alice");
    const bob = scoped(t.db, "bob");
    const ap = await getTaxProfile(alice);
    if (!ap) throw new Error("alice profile missing");
    expect(await getTaxProfile(bob)).toBeNull();
    expect(await bob.get(ap.id)).toBeNull();
    expect(await bob.select("tax_profile")).toEqual([]);
    await expect(bob.update(ap.id, { state: "NY" })).rejects.toBeInstanceOf(TenancyError);
    expect(await bob.delete(ap.id)).toBe(false);
    expect((await alice.get(ap.id))?.id).toBe(ap.id);
    // the scope cannot be overridden by the caller
    await expect(bob.create("tax_profile", { user: "user:alice" })).rejects.toBeInstanceOf(
      TenancyError,
    );
    await expect(bob.select("tax_profile", "true", { user: "user:alice" })).rejects.toBeInstanceOf(
      TenancyError,
    );
    expect(() => scoped(t.db, "alice OR true")).toThrow(TenancyError);
  });

  it("schema rejects rows without a user or with bad enums", async () => {
    await expect(t.db.query("CREATE tax_profile SET state = 'CA'")).rejects.toThrow();
    const alice = scoped(t.db, "alice");
    await expect(
      alice.create("payment", { amount: 1, method: "wire", paid_at: "2026-04-01" }),
    ).rejects.toThrow();
  });

  it("bank_item hides the sealed token and only opens it inside withAccessToken", async () => {
    const alice = scoped(t.db, "alice");
    const bob = scoped(t.db, "bob");
    const item = await createBankItem(alice, vault, {
      plaid_item_id: "item-1",
      access_token: "access-sandbox-xyz",
      institution: "Chase",
    });
    expect(item).not.toHaveProperty("access_token_enc");
    expect(JSON.stringify(await listBankItems(alice))).not.toContain("access-sandbox");
    expect(await withAccessToken(alice, vault, item.id, async (tok) => tok)).toBe(
      "access-sandbox-xyz",
    );
    await expect(withAccessToken(bob, vault, item.id, async (tok) => tok)).rejects.toThrow(
      /not found/,
    );
    const [raw] = await t.db.query<[{ access_token_enc: string }[]]>(
      "SELECT access_token_enc FROM bank_item",
    );
    expect(raw?.[0]?.access_token_enc).toMatch(/^v1\./);
  });

  it("estimates persist snapshot + result and accept/edit is audited", async () => {
    const alice = scoped(t.db, "alice");
    const e = await insertEstimate(alice, {
      tax_year: 2026,
      quarter: 4,
      input_snapshot: { ytdBusinessIncome: 60000 },
      result: { installmentDue: 10833.48, lines: [{ id: "1", value: 60000 }] },
      engine_version: "1.0.0",
      constants_version: "2026.1",
    });
    expect(e.status).toBe("draft");
    const accepted = await acceptEstimate(alice, e.id);
    expect(accepted.status).toBe("accepted");
    const edited = await acceptEstimate(alice, e.id, { installmentDue: 10000 });
    expect(edited.status).toBe("edited");
    expect((await listEstimates(alice, 2026)).map((x) => x.id)).toEqual([e.id]);
    expect(await listEstimates(scoped(t.db, "bob"))).toEqual([]);
    const audit = await listAudit(alice, e.id);
    expect(audit.map((a) => a.action)).toEqual([
      "estimate.accept",
      "estimate.accept",
      "estimate.create",
    ]);
  });

  it("audit events are append-only records with before/after", async () => {
    const alice = scoped(t.db, "alice");
    const ev = await recordAudit(alice, {
      actor: "system",
      action: "test",
      target: "x",
      before: { a: 1 },
      after: { a: 2 },
    });
    expect(ev.before).toEqual({ a: 1 });
    expect(ev.after).toEqual({ a: 2 });
  });
});
