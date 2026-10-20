import { listBankAccounts, listEstimates, scoped } from "@taxxy/db";
import type { Quarter } from "@taxxy/engine";
import { z } from "zod";
import type { AppDeps } from "../deps.js";
import { appendMemory } from "../memory.js";
import {
  acceptEstimate,
  computeQuarterlyEstimate,
  ProfileIncompleteError,
} from "../services/estimate.js";
import { requireUserId } from "./context.js";
import { gtool as tool } from "./guard.js";

const json = (v: unknown) => JSON.stringify(v);

export function estimateTools(d: AppDeps) {
  const compute_quarterly_estimate = tool(
    async ({ taxYear, quarter, overrides }, config) => {
      const userId = requireUserId(config);
      try {
        const r = await computeQuarterlyEstimate(
          d,
          userId,
          taxYear,
          quarter as Quarter,
          overrides ?? {},
        );
        if (d.store)
          await appendMemory(
            d.store,
            userId,
            "Safe harbor",
            `Q${quarter} ${taxYear}: ${r.result.safeHarborUsed} method used`,
          );
        return json({ estimateId: r.estimateId, counts: r.counts, ...r.result });
      } catch (err) {
        if (err instanceof ProfileIncompleteError)
          return json({ error: "profile_incomplete", missing: err.missing });
        throw err;
      }
    },
    {
      name: "compute_quarterly_estimate",
      description:
        "Run the deterministic tax engine for a quarter and save the estimate. The ONLY source of tax dollar figures: quote installmentDue and line values verbatim.",
      schema: z.object({
        taxYear: z.number().int(),
        quarter: z.number().int().min(1).max(4),
        overrides: z
          .object({
            projectionMethod: z.enum(["linear", "manual"]).optional(),
            manualAnnualNetProfit: z.number().min(0).optional(),
            w2Wages: z.number().min(0).optional(),
            w2WithholdingExpectedAnnual: z.number().min(0).optional(),
            seHealthPremiums: z.number().min(0).optional(),
            sepContribution: z.number().min(0).optional(),
            usePriorYear: z.boolean().optional(),
          })
          .optional()
          .describe(
            "input changes the user asked for; a new estimate is computed, numbers are never edited directly",
          ),
      }),
    },
  );

  const accept_estimate = tool(
    async ({ estimateId, edits }, config) => {
      const userId = requireUserId(config);
      const row = await acceptEstimate(d, userId, estimateId, edits);
      return json({
        estimateId: row.id,
        status: row.status,
        taxYear: row.tax_year,
        quarter: row.quarter,
      });
    },
    {
      name: "accept_estimate",
      description:
        "Record that the user accepted the estimate (status accepted, or edited if they changed an input and accepted the recomputed one).",
      schema: z.object({
        estimateId: z.string(),
        edits: z.record(z.string(), z.unknown()).optional(),
      }),
    },
  );

  const get_estimate = tool(
    async ({ taxYear, estimateId }, config) => {
      const userId = requireUserId(config);
      const all = await listEstimates(scoped(d.db, userId), taxYear);
      const e = estimateId ? all.find((x) => x.id === estimateId) : all[0];
      return json(e ? { estimateId: e.id, status: e.status, ...e.result } : null);
    },
    {
      name: "get_estimate",
      description:
        "Load a saved estimate (latest by default) with its full worksheet lines for explanation.",
      schema: z.object({ taxYear: z.number().int().optional(), estimateId: z.string().optional() }),
    },
  );

  const record_payment = tool(
    async ({ estimateId, amount, confirmation, paidAt }, config) => {
      const userId = requireUserId(config);
      const s = scoped(d.db, userId);
      const row = await s.create("payment", {
        estimate: estimateId ?? null,
        amount,
        method: "manual",
        confirmation: confirmation ?? null,
        paid_at: paidAt,
      });
      return json({ paymentId: row.id });
    },
    {
      name: "record_payment",
      description:
        "Record a payment the user made on IRS Direct Pay (user-entered; v1 never submits payments).",
      schema: z.object({
        estimateId: z.string().optional(),
        amount: z.number().positive(),
        confirmation: z.string().optional(),
        paidAt: z.string().describe("ISO date"),
      }),
    },
  );

  const submit_payment = tool(
    async ({ estimateId }, config) => {
      requireUserId(config);
      return json({
        error: "not_available",
        message:
          "Automatic payment submission is not enabled in v1. Give the user Direct Pay instructions instead.",
        estimateId,
      });
    },
    {
      name: "submit_payment",
      description:
        "Backlog: submit the accepted estimate on IRS Direct Pay. Disabled in v1 (always returns not_available).",
      schema: z.object({ estimateId: z.string() }),
    },
  );

  const delete_bank_account = tool(
    async ({ itemId }, config) => {
      const userId = requireUserId(config);
      const s = scoped(d.db, userId);
      await s.update(itemId, { status: "removed" });
      const accounts = await listBankAccounts(s);
      return json({ itemId, status: "removed", accountsRemaining: accounts.length });
    },
    {
      name: "delete_bank_account",
      description:
        "Unlink a bank connection (bank_item). Irreversible for synced history; requires the user's explicit confirmation.",
      schema: z.object({ itemId: z.string() }),
    },
  );

  const bulk_recategorize = tool(
    async ({ merchantKey, category, isBusiness }, config) => {
      const userId = requireUserId(config);
      const s = scoped(d.db, userId);
      const txns = await s.select("transaction", "merchant_key = $k AND removed = false", {
        k: merchantKey,
      });
      const { recordCategorization } = await import("@taxxy/db");
      for (const t of txns) {
        await recordCategorization(s, {
          transaction: t.id,
          label: category,
          is_business: isBusiness,
          confidence: 1,
          source: "user",
          status: "accepted",
          rationale: "bulk recategorize",
        });
      }
      return json({ merchantKey, updated: txns.length });
    },
    {
      name: "bulk_recategorize",
      description:
        "Relabel every past transaction for a merchant at once. Requires the user's explicit confirmation.",
      schema: z.object({ merchantKey: z.string(), category: z.string(), isBusiness: z.boolean() }),
    },
  );

  return [
    compute_quarterly_estimate,
    accept_estimate,
    get_estimate,
    record_payment,
    submit_payment,
    delete_bank_account,
    bulk_recategorize,
  ];
}
