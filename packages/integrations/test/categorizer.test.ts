import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { describe, expect, it } from "vitest";
import {
  BATCH_LIMIT,
  coerceCategorizerOutput,
  llmCategorizer,
  MIN_SPLIT_BATCH,
} from "../src/categorize/categorizer.js";
import type { CategorizerItem } from "../src/categorize/types.js";

const ctx = { taxYear: 2026, payers: [], merchantRules: [], recentUserLabels: [] } as never;
const item = (i: number): CategorizerItem =>
  ({ ref: `t${i}`, description: `MERCHANT ${i}`, amount: 10 + i, date: "2026-10-01" }) as never;
const label = (ref: string) => ({
  ref,
  label: "software",
  isBusiness: true,
  confidence: 0.9,
  rationale: "ok",
});

/** Stub chat model whose structured-output reply is chosen per batch by `reply`. */
function stubModel(
  reply: (refs: string[]) => { parsed: unknown; raw: unknown },
  calls: string[][],
) {
  return {
    withStructuredOutput: () => ({
      invoke: async (msgs: Array<{ content: string }>) => {
        const refs = (
          JSON.parse(
            (msgs[1]?.content ?? "").match(/<transactions>\n(.*)\n<\/transactions>/s)?.[1] ?? "[]",
          ) as CategorizerItem[]
        ).map((t) => t.ref);
        calls.push(refs);
        return reply(refs);
      },
    }),
  } as unknown as BaseChatModel;
}

describe("coerceCategorizerOutput", () => {
  it("accepts items delivered as a JSON string, repairing a stray trailing comma", () => {
    const raw = {
      tool_calls: [
        {
          args: {
            items:
              '[{"ref":"t1","label":"utilities","isBusiness":true,"confidence":0.8,"rationale":"net","}]',
          },
        },
      ],
    };
    expect(coerceCategorizerOutput(raw)?.map((r) => r.ref)).toEqual(["t1"]);
  });
  it("returns null for an empty or missing payload", () => {
    expect(coerceCategorizerOutput({ tool_calls: [{ args: {} }] })).toBeNull();
    expect(coerceCategorizerOutput(undefined)).toBeNull();
  });
});

describe("llmCategorizer", () => {
  it("splits a batch whose payload is unusable and retries the halves", async () => {
    const calls: string[][] = [];
    const n = BATCH_LIMIT;
    const model = stubModel(
      (refs) =>
        refs.length > n / 2
          ? { parsed: null, raw: { tool_calls: [{ args: {} }] } }
          : { parsed: { items: refs.map(label) }, raw: {} },
      calls,
    );
    const out = await llmCategorizer(model, "stub").categorize(
      Array.from({ length: n }, (_, i) => item(i)),
      ctx,
    );
    expect(calls.map((c) => c.length)).toEqual([n, n / 2, n / 2]);
    expect(out).toHaveLength(n);
    expect(out.every((o) => o.confidence === 0.9)).toBe(true);
  });

  it("falls back to confidence-0 labels when even small batches fail", async () => {
    const calls: string[][] = [];
    const model = stubModel(() => ({ parsed: null, raw: {} }), calls);
    const out = await llmCategorizer(model, "stub").categorize(
      Array.from({ length: MIN_SPLIT_BATCH }, (_, i) => item(i)),
      ctx,
    );
    expect(calls.map((c) => c.length)).toEqual([
      MIN_SPLIT_BATCH,
      MIN_SPLIT_BATCH / 2,
      MIN_SPLIT_BATCH / 2,
    ]);
    expect(out).toHaveLength(MIN_SPLIT_BATCH);
    expect(out.every((o) => o.confidence === 0 && o.rationale === "model returned no label")).toBe(
      true,
    );
  });
});
