import { connectSurreal, dbConfigFromEnv, ensureUser } from "@taxxy/db";
import {
  fixturePlaid,
  type MergeClientLike,
  type MergeRegisteredUser,
  memoryFileStore,
} from "@taxxy/integrations";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv } from "../src/config.js";
import { type AppDeps, buildDeps, loadPlaidFixture } from "../src/deps.js";
import { gmailRoutes } from "../src/routes/gmail.js";
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

/** Merge Agent Handler stand-in: registered users, magic links, and a Gmail Tool Pack. */
function fakeMerge() {
  const users = new Map<string, MergeRegisteredUser>();
  const log: string[] = [];
  const client: MergeClientLike = {
    async ensureRegisteredUser(originUserId, originUserName) {
      let u = [...users.values()].find((x) => x.origin_user_id === originUserId);
      if (!u) {
        u = {
          id: `ru-${users.size + 1}`,
          origin_user_id: originUserId,
          origin_user_name: originUserName,
          authenticated_connectors: [],
        };
        users.set(u.id, u);
      }
      log.push(`ensure:${originUserId}`);
      return u;
    },
    async registeredUser(id) {
      const u = users.get(id);
      if (!u) throw new Error(`no registered user ${id}`);
      return u;
    },
    async magicLink(id, connector) {
      log.push(`link:${id}:${connector}`);
      return `https://ah-api.merge.dev/magic-link/${id}-${connector}/`;
    },
    tools(id) {
      return {
        async call(name, input) {
          const u = users.get(id);
          if (!u?.authenticated_connectors.includes("gmail"))
            throw new Error(`gmail not authenticated for ${id}`);
          log.push(`tool:${id}:${name}`);
          if (name === "gmail__get_profile") return { email_address: `${id}@gmail.example` };
          if (name === "gmail__list_messages")
            return {
              messages: [
                {
                  id: "m1",
                  thread_id: "t1",
                  sender: "Store <r@store.example>",
                  subject: "Your receipt",
                  internal_date: "1792860536000",
                  snippet: "Total $120.00",
                },
              ],
            };
          if (name === "gmail__get_message_text")
            return {
              attachments: [
                {
                  attachment_id: "a1",
                  filename: "receipt.pdf",
                  mime_type: "application/pdf",
                  size: 3,
                },
              ],
            };
          throw new Error(`unexpected tool ${name} ${JSON.stringify(input)}`);
        },
      };
    },
  };
  return { client, users, log };
}

describe.skipIf(!up)("Gmail via Merge Agent Handler", () => {
  const ns = `test_merge_${Date.now().toString(36)}`;
  let d: AppDeps;
  const merge = fakeMerge();
  const userId = "mia";
  const mia = { configurable: { user_id: userId } };
  let tools: (name: string) => AnyTool;
  let app: Hono;

  beforeAll(async () => {
    const db = await connectSurreal({ ...cfg.app, namespace: ns });
    d = await buildDeps(
      loadEnv({
        ...process.env,
        SURREAL_NS: ns,
        PLAID_MODE: "fixture",
        GMAIL_MODE: "merge",
        MERGE_AGENT_HANDLER_TOKEN: "test-token",
        MERGE_TOOL_PACK_ID: "tp-test",
        LLM_API_KEY: "",
        ANTHROPIC_API_KEY: "",
      }),
      {
        db,
        plaid: fixturePlaid(loadPlaidFixture()),
        merge: merge.client,
        categorizer: null,
        extractionModel: null,
        files: memoryFileStore(),
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
    await ensureUser(d.db, userId, "mia@example.com");
    app = new Hono().route("/gmail", gmailRoutes(d));
  });
  afterAll(async () => {
    await d?.db.query(`REMOVE NAMESPACE IF EXISTS ${ns}`);
    await d?.db.close();
  });

  it("auth-url registers the user with Merge and returns a magic link; repeat clicks reuse the registered user", async () => {
    const r1 = await app.request("/gmail/auth-url", {
      method: "POST",
      body: JSON.stringify({ userId, displayName: "mia@example.com" }),
    });
    expect(await r1.json()).toEqual({
      url: "https://ah-api.merge.dev/magic-link/ru-1-gmail/",
      mode: "merge",
    });
    const r2 = await app.request("/gmail/auth-url", {
      method: "POST",
      body: JSON.stringify({ userId }),
    });
    expect(((await r2.json()) as { url: string }).url).toContain("ru-1-gmail");
    expect(merge.users.size).toBe(1);
    expect(merge.users.get("ru-1")).toMatchObject({
      origin_user_id: "taxxy:mia",
      origin_user_name: "mia@example.com",
    });
    // only one Merge create call: the second click found the stored registered user
    expect(merge.log.filter((l) => l.startsWith("ensure:"))).toHaveLength(1);
  });

  it("status stays disconnected until Merge reports gmail authenticated, then records the account without any token", async () => {
    const pending = await app.request("/gmail/status", {
      method: "POST",
      body: JSON.stringify({ userId }),
    });
    expect(await pending.json()).toEqual({ connected: false });
    expect(JSON.parse(await tools("gmail_status").invoke({}, mia))).toEqual({ connected: false });
    expect(
      JSON.parse(
        await tools("gmail_search_receipts").invoke({ from: "2026-10-01", to: "2026-12-31" }, mia),
      ),
    ).toMatchObject({ error: "gmail_not_connected" });

    merge.users.get("ru-1")?.authenticated_connectors.push("gmail");
    const done = await app.request("/gmail/status", {
      method: "POST",
      body: JSON.stringify({ userId }),
    });
    expect(await done.json()).toMatchObject({
      connected: true,
      email: "ru-1@gmail.example",
      scope: /gmail\.readonly/,
    });
    const [rows] = await d.db.query<[Array<{ refresh_token_enc: string; provider: string }>[]]>(
      "SELECT refresh_token_enc, provider FROM gmail_account",
    );
    expect(rows).toEqual([{ refresh_token_enc: "", provider: "merge" }]);
  });

  it("agent Gmail tools run through the user's Merge registered user", async () => {
    expect(JSON.parse(await tools("gmail_status").invoke({}, mia))).toMatchObject({
      connected: true,
      email: "ru-1@gmail.example",
    });
    const found = JSON.parse(
      await tools("gmail_search_receipts").invoke({ from: "2026-10-01", to: "2026-12-31" }, mia),
    );
    expect(found).toEqual([
      {
        id: "m1",
        threadId: "t1",
        date: "2026-10-24",
        from: "Store <r@store.example>",
        subject: "Your receipt",
        snippet: "Total $120.00",
        attachments: [{ id: "a1", filename: "receipt.pdf", mime: "application/pdf", size: 3 }],
      },
    ]);
    expect(merge.log).toContain("tool:ru-1:gmail__list_messages");
    // another user never touches mia's registered user
    const other = { configurable: { user_id: "noah" } };
    await ensureUser(d.db, "noah", "noah@example.com");
    expect(JSON.parse(await tools("gmail_status").invoke({}, other))).toEqual({ connected: false });
  });
});
