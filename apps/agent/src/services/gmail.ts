import {
  connectGmailAccount,
  currentCategorization,
  getGmailAccount,
  getMergeUser,
  listCurrentCategorizations,
  recordCategorization,
  scoped,
  setMergeUser,
  upsertReceipt,
  upsertTaxProfile,
  withGmailRefreshToken,
} from "@taxxy/db";
import {
  documentText,
  extractPriorYearFields,
  extractReceiptFields,
  GMAIL_SCOPE,
  type GmailClientLike,
  type MessageSummary,
  matchReceipts,
  priorYearQuery,
  receiptQuery,
  withEvidence,
} from "@taxxy/integrations";
import type { AppDeps } from "../deps.js";

export class GmailNotConnected extends Error {
  constructor() {
    super("Gmail is not connected for this user");
    this.name = "GmailNotConnected";
  }
}

export async function gmailClientFor(d: AppDeps, userId: string): Promise<GmailClientLike> {
  const s = scoped(d.db, userId);
  if (d.env.GMAIL_MODE === "fixture") {
    if (!(await getGmailAccount(s))) throw new GmailNotConnected();
    return d.gmailFor("fixture");
  }
  if (d.env.GMAIL_MODE === "merge") {
    const [acct, mu] = await Promise.all([getGmailAccount(s), getMergeUser(s)]);
    if (acct?.provider !== "merge" || !mu) throw new GmailNotConnected();
    return d.gmailFor(mu.registered_user_id);
  }
  const c = await withGmailRefreshToken(s, d.vault, async (token) => d.gmailFor(token));
  if (!c) throw new GmailNotConnected();
  return c;
}

/** OAuth callback: tokens never reach the model; only the sealed refresh token is stored. */
export async function connectGmail(
  d: AppDeps,
  userId: string,
  tokens: { refresh_token: string; scope?: string },
) {
  const client = d.gmailFor(tokens.refresh_token);
  const email = await client.profileEmail();
  return connectGmailAccount(scoped(d.db, userId), d.vault, {
    email,
    refresh_token: tokens.refresh_token,
    scope: tokens.scope ?? GMAIL_SCOPE,
  });
}

const MERGE_GMAIL = "gmail";

function mergeOf(d: AppDeps) {
  if (!d.merge) throw new Error("Merge Agent Handler is not configured (GMAIL_MODE=merge)");
  return d.merge;
}

/** Merge mode: make sure this user has a Merge registered user, then mint a one-time Gmail link. */
export async function beginMergeGmail(d: AppDeps, userId: string, displayName: string) {
  const merge = mergeOf(d);
  const s = scoped(d.db, userId);
  let mu = await getMergeUser(s);
  if (!mu) {
    const ru = await merge.ensureRegisteredUser(`taxxy:${userId}`, displayName);
    mu = await setMergeUser(s, ru.id);
  }
  return { url: await merge.magicLink(mu.registered_user_id, MERGE_GMAIL) };
}

/**
 * Merge mode: the Magic Link ends on Merge's page, not ours, so the app polls this. Once Merge
 * reports Gmail authenticated we read the address through Merge and record the account.
 */
export async function syncMergeGmail(
  d: AppDeps,
  userId: string,
): Promise<{ connected: boolean; email?: string; scope?: string }> {
  const s = scoped(d.db, userId);
  const acct = await getGmailAccount(s);
  if (acct?.provider === "merge") return { connected: true, email: acct.email, scope: acct.scope };
  const mu = await getMergeUser(s);
  if (!mu) return { connected: false };
  const ru = await mergeOf(d).registeredUser(mu.registered_user_id);
  if (!ru.authenticated_connectors.includes(MERGE_GMAIL)) return { connected: false };
  const email = await d.gmailFor(mu.registered_user_id).profileEmail();
  const saved = await connectGmailAccount(s, d.vault, {
    email,
    scope: GMAIL_SCOPE,
    provider: "merge",
  });
  return { connected: true, email: saved.email, scope: saved.scope };
}

export async function searchReceipts(
  d: AppDeps,
  userId: string,
  from: string,
  to: string,
  query?: string,
): Promise<MessageSummary[]> {
  const g = await gmailClientFor(d, userId);
  return g.search(receiptQuery(from, to, query));
}

/** Stores the attachment in object storage; returns a pointer, never bytes. */
/** Any Gmail search, bounded; the caller's user id comes from the session, never the model. */
export async function searchMail(d: AppDeps, userId: string, query: string, maxResults = 25) {
  const g = await gmailClientFor(d, userId);
  return g.search(query, Math.min(Math.max(1, maxResults), 100));
}

export async function readMessage(
  d: AppDeps,
  userId: string,
  messageId: string,
  maxChars = 20_000,
) {
  const g = await gmailClientFor(d, userId);
  return g.getMessageText(messageId, Math.min(Math.max(200, maxChars), 100_000));
}

export async function fetchAttachment(
  d: AppDeps,
  userId: string,
  messageId: string,
  attachmentId: string,
) {
  const g = await gmailClientFor(d, userId);
  const a = await g.getAttachment(messageId, attachmentId);
  const stored = await d.files.put(userId, a.bytes, a.mime, a.filename);
  return {
    fileRef: stored.fileRef,
    mime: a.mime,
    filename: a.filename,
    bytes: a.bytes.length,
    sha256: stored.sha256,
  };
}

