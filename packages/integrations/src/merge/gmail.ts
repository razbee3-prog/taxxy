import type {
  AttachmentData,
  AttachmentRef,
  GmailClientLike,
  MessageBody,
  MessageSummary,
} from "../gmail/types.js";
import type { MergeToolCaller } from "./client.js";

interface ListedMessage {
  id: string;
  thread_id?: string | null;
  sender?: string | null;
  subject?: string | null;
  date?: string | null;
  snippet?: string | null;
  internal_date?: string | null;
}
interface MessageText {
  id?: string;
  thread_id?: string;
  sender?: string | null;
  to?: string | null;
  subject?: string | null;
  date?: string | null;
  snippet?: string | null;
  body?: string | null;
  text?: string | null;
  truncated?: boolean | null;
  attachments?: Array<{
    attachment_id: string;
    filename?: string | null;
    mime_type?: string | null;
    size?: number | null;
  }>;
}
interface Attachment {
  attachment?: {
    data?: string;
    filename?: string | null;
    mime_type?: string | null;
  };
}

const MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  txt: "text/plain",
  csv: "text/csv",
};

/** Gmail reports PDFs as octet-stream when the sender did; recover the type from the filename. */
export function attachmentMime(mime: string | null | undefined, filename: string): string {
  if (mime && mime !== "application/octet-stream") return mime;
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXT[ext] ?? mime ?? "application/octet-stream";
}

function toIsoDate(raw: string | number | null | undefined): string {
  const ms = Number(raw);
  const d = Number.isFinite(ms) && ms > 0 ? new Date(ms) : new Date(raw ?? "");
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}

function isoDate(m: ListedMessage): string {
  return toIsoDate(m.internal_date ?? m.date);
}

/**
 * Read-only Gmail through Merge's Tool Pack. Same contract as the direct client: headers and
 * attachment pointers only; the body is truncated to Merge's minimum `max_chars` (200) and discarded.
 */
/** Merge's `gmail__get_message_text` rejects `max_chars` below 200. */
const MIN_MAX_CHARS = 200;

export function mergeGmail(tools: MergeToolCaller): GmailClientLike {
  const mapAttachments = (t: MessageText): AttachmentRef[] =>
    (t.attachments ?? []).map((a) => ({
      id: a.attachment_id,
      filename: a.filename ?? "attachment",
      mime: attachmentMime(a.mime_type, a.filename ?? ""),
      size: a.size ?? 0,
    }));
  const messageText = (messageId: string, maxChars: number) =>
    tools.call("gmail__get_message_text", {
      message_id: messageId,
      max_chars: Math.max(MIN_MAX_CHARS, maxChars),
      include_quoted: false,
    }) as Promise<MessageText>;
  const attachmentsOf = async (messageId: string) =>
    mapAttachments(await messageText(messageId, MIN_MAX_CHARS));
  return {
    async search(query, maxResults = 25) {
      const r = (await tools.call("gmail__list_messages", {
        q: query,
        max_results: maxResults,
        label_ids: null,
        page_token: null,
        include_spam_trash: false,
        include_metadata: true,
        metadata_fields: ["sender", "subject", "date", "snippet"],
      })) as { messages?: ListedMessage[] };
      const out: MessageSummary[] = [];
      for (const m of r.messages ?? []) {
        if (!m.id) continue;
        out.push({
          id: m.id,
          threadId: m.thread_id ?? "",
          date: isoDate(m),
          from: m.sender ?? "",
          subject: m.subject ?? "",
          snippet: m.snippet ?? "",
          attachments: await attachmentsOf(m.id),
        });
      }
      return out;
    },
    async getMessageText(messageId, maxChars = 20_000): Promise<MessageBody> {
      const t = await messageText(messageId, maxChars);
      const full = t.text ?? t.body ?? "";
      const body = full.slice(0, maxChars);
      return {
        id: t.id ?? messageId,
        threadId: t.thread_id ?? "",
        date: toIsoDate(t.date),
        from: t.sender ?? "",
        to: t.to ?? "",
        subject: t.subject ?? "",
        snippet: t.snippet ?? body.slice(0, 120),
        attachments: mapAttachments(t),
        body,
        truncated: Boolean(t.truncated) || full.length > maxChars,
      };
    },
    async getAttachment(messageId, attachmentId): Promise<AttachmentData> {
      const r = (await tools.call("gmail__get_attachment", {
        message_id: messageId,
        attachment_id: attachmentId,
        return_download_url: false,
      })) as Attachment;
      const a = r.attachment ?? {};
      const ref = a.filename
        ? null
        : (await attachmentsOf(messageId)).find((x) => x.id === attachmentId);
      const filename = a.filename ?? ref?.filename ?? "attachment";
      return {
        bytes: Buffer.from(a.data ?? "", "base64"),
        mime: attachmentMime(a.mime_type ?? ref?.mime, filename),
        filename,
      };
    },
    async profileEmail() {
      const p = (await tools.call("gmail__get_profile", {})) as { email_address?: string };
      return p.email_address ?? "";
    },
  };
}
