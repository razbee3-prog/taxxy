import { connectSurreal, dbConfigFromEnv, migrate } from "@taxxy/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  hashPassword,
  LocalAuthProvider,
  signSession,
  verifyPassword,
  verifySession,
} from "../src/auth.js";
import { createWebApp } from "../src/server.js";

describe("auth primitives", () => {
  it("hashes with a per-user salt and verifies", () => {
    const h = hashPassword("correct horse battery");
    expect(h).toMatch(/^scrypt\$/);
    expect(verifyPassword("correct horse battery", h)).toBe(true);
    expect(verifyPassword("wrong", h)).toBe(false);
    expect(hashPassword("x")).not.toBe(hashPassword("x"));
  });
  it("signs sessions and rejects tampering/expiry", () => {
    const t = signSession("s3cret", { userId: "u1", email: "a@b.co" });
    expect(verifySession("s3cret", t)).toMatchObject({ userId: "u1" });
    expect(verifySession("other", t)).toBeNull();
    expect(verifySession("s3cret", `${t}x`)).toBeNull();
    expect(
      verifySession("s3cret", signSession("s3cret", { userId: "u1", email: "a@b.co" }, -1)),
    ).toBeNull();
  });
});

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

describe.skipIf(!up)(
  "web app: sign up → session → proxied agent calls carry the session's userId",
  () => {
    const ns = `test_web_${Date.now().toString(36)}`;
    let db: Awaited<ReturnType<typeof connectSurreal>>;
    const agentCalls: Array<{ path: string; body: unknown }> = [];
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      agentCalls.push({ path, body: JSON.parse(String(init?.body ?? "{}")) });
      if (path.startsWith("/threads/")) {
        return new Response(
          'event: token\ndata: {"type":"token","content":"hi"}\n\nevent: done\ndata: {"type":"done"}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return Response.json({ linkToken: "link-fixture-1" });
    }) as typeof fetch;
    let app: ReturnType<typeof createWebApp>;
    let cookie = "";

    beforeAll(async () => {
      db = await connectSurreal({ ...cfg.app, namespace: ns });
      await migrate(db);
      app = createWebApp({
        db,
        auth: new LocalAuthProvider(db),
        sessionSecret: "test-secret",
        agentUrl: "http://agent.test",
        fetch: fakeFetch,
      });
    });
    afterAll(async () => {
      await db.query(`REMOVE NAMESPACE IF EXISTS ${ns}`);
      await db.close();
    });

    it("rejects weak passwords and anonymous API calls", async () => {
      const weak = await app.request("/auth/signup", {
        method: "POST",
        body: JSON.stringify({ email: "raz@example.com", password: "short" }),
      });
      expect(weak.status).toBe(400);
      expect((await app.request("/api/me")).status).toBe(401);
    });

    it("signs up, sets an httpOnly cookie, and /api/me reflects the account", async () => {
      const r = await app.request("/auth/signup", {
        method: "POST",
        body: JSON.stringify({ email: "raz@example.com", password: "long-enough-password" }),
      });
      expect(r.status).toBe(200);
      cookie = r.headers.get("set-cookie") ?? "";
      expect(cookie).toMatch(/taxxy_session=.*HttpOnly/);
      const me = await (await app.request("/api/me", { headers: { cookie } })).json();
      expect(me).toMatchObject({ email: "raz@example.com", banks: [], gmail: null, estimates: [] });
      const dup = await app.request("/auth/signup", {
        method: "POST",
        body: JSON.stringify({ email: "raz@example.com", password: "long-enough-password" }),
      });
      expect(dup.status).toBe(400);
      const bad = await app.request("/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: "raz@example.com", password: "nope-nope-nope" }),
      });
      expect(bad.status).toBe(401);
    });

    it("proxies Plaid link and chat with the session's userId, never a client-supplied one", async () => {
      const me = (await (await app.request("/api/me", { headers: { cookie } })).json()) as {
        userId: string;
      };
      const lt = await app.request("/api/plaid/link-token", {
        method: "POST",
        headers: { cookie },
        body: JSON.stringify({ userId: "attacker" }),
      });
      expect(await lt.json()).toEqual({ linkToken: "link-fixture-1" });
      expect(agentCalls.at(-1)).toEqual({ path: "/plaid/link-token", body: { userId: me.userId } });
      const chat = await app.request("/api/chat", {
        method: "POST",
        headers: { cookie },
        body: JSON.stringify({ message: "hello", taxYear: 2026, quarter: 4 }),
      });
      expect(chat.headers.get("content-type")).toContain("text/event-stream");
      expect(chat.headers.get("x-thread-id")).toBe(`${me.userId}:2026:4`);
      expect(await chat.text()).toContain('"content":"hi"');
      expect(agentCalls.at(-1)).toMatchObject({
        path: `/threads/${encodeURIComponent(`${me.userId}:2026:4`)}/runs`,
        body: { userId: me.userId, message: "hello" },
      });
    });
  },
);
