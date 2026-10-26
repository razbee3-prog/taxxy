import type { AttachmentData, GmailClientLike, MessageSummary } from "../gmail/types.js";
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

function isoDate(m: ListedMessage): string {
  const ms = Number(m.internal_date);
  const d = Number.isFinite(ms) && ms > 0 ? new Date(ms) : new Date(m.date ?? "");
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}

/**
 * Read-only Gmail through Merge's Tool Pack. Same contract as the direct client: headers and
 * attachment pointers only, never bodies (bodies are requested with max_chars=0).
 */
export function mergeGmail(tools: MergeToolCaller): GmailClientLike {
  const attachmentsOf = async (messageId: string) => {
    const t = (await tools.call("gmail__get_message_text", {
      message_id: messageId,
      max_chars: 0,
      include_quoted: false,
    })) as MessageText;
    return (t.attachments ?? []).map((a) => ({
      id: a.attachment_id,
      filename: a.filename ?? "attachment",
      mime: attachmentMime(a.mime_type, a.filename ?? ""),
      size: a.size ?? 0,
    }));
  };
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
