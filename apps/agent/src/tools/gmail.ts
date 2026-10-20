import { tool } from "@langchain/core/tools";
import { getGmailAccount, scoped } from "@taxxy/db";
import { z } from "zod";
import type { AppDeps } from "../deps.js";
import {
  extractPriorYear1040,
  fetchAttachment,
  GmailNotConnected,
  matchReceiptsForPeriod,
  searchReceipts,
} from "../services/gmail.js";
import { requireUserId } from "./context.js";

const json = (v: unknown) => JSON.stringify(v);
const guard = async <T>(fn: () => Promise<T>) => {
  try {
    return json(await fn());
  } catch (err) {
    if (err instanceof GmailNotConnected)
      return json({
        error: "gmail_not_connected",
        message: "Ask the user to connect Gmail (read-only) from the account page.",
      });
    throw err;
  }
};

export function gmailTools(d: AppDeps) {
  const gmail_status = tool(
    async (_i, config) => {
      const userId = requireUserId(config);
      const a = await getGmailAccount(scoped(d.db, userId));
      return json(a ? { connected: true, email: a.email, scope: a.scope } : { connected: false });
    },
    {
      name: "gmail_status",
      description: "Whether the user connected Gmail (read-only).",
      schema: z.object({}),
    },
  );

  const gmail_search_receipts = tool(
    async ({ from, to, query }, config) => {
      const userId = requireUserId(config);
      return guard(() => searchReceipts(d, userId, from, to, query));
    },
    {
      name: "gmail_search_receipts",
      description:
        "Search Gmail for receipts/invoices with attachments in a date window. Returns headers and attachment pointers only, never bodies.",
      schema: z.object({
        from: z.string().describe("ISO date"),
        to: z.string().describe("ISO date"),
        query: z.string().optional(),
      }),
    },
  );

  const gmail_fetch_attachment = tool(
    async ({ messageId, attachmentId }, config) => {
      const userId = requireUserId(config);
      return guard(() => fetchAttachment(d, userId, messageId, attachmentId));
    },
    {
      name: "gmail_fetch_attachment",
      description:
        "Store one attachment in object storage and return its fileRef (bytes are never returned).",
      schema: z.object({ messageId: z.string(), attachmentId: z.string() }),
    },
  );

  const match_receipts = tool(
    async ({ from, to }, config) => {
      const userId = requireUserId(config);
      return guard(() => matchReceiptsForPeriod(d, userId, from, to));
    },
    {
      name: "match_receipts",
      description:
        "Find receipts for business transactions ≥ $75 that lack evidence in the window; matched items get +0.1 confidence and lose the needs-receipt flag.",
      schema: z.object({ from: z.string(), to: z.string() }),
    },
  );

  const extract_prior_year_1040 = tool(
    async ({ fileRef, taxYear }, config) => {
      const userId = requireUserId(config);
      return guard(() => extractPriorYear1040(d, userId, { fileRef, taxYear }));
    },
    {
      name: "extract_prior_year_1040",
      description:
        "Pull last year's Form 1040 from Gmail (or a given fileRef), extract line 11 (AGI) and line 24 (total tax) and save them as UNCONFIRMED. You must read both numbers back and get the user's confirmation, then save prior_year.confirmed=true with upsert_tax_profile.",
      schema: z.object({ fileRef: z.string().optional(), taxYear: z.number().int().optional() }),
    },
  );

  return [
    gmail_status,
    gmail_search_receipts,
    gmail_fetch_attachment,
    match_receipts,
    extract_prior_year_1040,
  ];
}
