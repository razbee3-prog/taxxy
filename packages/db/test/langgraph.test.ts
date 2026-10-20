import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createCheckpointer,
  createStore,
  memoryFilePath,
  threadId,
  userFilesystemNamespace,
} from "../src/langgraph.js";
import { langgraphCfg, reachable, SKIP_REASON } from "./setup.js";

const up = await reachable();
if (!up && process.env.CI) throw new Error(SKIP_REASON);

describe.skipIf(!up)("@surrealdb/langgraph store + saver", () => {
  const ns = `test_lg_${Date.now().toString(36)}`;
  const store = createStore(langgraphCfg(ns));
  const saver = createCheckpointer(langgraphCfg(ns));
  beforeAll(async () => {
    await store.setup();
    await saver.setup();
  });
  afterAll(async () => {
    await store.client.db.query(`REMOVE NAMESPACE IF EXISTS ${ns}`);
    await store.stop();
    await saver.close();
  });

  it("round-trips AGENTS.md through the per-user filesystem namespace", async () => {
    const path = memoryFilePath("alice");
    const content = "# Alice\n- Payer: Acme Corp → income (confirmed 2026-02-01)\n";
    await store.put(userFilesystemNamespace("alice"), path, { content });
    const item = await store.get(userFilesystemNamespace("alice"), path);
    expect(item?.value).toEqual({ content });
    expect(await store.get(userFilesystemNamespace("bob"), path)).toBeNull();
    const ns = await store.listNamespaces({ prefix: ["filesystem"] });
    expect(ns).toContainEqual(["filesystem", "alice"]);
  });

  it("saver stores a checkpoint under {userId}:{taxYear}:{quarter}", async () => {
    const config = { configurable: { thread_id: threadId("alice", 2026, 4), checkpoint_ns: "" } };
    const checkpoint = {
      v: 4,
      id: "0000-ckpt-1",
      ts: new Date().toISOString(),
      channel_values: { messages: ["hi"] },
      channel_versions: { messages: 1 },
      versions_seen: {},
    };
    await saver.put(config, checkpoint, { source: "input", step: 0, parents: {} }, {});
    const got = await saver.getTuple(config);
    expect(got?.checkpoint.id).toBe("0000-ckpt-1");
    expect(got?.checkpoint.channel_values).toEqual({ messages: ["hi"] });
    expect(
      await saver.getTuple({ configurable: { thread_id: threadId("bob", 2026, 4) } }),
    ).toBeUndefined();
  });
});
