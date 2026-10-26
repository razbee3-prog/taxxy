/**
 * Merge Agent Handler: one Merge "registered user" per Taxxy user holds that user's connector
 * credentials (Gmail today; Calendar/Outlook later). Taxxy never sees the provider tokens; it calls
 * the connector tools through the registered user's MCP endpoint.
 */
export interface MergeEnv {
  MERGE_API_BASE: string;
  MERGE_AGENT_HANDLER_TOKEN: string;
  MERGE_TOOL_PACK_ID: string;
}

export interface MergeRegisteredUser {
  id: string;
  origin_user_id: string;
  origin_user_name: string;
  authenticated_connectors: string[];
}

export interface MergeToolCaller {
  /** Calls one Tool Pack tool (`gmail__list_messages`, ...) and returns its parsed JSON payload. */
  call(name: string, input: Record<string, unknown>): Promise<unknown>;
}

export interface MergeClientLike {
  /** Idempotent on `originUserId`: Merge returns the existing registered user for a repeat create. */
  ensureRegisteredUser(originUserId: string, originUserName: string): Promise<MergeRegisteredUser>;
  registeredUser(id: string): Promise<MergeRegisteredUser>;
  /** Single-use Magic Link (30-minute expiry) that lets the person authorize `connector`. */
  magicLink(registeredUserId: string, connector: string): Promise<string>;
  tools(registeredUserId: string): MergeToolCaller;
}

export const MERGE_API_BASE = "https://ah-api.merge.dev";
const MCP_PROTOCOL = "2025-03-26";

type Fetch = typeof fetch;

export class MergeApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "MergeApiError";
  }
}

export class MergeToolError extends Error {
  constructor(
    public tool: string,
    message: string,
  ) {
    super(message);
    this.name = "MergeToolError";
  }
}

function parseSse(text: string): unknown {
  const line = text.split("\n").find((l) => l.startsWith("data:"));
  return JSON.parse(line ? line.slice(5) : text);
}

/** Streamable-HTTP MCP session for one registered user; re-initializes once if the session lapsed. */
class McpSession implements MergeToolCaller {
  private sessionId: string | null = null;
  private seq = 0;
  constructor(
    private url: string,
    private headers: Record<string, string>,
    private f: Fetch,
  ) {}

  private async rpc(method: string, params: unknown, notify = false) {
    const h: Record<string, string> = { ...this.headers };
    if (this.sessionId) h["mcp-session-id"] = this.sessionId;
    const body: Record<string, unknown> = { jsonrpc: "2.0", method, params };
    if (!notify) body.id = ++this.seq;
    const res = await this.f(this.url, { method: "POST", headers: h, body: JSON.stringify(body) });
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    const text = await res.text();
    if (!res.ok) throw new MergeApiError(res.status, `MCP ${method}: ${text.slice(0, 300)}`);
    if (notify || !text) return null;
    return parseSse(text) as { result?: unknown; error?: { message?: string } };
  }

  private async init() {
    this.sessionId = null;
    await this.rpc("initialize", {
      protocolVersion: MCP_PROTOCOL,
      capabilities: {},
      clientInfo: { name: "taxxy", version: "1" },
    });
    await this.rpc("notifications/initialized", {}, true);
  }

  async call(name: string, input: Record<string, unknown>): Promise<unknown> {
    if (!this.sessionId) await this.init();
    let r: Awaited<ReturnType<McpSession["rpc"]>>;
    try {
      r = await this.rpc("tools/call", { name, arguments: { input } });
    } catch (err) {
      if (!(err instanceof MergeApiError) || (err.status !== 400 && err.status !== 404)) throw err;
      await this.init();
      r = await this.rpc("tools/call", { name, arguments: { input } });
    }
    if (r?.error) throw new MergeToolError(name, r.error.message ?? "rpc error");
    const result = r?.result as
      | { isError?: boolean; content?: Array<{ type: string; text?: string }> }
      | undefined;
    const text = result?.content?.find((c) => c.type === "text")?.text ?? "";
    if (result?.isError) throw new MergeToolError(name, text.slice(0, 500));
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
}

export function mergeClient(env: MergeEnv, f: Fetch = fetch): MergeClientLike {
  const base = env.MERGE_API_BASE.replace(/\/$/, "");
  const headers = {
    Authorization: `Bearer ${env.MERGE_AGENT_HANDLER_TOKEN}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    // Merge's edge rejects the default Node UA.
    "User-Agent": "taxxy-agent/1",
  };
  async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await f(`${base}${path}`, { ...init, headers: { ...headers, ...init.headers } });
    const text = await res.text();
    if (!res.ok) throw new MergeApiError(res.status, `${path}: ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : null) as T;
  }
  const sessions = new Map<string, McpSession>();
  return {
    ensureRegisteredUser: (originUserId, originUserName) =>
      api<MergeRegisteredUser>("/api/v1/registered-users/", {
        method: "POST",
        body: JSON.stringify({ origin_user_id: originUserId, origin_user_name: originUserName }),
      }),
    registeredUser: (id) => api<MergeRegisteredUser>(`/api/v1/registered-users/${id}/`),
    async magicLink(registeredUserId, connector) {
      const r = await api<{ magic_link_url: string }>(
        `/api/v1/registered-users/${registeredUserId}/link-token/`,
        { method: "POST", body: JSON.stringify({ connector }) },
      );
      return r.magic_link_url;
    },
    tools(registeredUserId) {
      let s = sessions.get(registeredUserId);
      if (!s) {
        s = new McpSession(
          `${base}/api/v1/tool-packs/${env.MERGE_TOOL_PACK_ID}/registered-users/${registeredUserId}/mcp`,
          { ...headers, Accept: "application/json, text/event-stream" },
          f,
        );
        sessions.set(registeredUserId, s);
      }
      return s;
    },
  };
}
