import { describe, expect, it } from "vitest";
import { ENGINE_VERSION } from "../src/index.js";

describe("tier 1 placeholder", () => {
  it("exports an engine version", () => {
    expect(ENGINE_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
