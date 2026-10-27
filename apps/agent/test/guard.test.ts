import { describe, expect, it } from "vitest";
import { gtool, mtool } from "../src/tools/guard.js";

const schema = { name: "t", description: "t", schema: undefined } as never;

describe("tool output guard", () => {
  it("gtool blocks a result containing an SSN/account pattern", async () => {
    const t = gtool(async () => '{"note":"ssn 123-45-6789"}', schema);
    expect(JSON.parse((await t.invoke({})) as string)).toEqual({
      error: "sensitive_output_blocked",
      kind: "ssn",
    });
  });

  it("mtool masks long digit runs to their last 4 and keeps the rest of the result", async () => {
    const t = mtool(async () => "order 482917364501, ssn 123-45-6789, total 10833.48", schema);
    const out = (await t.invoke({})) as string;
    expect(out).toBe("order ••••••••4501, ssn 123-45-6789, total •0833.48");
  });
});
