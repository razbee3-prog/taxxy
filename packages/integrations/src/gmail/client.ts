import type { OAuth2Client } from "google-auth-library";
import { type gmail_v1, google } from "googleapis";
import {
  type AttachmentData,
  GMAIL_SCOPE,
  type GmailClientLike,
  type GmailTokens,
  type MessageBody,
  type MessageSummary,
} from "./types.js";

export interface GoogleOAuthEnv {
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GOOGLE_REDIRECT_URI: string;
}

export function oauthClient(env: GoogleOAuthEnv): OAuth2Client {
  return new google.auth.OAuth2(
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_CLIENT_SECRET,
    env.GOOGLE_REDIRECT_URI,
  );
}

/** Read-only scope only; `include_granted_scopes` is deliberately off so a broader grant can't be reused. */
export function gmailAuthUrl(env: GoogleOAuthEnv, state: string): string {
  return oauthClient(env).generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [GMAIL_SCOPE],
    include_granted_scopes: false,
    state,
  });
}

export async function exchangeAuthCode(env: GoogleOAuthEnv, code: string): Promise<GmailTokens> {
  const { tokens } = await oauthClient(env).getToken(code);
  if (!tokens.refresh_token)
    throw new Error("Google did not return a refresh token; re-consent is required");
  const scopes = (tokens.scope ?? "").split(" ").filter(Boolean);
  if (scopes.some((s) => s !== GMAIL_SCOPE))
    throw new Error(`unexpected Gmail scope granted: ${tokens.scope}`);
  return {
    refresh_token: tokens.refresh_token,
    access_token: tokens.access_token ?? undefined,
    expiry_date: tokens.expiry_date ?? undefined,
    scope: tokens.scope ?? undefined,
  };
}

function header(msg: gmail_v1.Schema$Message, name: string): string {
  return msg.payload?.headers?.find((h) => h.name?.toLowerCase() === name)?.value ?? "";
}

function textOf(payload: gmail_v1.Schema$MessagePart | undefined): string {
  if (!payload) return "";
  const parts: gmail_v1.Schema$MessagePart[] = [];
  const walk = (p: gmail_v1.Schema$MessagePart) => {
    parts.push(p);
    for (const c of p.parts ?? []) walk(c);
  };
  walk(payload);
  const decode = (p: gmail_v1.Schema$MessagePart) =>
    Buffer.from(p.body?.data ?? "", "base64url").toString("utf8");
  const plain = parts.find((p) => p.mimeType === "text/plain" && p.body?.data);
  if (plain) return decode(plain);
  const html = parts.find((p) => p.mimeType === "text/html" && p.body?.data);
  if (html)
    return decode(html)
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/[ \t]+/g, " ")
      .replace(/\s*\n\s*/g, "\n")
      .trim();
  return "";
}

function attachmentsOf(
  part: gmail_v1.Schema$MessagePart | undefined,
  out: MessageSummary["attachments"] = [],
) {
  if (!part) return out;
  if (part.filename && part.body?.attachmentId) {
    out.push({
      id: part.body.attachmentId,
      filename: part.filename,
      mime: part.mimeType ?? "application/octet-stream",
      size: part.body.size ?? 0,
    });
  }
  for (const p of part.parts ?? []) attachmentsOf(p, out);
  return out;
}

