import { describe, expect, it } from "vitest";
import { loadEnv } from "../src/config.js";
import { acceptsTemperature } from "../src/model.js";
import { telemetryEnabled, turnCallbacks } from "../src/telemetry.js";

describe("m0 scaffold", () => {
  it("loads defaults and falls back to ANTHROPIC_API_KEY", () => {
    const env = loadEnv({ ANTHROPIC_API_KEY: "k" });
    expect(env.llmApiKey).toBe("k");
    expect(env.CATEGORIZER_THRESHOLD).toBe(0.8);
    expect(env.SURREAL_NS).toBe("taxxy");
  });

  it("omits temperature for claude 5.5 models", () => {
    expect(acceptsTemperature("claude-sonnet-5-5")).toBe(false);
    expect(acceptsTemperature("claude-sonnet-4-5-20250929")).toBe(true);
  });

  it("disables tracing without Langfuse keys", () => {
    const env = loadEnv({});
    expect(telemetryEnabled(env)).toBe(false);
    expect(turnCallbacks(env, { userId: "u", threadId: "t", env: "test" })).toEqual([]);
  });
});
