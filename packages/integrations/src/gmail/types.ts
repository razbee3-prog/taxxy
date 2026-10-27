export interface AttachmentRef {
  id: string;
  filename: string;
  mime: string;
  size: number;
}

/** What Taxxy keeps about an email: headers and attachment pointers, never the body. */
export interface MessageSummary {
  id: string;
  threadId: string;
  date: string;
  from: string;
  subject: string;
  snippet: string;
  attachments: AttachmentRef[];
}

export interface AttachmentData {
  bytes: Uint8Array;
  mime: string;
  filename: string;
}

/** A message with its plain-text body, truncated to `maxChars`. */
export interface MessageBody extends MessageSummary {
  to: string;
  body: string;
  truncated: boolean;
}

export interface GmailClientLike {
  /** Any Gmail search query (`is:unread`, `from:`, `newer_than:7d`, ...). */
  search(query: string, maxResults?: number): Promise<MessageSummary[]>;
  getMessageText(messageId: string, maxChars?: number): Promise<MessageBody>;
  getAttachment(messageId: string, attachmentId: string): Promise<AttachmentData>;
  profileEmail(): Promise<string>;
}

export interface GmailTokens {
  refresh_token: string;
  access_token?: string;
  expiry_date?: number;
  scope?: string;
}

export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