export function gmailClient(
  env: GoogleOAuthEnv,
  tokens: GmailTokens,
  onRefresh?: (t: GmailTokens) => Promise<void>,
): GmailClientLike {
  const auth = oauthClient(env);
  auth.setCredentials(tokens);
  auth.on("tokens", (t) => {
    if (onRefresh)
      void onRefresh({
        ...tokens,
        access_token: t.access_token ?? undefined,
        expiry_date: t.expiry_date ?? undefined,
      });
  });
  const gmail = google.gmail({ version: "v1", auth });
  return {
    async search(query, maxResults = 25) {
      const list = await gmail.users.messages.list({ userId: "me", q: query, maxResults });
      const out: MessageSummary[] = [];
      for (const m of list.data.messages ?? []) {
        if (!m.id) continue;
        const full = await gmail.users.messages.get({
          userId: "me",
          id: m.id,
          format: "metadata",
          metadataHeaders: ["From", "Subject", "Date"],
        });
        const withParts = await gmail.users.messages.get({
          userId: "me",
          id: m.id,
          format: "full",
        });
        out.push({
          id: m.id,
          threadId: full.data.threadId ?? "",
          date: new Date(Number(full.data.internalDate ?? 0)).toISOString().slice(0, 10),
          from: header(full.data, "from"),
          subject: header(full.data, "subject"),
          snippet: full.data.snippet ?? "",
          attachments: attachmentsOf(withParts.data.payload),
        });
      }
      return out;
    },
    async getMessageText(messageId, maxChars = 20_000): Promise<MessageBody> {
      const msg = await gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });
      const text = textOf(msg.data.payload);
      return {
        id: messageId,
        threadId: msg.data.threadId ?? "",
        date: new Date(Number(msg.data.internalDate ?? 0)).toISOString().slice(0, 10),
        from: header(msg.data, "from"),
        to: header(msg.data, "to"),
        subject: header(msg.data, "subject"),
        snippet: msg.data.snippet ?? "",
        attachments: attachmentsOf(msg.data.payload),
        body: text.slice(0, maxChars),
        truncated: text.length > maxChars,
      };
    },
    async getAttachment(messageId, attachmentId): Promise<AttachmentData> {
      const a = await gmail.users.messages.attachments.get({
        userId: "me",
        messageId,
        id: attachmentId,
      });
      const msg = await gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });
      const ref = attachmentsOf(msg.data.payload).find((x) => x.id === attachmentId);
      return {
        bytes: Buffer.from(a.data.data ?? "", "base64url"),
        mime: ref?.mime ?? "application/octet-stream",
        filename: ref?.filename ?? "attachment",
      };
    },
    async profileEmail() {
      return (await gmail.users.getProfile({ userId: "me" })).data.emailAddress ?? "";
    },
  };
}

export interface FixtureMailbox {
  email: string;
  messages: Array<
    MessageSummary & {
      to?: string;
      body?: string;
      attachmentData: Record<string, { mime: string; filename: string; base64: string }>;
    }
  >;
}

/** Offline mailbox: a naive query matcher over subject/from/snippet/filenames and the date range. */
export function fixtureGmail(box: FixtureMailbox): GmailClientLike {
  const strip = ({
    attachmentData: _d,
    body: _b,
    to: _t,
    ...m
  }: FixtureMailbox["messages"][number]) => m;
  return {
    async search(query, maxResults = 25) {
      const terms = [...query.matchAll(/\(([^)]+)\)/g)]
        .flatMap((m) => (m[1] ?? "").split(/\s+OR\s+/i))
        .map((t) => t.trim().toLowerCase());
      const bare = query
        .replace(/\([^)]*\)/g, " ")
        .split(/\s+/)
        .filter((w) => w && !/^(after|before|newer_than|older_than|has|is|in|label):/i.test(w))
        .map((w) => w.toLowerCase());
      const after = /after:(\d{4})\/(\d{2})\/(\d{2})/.exec(query);
      const before = /before:(\d{4})\/(\d{2})\/(\d{2})/.exec(query);
      const wantsAttachment = /has:attachment/.test(query);
      return box.messages
        .filter((m) => {
          if (wantsAttachment && !m.attachments.length) return false;
          if (after && m.date < `${after[1]}-${after[2]}-${after[3]}`) return false;
          if (before && m.date >= `${before[1]}-${before[2]}-${before[3]}`) return false;
          const hay =
            `${m.subject} ${m.from} ${m.snippet} ${m.attachments.map((a) => a.filename).join(" ")}`.toLowerCase();
          const hit = (t: string) =>
            hay.includes(t.replace(/^(filename|subject|from):/, "").replace(/"/g, ""));
          if (terms.length && !terms.some(hit)) return false;
          return bare.every(hit);
        })
        .slice(0, maxResults)
        .map(strip);
    },
    async getMessageText(messageId, maxChars = 20_000) {
      const m = box.messages.find((x) => x.id === messageId);
      if (!m) throw new Error(`fixtureGmail: no message ${messageId}`);
      const text = m.body ?? m.snippet;
      return {
        ...strip(m),
        to: m.to ?? box.email,
        body: text.slice(0, maxChars),
        truncated: text.length > maxChars,
      };
    },
    async getAttachment(messageId, attachmentId) {
      const m = box.messages.find((x) => x.id === messageId);
      const a = m?.attachmentData[attachmentId];
      if (!a) throw new Error(`fixtureGmail: no attachment ${attachmentId} on ${messageId}`);
      return { bytes: Buffer.from(a.base64, "base64"), mime: a.mime, filename: a.filename };
    },
    async profileEmail() {
      return box.email;
    },
  };
}
