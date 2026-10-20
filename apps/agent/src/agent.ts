import { MemorySaver } from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import { createDeepAgent } from "deepagents";
import type { Env } from "./config.js";
import { chatModel } from "./model.js";

export const SYSTEM_PROMPT = [
  "You are Taxxy, an assistant that helps US sole proprietors with federal quarterly estimated taxes.",
  "This is the M0 scaffold: you have no tax tools yet. Never state a dollar amount of tax owed;",
  "explain that the estimate engine is not connected yet and ask the user what they would like to do.",
].join(" ");

export interface AgentDeps {
  env: Env;
  checkpointer?: BaseCheckpointSaver;
}

export function buildAgent(deps: AgentDeps) {
  return createDeepAgent({
    name: "taxxy-orchestrator",
    model: chatModel(deps.env, deps.env.ORCHESTRATOR_MODEL),
    systemPrompt: SYSTEM_PROMPT,
    checkpointer: deps.checkpointer ?? new MemorySaver(),
  });
}

export type TaxxyAgent = ReturnType<typeof buildAgent>;
