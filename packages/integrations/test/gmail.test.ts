import { describe, expect, it } from "vitest";
import { fixtureGmail } from "../src/gmail/client.js";
import {
  documentText,
  priorYearFieldsHeuristic,
  receiptFieldsHeuristic,
} from "../src/gmail/extract.js";
import { matchReceipts, scoreReceiptMatch } from "../src/gmail/match.js";
import { priorYearQuery, receiptQuery } from "../src/gmail/queries.js";
import { loadMailbox } from "./mailbox.js";
import { tinyPdf } from "./pdf.js";

describe("gmail queries", () => {
  it("builds the spec's receipt and 1040 searches", () => {
    expect(receiptQuery("2026-10-01", "2026-12-31")).toBe(
      "has:attachment (receipt OR invoice OR order) after:2026/10/01 before:2026/12/31",
    );
    expect(priorYearQuery(2025)).toBe(
      '(filename:1040 OR subject:"tax return") after:2026/01/01 before:2027/01/01',
    );
  });
});

describe("fixture mailbox", () => {
  it("filters by terms, date range and attachments, and never returns bodies", async () => {
    const box = loadMailbox();
    const g = fixtureGmail(box);
    const receipts = await g.search(receiptQuery("2026-10-01", "2026-12-31"));
    expect(receipts.length).toBeGreaterThanOrEqual(2);
    for (const m of receipts)
      expect(Object.keys(m).sort()).toEqual([
        "attachments",
        "date",
        "from",
        "id",
        "snippet",
        "subject",
        "threadId",
      ]);
    const prior = await g.search(priorYearQuery(2025));
    expect(prior.map((m) => m.subject)).toContain("Your 2025 tax return");
    const a = await g.getAttachment(prior[0]?.id ?? "", prior[0]?.attachments[0]?.id ?? "");
    expect(a.mime).toBe("application/pdf");
  });
});

describe("extraction heuristics", () => {
  it("reads line 11 and line 24 from a 1040-like PDF", async () => {
    const pdf = tinyPdf([
      "Form 1040 2025 U.S. Individual Income Tax Return",
      "Filing status: Single",
      "11 Adjusted gross income 70,000",
      "24 Total tax 8,000",
    ]);
    const text = await documentText(pdf, "application/pdf");
    const f = priorYearFieldsHeuristic(text);
    expect(f).toMatchObject({ taxYear: 2025, filingStatus: "single", agi: 70000, totalTax: 8000 });
    expect(f.confidence).toBeGreaterThan(0.5);
  });
  it("reads vendor, total and date from a plain-text receipt", () => {
    const f = receiptFieldsHeuristic(
      "SparkFun Electronics\nOrder #1234\nDate: 10/09/2026\nSubtotal $82.00\nTax $7.40\nTotal $89.40",
      { from: "SparkFun <orders@sparkfun.com>" },
    );
    expect(f).toMatchObject({ vendor: "SparkFun", total: 89.4, date: "2026-10-09" });
  });
});

describe("receipt matching", () => {
  const txns = [
    {
      id: "t1",
      amount: 89.4,
      date: "2026-10-10",
      description: "SparkFun",
      merchant_key: "sparkfun",
    },
    {
      id: "t2",
      amount: 500,
      date: "2026-10-12",
      description: "United Airlines",
      merchant_key: "united_airlines",
    },
    {
      id: "t3",
      amount: 500,
      date: "2026-10-20",
      description: "Madison Bicycle Shop",
      merchant_key: "madison_bicycle_shop",
    },
  ];
  it("scores exact amount + near date + vendor highest", () => {
    const s = scoreReceiptMatch(
      { key: "r1", vendor: "SparkFun", total: 89.4, date: "2026-10-09" },
      txns[0] as never,
    );
    expect(s).toBeGreaterThanOrEqual(0.9);
    expect(
      scoreReceiptMatch({ key: "r", vendor: null, total: 89.4, date: null }, txns[0] as never),
    ).toBe(0.6);
    expect(
      scoreReceiptMatch({ key: "r", vendor: "x", total: 12, date: "2026-10-10" }, txns[0] as never),
    ).toBe(0);
  });
  it("assigns one receipt per transaction, best score first, disambiguating equal amounts by date/vendor", () => {
    const m = matchReceipts(
      [
        { key: "united", vendor: "United Airlines", total: 500, date: "2026-10-12" },
        { key: "bike", vendor: "Madison Bicycle Shop", total: 500, date: "2026-10-19" },
      ],
      txns,
    );
    expect(Object.fromEntries(m.map((x) => [x.receiptKey, x.transactionId]))).toEqual({
      united: "t2",
      bike: "t3",
    });
  });
});
