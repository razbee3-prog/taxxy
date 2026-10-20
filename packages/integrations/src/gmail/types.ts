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

export interface GmailClientLike {
  search(query: string, maxResults?: number): Promise<MessageSummary[]>;
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
