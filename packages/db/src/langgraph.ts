import { SurrealDBSaver, SurrealDBStore } from "@surrealdb/langgraph";
import type { SurrealConfig } from "./config.js";

/** Namespace in the LangGraph store that holds one user's virtual filesystem (AGENTS.md, skills). */
export function userFilesystemNamespace(userId: string): string[] {
  return ["filesystem", userId];
}

export function memoryFilePath(userId: string): string {
  return `/users/${userId}/AGENTS.md`;
}

export function threadId(userId: string, taxYear: number, quarter: number): string {
  return `${userId}:${taxYear}:${quarter}`;
}

export function createCheckpointer(cfg: SurrealConfig): SurrealDBSaver {
  return new SurrealDBSaver({ surreal: cfg });
}

export function createStore(cfg: SurrealConfig): SurrealDBStore {
  return new SurrealDBStore({ surreal: cfg });
}
