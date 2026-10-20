import { ChatAnthropic } from "@langchain/anthropic";
import type { Env } from "./config.js";

/**
 * Models served on Raz's key (claude-*-5-5) reject the `temperature` parameter,
 * so it is only sent to older model strings that accept it.
 */
export function acceptsTemperature(model: string): boolean {
  return !/-5-5\b|-5\b|fable/.test(model);
}

export function chatModel(env: Env, model: string): ChatAnthropic {
  if (!env.llmApiKey) throw new Error("LLM_API_KEY (or ANTHROPIC_API_KEY) is not set");
  return new ChatAnthropic({
    model,
    apiKey: env.llmApiKey,
    maxTokens: 4096,
    ...(acceptsTemperature(model) ? { temperature: 0 } : {}),
  });
}
