import { describe, expect, it } from "vitest";
import {
  findSensitive,
  guardToolOutput,
  maskDeep,
  maskDigits,
  SensitiveOutputError,
} from "../src/security/redact.js";

describe("redaction guard", () => {
  it("blocks SSNs and account numbers, passes ordinary tool output", () => {
    expect(() => guardToolOutput('{"ssn":"123-45-6789"}')).toThrow(SensitiveOutputError);
    expect(() => guardToolOutput("acct 123456789012")).toThrow(/account/);
    expect(findSensitive("amount 2078.50 on 2026-10-11 mask 3333")).toBeNull();
    expect(findSensitive("plaid id zP8DrWP371unG5Xkrv8mCZwMvE5nB8flnLQNm")).toBeNull();
    expect(guardToolOutput('{"installmentDue":10833.48}')).toContain("10833.48");
  });
  it("masks long digit runs and drops raw/token fields for traces", () => {
    expect(maskDigits("CHECK 123456 PAYMENT 9876543210")).toBe("CHECK ••3456 PAYMENT ••••••3210");
    expect(
      maskDeep({
        description: "ACH 00123456789",
        raw: { x: 1 },
        access_token_enc: "v1.x",
        amount: 12,
      }),
    ).toEqual({ description: "ACH •••••••6789", amount: 12 });
  });
});
