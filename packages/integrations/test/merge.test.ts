import { describe, expect, it } from "vitest";
import type { MergeToolCaller } from "../src/merge/client.js";
import { attachmentMime, mergeGmail } from "../src/merge/gmail.js";

/** Stand-in for Merge's Gmail Tool Pack, shaped like the real tool payloads. */
function fakeTools(
  calls: Array<{ name: string; input: Record<string, unknown> }>,
): MergeToolCaller {
  return {
    async call(name, input) {
      calls.push({ name, input });
      switch (name) {
        case "gmail__get_profile":
          return { email_address: "raz@example.com", messages_total: 3 };
        case "gmail__list_messages":
          return {
            messages: [
              {
                id: "m1",
                thread_id: "t1",
                sender: "Curb <support@gocurb.com>",
                subject: "Your Curb Ride Receipt",
                date: "Sat, 24 Oct 2026 16:48:56 +0000",
                snippet: "Total $16.22",
                internal_date: "1792860536000",
              },
              { id: "m2", thread_id: "t2", sender: "a@b.c", subject: "No attachments", date: null },
            ],
            next_page_token: null,
          };
        case "gmail__get_message_text":
          return input.message_id === "m1"
            ? {
                id: "m1",
                attachments: [
                  {
                    attachment_id: "a1",
                    filename: "receipt.pdf",
                    mime_type: "application/octet-stream",
                    size: 5,
                  },
                ],
              }
            : { id: "m2", attachments: [] };
        case "gmail__get_attachment":
          return {
            attachment: {
              attachment_id: "a1",
              size: 5,
              data: Buffer.from("hello").toString("base64"),
            },
          };
        default:
          throw new Error(`unexpected tool ${name}`);
      }
    },
  };
}

describe("mergeGmail", () => {
  it("maps Merge list/get_message_text into MessageSummary without bodies", async () => {
    const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
    const g = mergeGmail(fakeTools(calls));
    const msgs = await g.search("has:attachment (receipt OR invoice) after:2026/10/01", 7);
    expect(calls[0]).toMatchObject({
      name: "gmail__list_messages",
      input: { q: "has:attachment (receipt OR invoice) after:2026/10/01", max_results: 7 },
    });
    expect(msgs).toEqual([
      {
        id: "m1",
        threadId: "t1",
        date: "2026-10-24",
        from: "Curb <support@gocurb.com>",
        subject: "Your Curb Ride Receipt",
        snippet: "Total $16.22",
        attachments: [{ id: "a1", filename: "receipt.pdf", mime: "application/pdf", size: 5 }],
      },
      {
        id: "m2",
        threadId: "t2",
        date: "",
        from: "a@b.c",
        subject: "No attachments",
        snippet: "",
        attachments: [],
      },
    ]);
    // bodies are never requested
    for (const c of calls.filter((c) => c.name === "gmail__get_message_text"))
      expect(c.input.max_chars).toBe(0);
  });

  it("decodes attachments and recovers the filename/mime from the message when Merge omits them", async () => {
    const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
    const a = await mergeGmail(fakeTools(calls)).getAttachment("m1", "a1");
    expect(Buffer.from(a.bytes).toString()).toBe("hello");
    expect(a).toMatchObject({ filename: "receipt.pdf", mime: "application/pdf" });
    expect(calls[0]).toMatchObject({
      name: "gmail__get_attachment",
      input: { message_id: "m1", attachment_id: "a1", return_download_url: false },
    });
  });

  it("reads the profile email", async () => {
    expect(await mergeGmail(fakeTools([])).profileEmail()).toBe("raz@example.com");
  });

  it("attachmentMime trusts a real type and infers from the extension otherwise", () => {
    expect(attachmentMime("image/png", "x.pdf")).toBe("image/png");
    expect(attachmentMime("application/octet-stream", "Form1040.PDF")).toBe("application/pdf");
    expect(attachmentMime(null, "notes.txt")).toBe("text/plain");
    expect(attachmentMime("application/octet-stream", "blob")).toBe("application/octet-stream");
  });
});
