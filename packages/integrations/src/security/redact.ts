/** 9-digit SSN (with or without separators) and 10–17 digit account-number runs. */
export const SSN_PATTERN = /\b(?!000|666|9\d{2})\d{3}[- ]?(?!00)\d{2}[- ]?(?!0000)\d{4}\b/g;
export const ACCOUNT_PATTERN = /\b\d{10,17}\b/g;
/** Digit runs longer than 4 (what traces are allowed to keep is the last-4 mask). */
const LONG_DIGITS = /\d{5,}/g;

export class SensitiveOutputError extends Error {
  constructor(public readonly kind: "ssn" | "account") {
    super(
      `tool output contained a ${kind === "ssn" ? "9-digit SSN" : "10-17 digit account number"} pattern and was blocked`,
    );
    this.name = "SensitiveOutputError";
  }
}

export function findSensitive(text: string): "ssn" | "account" | null {
  if (new RegExp(SSN_PATTERN.source, "g").test(text)) return "ssn";
  if (new RegExp(ACCOUNT_PATTERN.source, "g").test(text)) return "account";
  return null;
}

/**
 * Every tool result passes through here before the model sees it. Plaid/Gmail ids are
 * alphanumeric, so a pure 10–17 digit run is never legitimate in a tool result.
 */
export function guardToolOutput(text: string): string {
  const hit = findSensitive(text);
  if (hit) throw new SensitiveOutputError(hit);
  return text;
}

/** Trace redaction: keep last 4 digits of any long digit run; applied to Langfuse payloads. */
export function maskDigits(text: string): string {
  return text.replace(LONG_DIGITS, (m) => `${"•".repeat(Math.max(0, m.length - 4))}${m.slice(-4)}`);
}

export function maskDeep<T>(value: T): T {
  if (typeof value === "string") return maskDigits(value) as T;
  if (Array.isArray(value)) return value.map(maskDeep) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "raw" || k === "bytes" || k === "base64" || /token|secret|_enc$/i.test(k)) continue;
      out[k] = maskDeep(v);
    }
    return out as T;
  }
  return value;
}
