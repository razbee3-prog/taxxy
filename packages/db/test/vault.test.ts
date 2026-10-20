import { describe, expect, it } from "vitest";
import { Vault } from "../src/vault.js";

describe("vault", () => {
  const v = new Vault(Vault.generateKey());

  it("round-trips and binds to the user id", () => {
    const sealed = v.seal("access-sandbox-123", "u1");
    expect(sealed.startsWith("v1.")).toBe(true);
    expect(sealed).not.toContain("access-sandbox");
    expect(v.open(sealed, "u1")).toBe("access-sandbox-123");
    expect(() => v.open(sealed, "u2")).toThrow();
  });

  it("rejects a tampered ciphertext and a bad key", () => {
    const sealed = v.seal("secret");
    const parts = sealed.split(".");
    parts[3] = `${parts[3]?.slice(0, -2)}AA`;
    expect(() => v.open(parts.join("."))).toThrow();
    expect(() => new Vault("short")).toThrow(/32 bytes/);
    expect(() => new Vault(Vault.generateKey()).open(sealed)).toThrow();
  });

  it("accepts hex keys", () => {
    const hex = "00".repeat(32);
    expect(new Vault(hex).open(new Vault(hex).seal("x"))).toBe("x");
  });
});
