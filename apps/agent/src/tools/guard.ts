import { tool } from "@langchain/core/tools";
import { guardToolOutput, maskDigits, SensitiveOutputError } from "@taxxy/integrations";

function guard(out: unknown): unknown {
  if (typeof out !== "string") return out;
  try {
    return guardToolOutput(out);
  } catch (err) {
    if (err instanceof SensitiveOutputError)
      return JSON.stringify({ error: "sensitive_output_blocked", kind: err.kind });
    throw err;
  }
}

/** `tool()` with the redaction guard: a result containing an SSN/account pattern never reaches the model. */
export const gtool: typeof tool = ((fn: (i: unknown, c: unknown) => unknown, opts: unknown) =>
  tool(
    async (i: unknown, c: unknown) => guard(await fn(i, c)),
    opts as never,
  )) as unknown as typeof tool;

/**
 * `tool()` for results that quote third-party text (email bodies, snippets): digit runs of 5+
 * are masked to their last 4 instead of blocking the whole result, since order numbers, phone
 * numbers and one-time codes are routine in mail and an SSN would still never reach the model.
 */
export const mtool: typeof tool = ((fn: (i: unknown, c: unknown) => unknown, opts: unknown) =>
  tool(async (i: unknown, c: unknown) => {
    const out = await fn(i, c);
    return typeof out === "string" ? maskDigits(out) : out;
  }, opts as never)) as unknown as typeof tool;