export interface MatchSummary {
  candidates: number;
  receiptsFound: number;
  matched: Array<{
    transactionId: string;
    receiptVendor: string | null;
    total: number | null;
    score: number;
  }>;
}

/** receipt-matcher: business items ≥ $75 without evidence ↔ receipts in the window. */
export async function matchReceiptsForPeriod(
  d: AppDeps,
  userId: string,
  from: string,
  to: string,
): Promise<MatchSummary> {
  const s = scoped(d.db, userId);
  const rows = (
    await listCurrentCategorizations(s, { statuses: ["auto", "uncertain", "accepted"] })
  ).filter((r) => r.needs_receipt && r.txn.date >= from && r.txn.date <= to);
  const txns = rows.map((r) => ({
    id: r.txn.id,
    amount: r.txn.amount,
    date: r.txn.date,
    description: r.txn.description,
    merchant_key: r.txn.merchant_key,
  }));
  if (!txns.length) return { candidates: 0, receiptsFound: 0, matched: [] };
  const g = await gmailClientFor(d, userId);
  const messages = await g.search(receiptQuery(from, to), 50);
  const receipts: Array<{
    key: string;
    vendor: string | null;
    total: number | null;
    date: string | null;
    messageId: string;
    attachmentId: string;
    fileRef: string;
  }> = [];
  for (const m of messages) {
    for (const a of m.attachments) {
      const data = await g.getAttachment(m.id, a.id);
      const stored = await d.files.put(userId, data.bytes, data.mime, data.filename);
      const text = await documentText(data.bytes, data.mime).catch(() => "");
      const f = await extractReceiptFields(text, d.extractionModel, {
        from: m.from,
        subject: m.subject,
      });
      const r = {
        key: `${m.id}/${a.id}`,
        vendor: f.vendor,
        total: f.total,
        date: f.date ?? m.date,
        messageId: m.id,
        attachmentId: a.id,
        fileRef: stored.fileRef,
      };
      receipts.push(r);
      await upsertReceipt(s, {
        gmail_message_id: m.id,
        attachment_id: a.id,
        vendor: r.vendor,
        total: r.total,
        date: r.date,
        file_ref: r.fileRef,
        transaction: null,
        match_score: null,
      });
    }
  }
  const matches = matchReceipts(receipts, txns);
  const matched: MatchSummary["matched"] = [];
  for (const mt of matches) {
    const r = receipts.find((x) => x.key === mt.receiptKey);
    if (!r) continue;
    await upsertReceipt(s, {
      gmail_message_id: r.messageId,
      attachment_id: r.attachmentId,
      vendor: r.vendor,
      total: r.total,
      date: r.date,
      file_ref: r.fileRef,
      transaction: mt.transactionId,
      match_score: mt.score,
    });
    const cur = await currentCategorization(s, mt.transactionId);
    if (cur) {
      const confidence = withEvidence(cur.confidence);
      await recordCategorization(s, {
        transaction: mt.transactionId,
        label: cur.label,
        is_business: cur.is_business,
        confidence,
        source: cur.source,
        status:
          cur.status === "accepted"
            ? "accepted"
            : confidence >= d.env.CATEGORIZER_THRESHOLD
              ? "auto"
              : "uncertain",
        rationale: `${cur.rationale ?? ""}; receipt matched (${mt.score})`.replace(/^; /, ""),
        model: cur.model,
        rule_id: cur.rule_id,
        needs_receipt: false,
      });
    }
    matched.push({
      transactionId: mt.transactionId,
      receiptVendor: r.vendor,
      total: r.total,
      score: mt.score,
    });
  }
  return { candidates: txns.length, receiptsFound: receipts.length, matched };
}

/** Finds last year's 1040 in Gmail (or uses a given fileRef), extracts two numbers, stores them UNCONFIRMED. */
export async function extractPriorYear1040(
  d: AppDeps,
  userId: string,
  opts: { fileRef?: string; taxYear?: number },
) {
  const s = scoped(d.db, userId);
  let fileRef = opts.fileRef;
  let source = "upload";
  if (!fileRef) {
    const g = await gmailClientFor(d, userId);
    const year = opts.taxYear ?? new Date().getUTCFullYear() - 1;
    const msgs = await g.search(priorYearQuery(year), 10);
    const hit = msgs.flatMap((m) =>
      m.attachments
        .filter((a) => /pdf/i.test(a.mime) || /1040/i.test(a.filename))
        .map((a) => ({ m, a })),
    )[0];
    if (!hit) return { found: false as const, searched: msgs.length };
    const stored = await fetchAttachment(d, userId, hit.m.id, hit.a.id);
    fileRef = stored.fileRef;
    source = `gmail:${hit.m.subject}`;
  }
  const file = await d.files.get(fileRef);
  const text = await documentText(file.bytes, file.mime);
  const f = await extractPriorYearFields(text, d.extractionModel);
  if (f.agi !== null && f.totalTax !== null) {
    await upsertTaxProfile(
      s,
      { prior_year: { total_tax: f.totalTax, agi: f.agi, confirmed: false } },
      "agent",
    );
  }
  return { found: true as const, fileRef, source, ...f, confirmed: false };
}
