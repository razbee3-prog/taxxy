import type { RunnableConfig } from "@langchain/core/runnables";

export class ToolAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolAuthError";
  }
}

/** userId comes from `configurable.user_id` (set by the server from the session), never from model output. */
export function requireUserId(config: RunnableConfig | undefined): string {
  const id = config?.configurable?.user_id;
  if (typeof id !== "string" || !id) throw new ToolAuthError("missing configurable.user_id");
  return id;
}
