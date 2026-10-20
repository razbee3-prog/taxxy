import {
  connectSurreal,
  currentCategorization,
  dbConfigFromEnv,
  ensureUser,
  listTransactions,
  reviewQueue,
  scoped,
} from "@taxxy/db";
import { type Categorizer, fixturePlaid } from "@taxxy/integrations";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv } from "../src/config.js";
import { type AppDeps, buildDeps, loadPlaidFixture } from "../src/deps.js";
import { plaidRoutes } from "../src/routes/plaid.js";
import { exchangePublicToken, syncItem } from "../src/services/plaid.js";
import { buildTools } from "../src/tools/index.js";

const cfg = dbConfigFromEnv();
async function reachable() {
  try {
    const u = new URL(cfg.app.url.replace(/^ws/, "http"));
    return (await fetch(`${u.origin}/health`, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    return false;
  }
}
const up = await reachable();
if (!up && process.env.CI) throw new Error("SurrealDB not reachable in CI");

/** Deterministic stand-in for the LLM: coffee and fast food are unsure, everything else confident office/personal. */
const fakeCategorizer: Categorizer = {
  model: "fake-categorizer",
  async categorize(items) {
    return items.map((i) => {
      const pfc = i.plaid_pfc ?? "";
      if (pfc.startsWith("FOOD_AND_DRINK"))
        return {
          ref: i.ref,
          label: "meals",
          isBusiness: true,
          confidence: 0.6,
          rationale: "could be a client meal",
        };
      if (pfc.startsWith("TRAVEL"))
        return {
          ref: i.ref,
          label: "travel",
          isBusiness: true,
          confidence: 0.9,
          rationale: "flight",
        };
      if (i.amount < 0)
        return {
          ref: i.ref,
          label: "income_other",
          isBusiness: false,
          confidence: 0.7,
          rationale: "unknown deposit",
        };
      return {
        ref: i.ref,
        label: "personal",
        isBusiness: false,
        confidence: 0.85,
        rationale: "looks personal",
      };
    });
  },
};

type AnyTool = { invoke: (input: unknown, config?: unknown) => Promise<string> };
function toolMap(deps: AppDeps): (name: string) => AnyTool {
  const map = new Map<string, AnyTool>(
    buildTools(deps).map((t) => [t.name, t as unknown as AnyTool]),
  );
  return (name) => {
    const tool = map.get(name);
    if (!tool) throw new Error(`no tool ${name}`);
    return tool;
  };
}

describe.skipIf(!up)(
  "Plaid link → sync → categorize → review queue (fixture Plaid, live SurrealDB)",
  () => {
    const ns = `test_agent_${Date.now().toString(36)}`;
    let d: AppDeps;
    const fixture = loadPlaidFixture();
    const plaid = fixturePlaid(fixture, { pageSize: 8 });
    const env = loadEnv({
      ...process.env,
      SURREAL_NS: ns,
      PLAID_MODE: "fixture",
      LLM_API_KEY: "",
      ANTHROPIC_API_KEY: "",
      PLAID_WEBHOOK_VERIFY: "false",
    });
    const alice = { configurable: { user_id: "alice" } };
    const bob = { configurable: { user_id: "bob" } };
    let itemId = "";

    beforeAll(async () => {
      const db = await connectSurreal({ ...cfg.app, namespace: ns });
      d = await buildDeps(env, { db, plaid, categorizer: fakeCategorizer });
      await ensureUser(d.db, "alice", "alice@example.com");
      await ensureUser(d.db, "bob", "bob@example.com");
    });
    afterAll(async () => {
      await d.db.query(`REMOVE NAMESPACE IF EXISTS ${ns}`);
      await d.db.close();
    });

    it("exchanges a public token, stores accounts with last-4 only, and pulls history across pages", async () => {
      const linked = await exchangePublicToken(d, "alice", "public-fixture");
      itemId = linked.itemId;
      expect(linked.accounts).toHaveLength(fixture.accounts.length);
      expect(linked.accounts.every((a) => !a.mask || a.mask.length <= 4)).toBe(true);
      const r = await syncItem(d, "alice", itemId);
      expect(r.added).toBe(fixture.added.length);
      expect(r.categorized.total).toBe(fixture.added.length);
      expect(r.categorized.auto + r.categorized.uncertain).toBe(r.categorized.total);
      expect(r.categorized.uncertain).toBeGreaterThan(0);
      const txns = await listTransactions(scoped(d.db, "alice"), { includePending: true });
      expect(txns).toHaveLength(fixture.added.length);
      expect(JSON.stringify(txns)).not.toContain("access-fixture");
    });

    it("transfer rule fires because ≥ 2 accounts are linked", async () => {
      const s = scoped(d.db, "alice");
      const cd = fixture.added.find(
        (t) => t.personal_finance_category?.detailed === "TRANSFER_OUT_ACCOUNT_TRANSFER",
      );
      const c = await currentCategorization(s, `transaction:${cd?.transaction_id}`);
      expect(c).toMatchObject({
        source: "rule",
        label: "transfer_out",
        status: "auto",
        confidence: 1,
      });
    });

    it("tools read userId from configurable and reject cross-user writes", async () => {
      const tools = toolMap(d);
      const queue = JSON.parse(
        await tools("list_review_queue").invoke({ limit: 10 }, alice),
      ) as Array<{ transactionId: string; bestGuess: { confidence: number } }>;
      expect(queue.length).toBeGreaterThan(0);
      expect(queue.every((q) => q.bestGuess.confidence < 0.8)).toBe(true);
      const first = queue[0] as { transactionId: string };
      await expect(
        tools("record_categorization").invoke(
          { transactionId: first.transactionId, category: "meals", isBusiness: true },
          bob,
        ),
      ).rejects.toThrow(/not found for user/);
      await expect(
        tools("record_categorization").invoke(
          { transactionId: first.transactionId, category: "meals", isBusiness: true },
          {},
        ),
      ).rejects.toThrow(/user_id/);
      const rec = JSON.parse(
        await tools("record_categorization").invoke(
          { transactionId: first.transactionId, category: "meals", isBusiness: true },
          alice,
        ),
      );
      expect(rec).toMatchObject({ label: "meals", status: "accepted" });
      const after = JSON.parse(
        await tools("list_review_queue").invoke({ limit: 50 }, alice),
      ) as Array<{ transactionId: string }>;
      expect(after.some((q) => q.transactionId === first.transactionId)).toBe(false);
      expect(JSON.parse(await tools("list_review_queue").invoke({ limit: 10 }, bob))).toEqual([]);
    });

    it("payer + merchant rules take precedence on the next sync (supersession via modified)", async () => {
      const tools = toolMap(d);
      await tools("set_payer").invoke({ counterparty: "United Airlines", isIncome: true }, alice);
      await tools("set_merchant_rule").invoke(
        { merchantKey: "uber", category: "car_truck", isBusiness: true },
        alice,
      );
      const gusto = fixture.added.find((t) => t.name === "United Airlines" && t.amount < 0);
      const uber = fixture.added.find((t) => t.name.startsWith("Uber"));
      const kfc = fixture.added.find((t) => t.name === "KFC");
      plaid.queueUpdate({
        added: [],
        modified: [gusto as never, uber as never],
        removed: [
          { transaction_id: kfc?.transaction_id as string, account_id: kfc?.account_id as string },
        ],
      });
      const r = await syncItem(d, "alice", itemId);
      expect(r).toMatchObject({ modified: 2, removed: 1 });
      const s = scoped(d.db, "alice");
      expect(await currentCategorization(s, `transaction:${gusto?.transaction_id}`)).toMatchObject({
        label: "income_1099",
        source: "rule",
        rule_id: "payer:United Airlines",
      });
      expect(await currentCategorization(s, `transaction:${uber?.transaction_id}`)).toMatchObject({
        label: "car_truck",
        source: "rule",
      });
      const txns = await listTransactions(s, { includePending: true });
      expect(txns.find((t) => t.plaid_txn_id === kfc?.transaction_id)).toBeUndefined();
      expect(
        (await reviewQueue(s, 50)).some((q) => q.transaction.plaid_txn_id === kfc?.transaction_id),
      ).toBe(false);
    });

    it("webhook resolves the owner from item_id and syncs; unknown items are ignored", async () => {
      const app = new Hono().route("/plaid", plaidRoutes(d));
      const ok = await app.request("/plaid/webhook", {
        method: "POST",
        body: JSON.stringify({
          webhook_type: "TRANSACTIONS",
          webhook_code: "SYNC_UPDATES_AVAILABLE",
          item_id: fixture.item_id,
        }),
      });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toMatchObject({ itemId, status: "ok" });
      const unknown = await app.request("/plaid/webhook", {
        method: "POST",
        body: JSON.stringify({
          webhook_type: "TRANSACTIONS",
          webhook_code: "SYNC_UPDATES_AVAILABLE",
          item_id: "nope",
        }),
      });
      expect(unknown.status).toBe(202);
      const link = await app.request("/plaid/link-token", {
        method: "POST",
        body: JSON.stringify({ userId: "alice" }),
      });
      expect((await link.json()).linkToken).toMatch(/^link-/);
    });
  },
);
