import { createHash } from "node:crypto";

/** JSON with keys sorted recursively so the same input always serialises identically. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

export function inputSnapshotId(input: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(input)).digest("hex")}`;
}
