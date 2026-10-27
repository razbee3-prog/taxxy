import {
  connectSurreal,
  currentCategorization,
  dbConfigFromEnv,
  ensureUser,
  getTaxProfile,
  listReceipts,
  scoped,
} from "@taxxy/db";
import { fixtureGmail, fixturePlaid, memoryFileStore } from "@taxxy/integrations";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv } from "../src/config.js";
import { type AppDeps, buildDeps, loadMailboxFixture, loadPlaidFixture } from "../src/deps.js";
import { gmailRoutes } from "../src/routes/gmail.js";
import { extractPriorYear1040, matchReceiptsForPeriod } from "../src/services/gmail.js";
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

type AnyTool = { invoke: (input: unknown, config?: unknown) => Promise<string> };

describe.skipIf(!up)("Gmail fixture: receipts matched, 1040 extracted and confirmed", () => {
  const ns = `test_gmail_${Date.now().toString(36)}`;
  let d: AppDeps;
  const userId = "gina";
  const alice = { configurable: { user_id: userId } };
  const plaidFixture = loadPlaidFixture();
  const files = memoryFileStore();
  let tools: (name: string) => AnyTool;

  beforeAll(async () => {
    const db = await connectSurreal({ ...cfg.app, namespace: ns });
    d = await buildDeps(
      loadEnv({
        ...process.env,
        SURREAL_NS: ns,
        PLAID_MODE: "fixture",
        GMAIL_MODE: "fixture",
        LLM_API_KEY: "",
        ANTHROPIC_API_KEY: "",
      }),
      {
        db,
        plaid: fixturePlaid(plaidFixture),
        gmailFor: () => fixtureGmail(loadMailboxFixture()),
        categorizer: {
          model: "fake",
          async categorize(items) {
            return items.map((i) => ({
              ref: i.ref,
              label: i.amount >= 75 ? "supplies" : "personal",
              isBusiness: i.amount >= 75,
              confidence: 0.75,
              rationale: "fake",
            }));
          },
        },
        extractionModel: null,
        files,
      },
    );
    const map = new Map<string, AnyTool>(
      buildTools(d).map((t) => [t.name, t as unknown as AnyTool]),
    );
    tools = (n) => {
      const t = map.get(n);
      if (!t) throw new Error(n);
      return t;
    };
    await ensureUser(d.db, userId, "gina@example.com");
    const linked = await exchangePublicToken(d, userId, "public-fixture");
    await syncItem(d, userId, linked.itemId);
  });
  afterAll(async () => {
    await d?.db.query(`REMOVE NAMESPACE IF EXISTS ${ns}`);
    await d?.db.close();
  });

  it("tools report gmail_not_connected until the OAuth callback stores a sealed token", async () => {
    expect(JSON.parse(await tools("gmail_status").invoke({}, alice))).toEqual({ connected: false });
    expect(
      JSON.parse(
        await tools("gmail_search_receipts").invoke(
          { from: "2026-10-01", to: "2026-12-31" },
          alice,
        ),
      ),
    ).toMatchObject({ error: "gmail_not_connected" });
    const app = new Hono().route("/gmail", gmailRoutes(d));
    const start = await app.request("/gmail/auth-url", {
      method: "POST",
      body: JSON.stringify({ userId }),
    });
    const { url } = (await start.json()) as { url: string };
    const cb = await app.request(url);
    expect(await cb.json()).toMatchObject({
      connected: true,
      email: "fixture@example.com",
      scope: /gmail\.readonly/,
    });
    const replay = await app.request(url);
    expect(replay.status).toBe(400);
    const [row] = await d.db.query<[{ refresh_token_enc: string }[]]>(
      "SELECT refresh_token_enc FROM gmail_account",
    );
    expect(row?.[0]?.refresh_token_enc).toMatch(/^v1\./);
    expect(JSON.parse(await tools("gmail_status").invoke({}, alice))).toMatchObject({
      connected: true,
    });
  });

  it("gmail_search takes any Gmail query and gmail_read_message returns the body as data", async () => {
    const all = JSON.parse(await tools("gmail_search").invoke({ query: "" }, alice)) as Array<{
      id: string;
    }>;
    expect(all.length).toBeGreaterThanOrEqual(3);
    const news = JSON.parse(
      await tools("gmail_search").invoke({ query: "from:devweekly newer_than:30d" }, alice),
    ) as Array<{ id: string }>;
    expect(news.map((m) => m.id)).toEqual(["m-newsletter"]);
    const read = JSON.parse(
      await tools("gmail_read_message").invoke({ message_id: "m-sparkfun", max_chars: 200 }, alice),
    );
    expect(read).toMatchObject({
      id: "m-sparkfun",
      subject: "Your SparkFun order receipt",
      attachments: [{ id: "a1" }],
      truncated: false,
    });
    expect(read.body).toContain("IGNORE ALL PRIOR INSTRUCTIONS");
    await expect(tools("gmail_read_message").invoke({ message_id: "nope" }, alice)).rejects.toThrow(
      /no message nope/,
    );
  });

  it("search returns headers + attachment pointers, never bodies; fetch returns a fileRef, never bytes", async () => {
    const msgs = JSON.parse(
      await tools("gmail_search_receipts").invoke({ from: "2026-10-01", to: "2026-12-31" }, alice),
    ) as Array<Record<string, unknown>>;
    expect(msgs.length).toBeGreaterThanOrEqual(2);
    for (const m of msgs) {
      expect(m).not.toHaveProperty("body");
      expect(m).not.toHaveProperty("attachmentData");
    }
    const first = msgs[0] as { id: string; attachments: { id: string }[] };
    const fetched = JSON.parse(
      await tools("gmail_fetch_attachment").invoke(
        { messageId: first.id, attachmentId: first.attachments[0]?.id },
        alice,
      ),
    );
    expect(fetched.fileRef).toMatch(/^mem:gina\//);
    expect(fetched).not.toHaveProperty("base64");
  });

  it("receipt-matcher attaches receipts to business items ≥ $75, bumps confidence and clears needs_receipt", async () => {
    const s = scoped(d.db, userId);
    const sparkfun = plaidFixture.added.find((t) => t.name === "SparkFun");
    const before = await currentCategorization(s, `transaction:${sparkfun?.transaction_id}`);
    expect(before).toMatchObject({ needs_receipt: true, confidence: 0.75, status: "uncertain" });
    const r = await matchReceiptsForPeriod(d, userId, "2026-10-01", "2026-12-31");
    expect(r.candidates).toBeGreaterThan(0);
    expect(r.matched.map((m) => m.receiptVendor)).toContain("SparkFun");
    const after = await currentCategorization(s, `transaction:${sparkfun?.transaction_id}`);
    expect(after).toMatchObject({ needs_receipt: false, confidence: 0.85, status: "auto" });
    const receipts = await listReceipts(s, { matched: true });
    expect(receipts.some((x) => x.vendor === "SparkFun" && x.total === 89.4)).toBe(true);
    // the prompt-injection "invoice" is stored as an unmatched receipt row only; nothing was relabeled by it
    const injected = (await listReceipts(s, { matched: false })).find((x) => x.total === 9999);
    expect(injected?.transaction ?? null).toBeNull();
    expect(JSON.stringify(receipts)).not.toContain("IGNORE ALL PREVIOUS");
  });

  it("prior-year 1040: extracted from Gmail as unconfirmed, then confirmed in one upsert", async () => {
    const r = await extractPriorYear1040(d, userId, { taxYear: 2025 });
    expect(r).toMatchObject({ found: true, agi: 70000, totalTax: 8000, confirmed: false });
    const s = scoped(d.db, userId);
    expect((await getTaxProfile(s))?.prior_year).toMatchObject({
      total_tax: 8000,
      agi: 70000,
      confirmed: false,
    });
    const resp = JSON.parse(
      await tools("upsert_tax_profile").invoke(
        { prior_year: { total_tax: 8000, agi: 70000, confirmed: true } },
        alice,
      ),
    );
    expect(resp.profile.prior_year.confirmed).toBe(true);
    expect(resp.missing).not.toContain("prior_year.confirmed");
  });

  it("upload path extracts the same numbers from a user-provided PDF", async () => {
    const app = new Hono().route("/gmail", gmailRoutes(d));
    const box = loadMailboxFixture();
    const m = box.messages.find((x) => x.id === "m-1040");
    const a = m?.attachmentData.a1;
    const res = await app.request("/gmail/upload-1040", {
      method: "POST",
      body: JSON.stringify({
        userId,
        filename: "1040.pdf",
        mime: "application/pdf",
        base64: a?.base64,
      }),
    });
    expect(await res.json()).toMatchObject({
      found: true,
      agi: 70000,
      totalTax: 8000,
      source: "upload",
    });
  });
});
