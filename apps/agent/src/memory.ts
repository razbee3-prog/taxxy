import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BaseStore } from "@langchain/langgraph-checkpoint";
import { memoryFilePath, userFilesystemNamespace } from "@taxxy/db";
import { StoreBackend } from "deepagents";

export const SKILLS_DIR = new URL("../skills/", import.meta.url).pathname;

export function skillsRoot(userId: string): string {
  return `/users/${userId}/skills/`;
}

/** Per-user virtual filesystem rooted at /users/{userId}/ inside the LangGraph store. */
export function userBackend(store: BaseStore, userId: string): StoreBackend {
  return new StoreBackend({ store, namespace: userFilesystemNamespace(userId) });
}

const MEMORY_TEMPLATE = `# Taxxy memory

## Stable facts

## Payers

## Merchant rules

## Safe harbor

## Preferences
`;

/** Ensures AGENTS.md and the four skills exist for the user. Skills are re-synced from disk on every call. */
export async function seedUserFiles(store: BaseStore, userId: string): Promise<void> {
  const b = userBackend(store, userId);
  const mem = await b.read(memoryFilePath(userId));
  if (mem.error) await b.write(memoryFilePath(userId), MEMORY_TEMPLATE);
  for (const name of readdirSync(SKILLS_DIR)) {
    const file = join(SKILLS_DIR, name, "SKILL.md");
    let content: string;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const path = `${skillsRoot(userId)}${name}/SKILL.md`;
    if (rawText(await b.readRaw(path)) !== content) await b.write(path, content);
  }
}

function rawText(res: {
  error?: string;
  data?: { content: string | string[] | Uint8Array };
}): string | null {
  if (res.error || !res.data) return null;
  const c = res.data.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.join("\n");
  return null;
}

export type MemorySection =
  | "Stable facts"
  | "Payers"
  | "Merchant rules"
  | "Safe harbor"
  | "Preferences";

/** Appends one bullet under a section of AGENTS.md (idempotent on exact text). */
export async function appendMemory(
  store: BaseStore,
  userId: string,
  section: MemorySection,
  line: string,
): Promise<void> {
  const b = userBackend(store, userId);
  const path = memoryFilePath(userId);
  const current = rawText(await b.readRaw(path)) ?? MEMORY_TEMPLATE;
  const bullet = `- ${line.replace(/\s+/g, " ").trim()}`;
  if (current.includes(bullet)) return;
  const header = `## ${section}`;
  const idx = current.indexOf(header);
  let next: string;
  if (idx < 0) {
    next = `${current.trimEnd()}\n\n${header}\n${bullet}\n`;
  } else {
    const after = current.indexOf("\n## ", idx + header.length);
    const end = after < 0 ? current.length : after;
    const block = current.slice(idx, end).trimEnd();
    next = `${current.slice(0, idx)}${block}\n${bullet}\n${after < 0 ? "" : current.slice(end)}`;
  }
  await b.write(path, next);
}

export async function readMemory(store: BaseStore, userId: string): Promise<string> {
  return rawText(await userBackend(store, userId).readRaw(memoryFilePath(userId))) ?? "";
}
