import { tool } from "@langchain/core/tools";
import { guardToolOutput, SensitiveOutputError } from "@taxxy/integrations";

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
