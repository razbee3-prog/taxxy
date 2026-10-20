import { MemorySaver } from "@langchain/langgraph";
import { InMemoryStore } from "@langchain/langgraph-checkpoint";
import {
  connectSurreal,
  dbConfigFromEnv,
  ensureUser,
  listEstimates,
  listTransactions,
  scoped,
} from "@taxxy/db";
import { fixturePlaid } from "@taxxy/integrations";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv } from "../src/config.js";
import { type AppDeps, buildDeps, loadPlaidFixture } from "../src/deps.js";
import { skillFigures } from "../src/evals/tier3.js";
import { readMemory } from "../src/memory.js";
import { runTurn } from "../src/run.js";
import { exchangePublicToken, syncItem } from "../src/services/plaid.js";

/**
 * Scripted headless conversation (spec M4 acceptance): intake → review → accepted estimate.
 * Runs only with an LLM key and a reachable SurrealDB; asserts no dollar figure in the
 * assistant's prose that did not come from the engine (or from the user's own inputs).
 */
const cfg = dbConfigFromEnv();
const key = process.env.LLM_API_KEY ?? process.env.ANTHROPIC_API_KEY;
async function reachable() {
  try {
    const u = new URL(cfg.app.url.replace(/^ws/, "http"));
    return (await fetch(`${u.origin}/health`, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    return false;
  }
}
const up = Boolean(key) && (await reachable());

const SCRIPT = [
  "Hi. I'm a freelance UX designer in California with 1099 income. I want my Q4 2026 federal estimate.",
  "No W-2 job this year, so zero wages and zero withholding. Last year's total tax was 8000 and AGI was 70000 — yes, I confirm both numbers. No health premiums and no SEP contribution. My checking account is mostly business.",
  "My bank is already linked. Please sync it and show me anything you're unsure about.",
  "Mark every item in the review queue as personal, then compute the Q4 2026 estimate.",
  "That looks right. I accept it.",
];

const USER_NUMBERS = new Set([8000, 70000, 2026, 4, 0]);
const MONEY = /\$\s?(\d[\d,]*(?:\.\d{1,2})?)/g;

describe.skipIf(!up)("scripted conversation: intake → review → accepted estimate", () => {
  const ns = `test_conv_${Date.now().toString(36)}`;
  let d: AppDeps;
  const userId = "scripted";
  const transcript: string[] = [];

  beforeAll(async () => {
    const db = await connectSurreal({ ...cfg.app, namespace: ns });
    d = await buildDeps(loadEnv({ ...process.env, SURREAL_NS: ns, PLAID_MODE: "fixture" }), {
      db,
      plaid: fixturePlaid(loadPlaidFixture()),
      store: new InMemoryStore(),
      checkpointer: new MemorySaver(),
    });
    await ensureUser(d.db, userId, "scripted@example.com");
    const linked = await exchangePublicToken(d, userId, "public-fixture");
    await syncItem(d, userId, linked.itemId);
  }, 120_000);
  afterAll(async () => {
    await d?.db.query(`REMOVE NAMESPACE IF EXISTS ${ns}`);
    await d?.db.close();
  });

  it("completes headlessly and never states a dollar figure outside engine output", async () => {
    for (const message of SCRIPT) {
      let reply = "";
      for await (const ev of runTurn(d, { userId, message, taxYear: 2026, quarter: 4 })) {
        if (ev.type === "message") reply = ev.content ?? "";
        if (ev.type === "error") throw new Error(ev.error);
      }
      transcript.push(`USER: ${message}\nTAXXY: ${reply}`);
    }
    const s = scoped(d.db, userId);
    const estimates = await listEstimates(s, 2026);
    expect(estimates.length).toBeGreaterThan(0);
    expect(estimates.some((e) => e.status === "accepted" || e.status === "edited")).toBe(true);

    const engineNumbers = new Set<number>();
    for (const e of estimates) {
      const r = e.result as { installmentDue: number; lines: { value: number }[] };
      engineNumbers.add(Math.round(r.installmentDue * 100) / 100);
      for (const l of r.lines) engineNumbers.add(Math.round(l.value * 100) / 100);
      const snap = e.input_snapshot as Record<string, unknown>;
      for (const v of Object.values(snap)) if (typeof v === "number") engineNumbers.add(v);
    }
    // Bank transaction amounts are data the agent may quote while reviewing; tax figures may not be invented.
    const bankAmounts = new Set(
      (await listTransactions(s, { includePending: true })).map((t) => Math.abs(t.amount)),
    );
    const skillNumbers = new Set(skillFigures());
    const stray: string[] = [];
    for (const turn of transcript) {
      const reply = turn.split("\nTAXXY: ")[1] ?? "";
      for (const m of reply.matchAll(MONEY)) {
        const n = Number((m[1] ?? "").replace(/,/g, ""));
        if (
          !engineNumbers.has(n) &&
          !USER_NUMBERS.has(n) &&
          !bankAmounts.has(n) &&
          !skillNumbers.has(n)
        )
          stray.push(m[0]);
      }
    }
    expect(stray, `dollar figures not from the engine:\n${transcript.join("\n\n")}`).toEqual([]);

    const memory = await readMemory(d.store as InMemoryStore, userId);
    expect(memory).toMatch(/Business|State|Prior year/);
  }, 600_000);
});
