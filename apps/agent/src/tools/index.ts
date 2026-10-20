import {
  type CategorizationRow,
  currentCategorization,
  setMerchantRule as dbSetMerchantRule,
  setPayer as dbSetPayer,
  listBankAccounts,
  listBankItems,
  recordCategorization,
  reviewQueue,
  scoped,
} from "@taxxy/db";
import { MODEL_LABELS } from "@taxxy/integrations";
import { z } from "zod";
import type { AppDeps } from "../deps.js";
import { appendMemory } from "../memory.js";
import { recordOutcome } from "../scores.js";
import { syncAll, syncItem } from "../services/plaid.js";
import { requireUserId } from "./context.js";
import { estimateTools } from "./estimate.js";
import { gmailTools } from "./gmail.js";
import { gtool as tool } from "./guard.js";
import { profileTools } from "./profile.js";

const json = (v: unknown) => JSON.stringify(v);

/** Tool contracts from docs/SPEC.md § Tool contracts (the M3 subset). No tool accepts a userId argument. */
export function buildTools(d: AppDeps) {
  const plaid_sync_transactions = tool(
    async ({ itemId }, config) => {
      const userId = requireUserId(config);
      const results = itemId ? [await syncItem(d, userId, itemId)] : await syncAll(d, userId);
      return json(results);
    },
    {
      name: "plaid_sync_transactions",
      description:
        "Pull new, changed and removed bank transactions for the user's linked accounts and categorize them. Returns counts per item.",
      schema: z.object({
        itemId: z.string().optional().describe("bank_item id; omit to sync every linked item"),
      }),
    },
  );

  const list_review_queue = tool(
    async ({ limit }, config) => {
      const userId = requireUserId(config);
      const items = await reviewQueue(scoped(d.db, userId), limit);
      return json(
        items.map((i) => ({
          transactionId: i.transaction.id,
          date: i.transaction.date,
          amount: i.transaction.amount,
          description: i.transaction.description,
          counterparties: i.transaction.counterparties,
          bestGuess: {
            label: i.categorization.label,
            isBusiness: i.categorization.is_business,
            confidence: i.categorization.confidence,
            rationale: i.categorization.rationale,
          },
          needsReceipt: i.categorization.needs_receipt,
        })),
      );
    },
    {
      name: "list_review_queue",
      description:
        "Transactions the categorizer was unsure about (confidence below the threshold), newest first, with the best guess preselected. Present at most 10 at a time.",
      schema: z.object({ limit: z.number().int().min(1).max(50).default(10) }),
    },
  );

  const record_categorization = tool(
    async ({ transactionId, category, isBusiness, note }, config) => {
      const userId = requireUserId(config);
      const s = scoped(d.db, userId);
      const previous = await currentCategorization(s, transactionId);
      const row: CategorizationRow = await recordCategorization(s, {
        transaction: transactionId,
        label: category,
        is_business: isBusiness,
        confidence: 1,
        source: "user",
        status: "accepted",
        rationale: note ?? "user decision",
      });
      if (previous && previous.source !== "user" && previous.label !== category) {
        recordOutcome(d.env, "review_label_overridden", {
          threadId: (config as { configurable?: { thread_id?: string } }).configurable?.thread_id,
          metadata: {
            from: previous.label,
            to: category,
            previous_status: previous.status,
            previous_confidence: previous.confidence,
          },
        });
      }
      return json({
        id: row.id,
        transaction: row.transaction,
        label: row.label,
        isBusiness: row.is_business,
        status: row.status,
      });
    },
    {
      name: "record_categorization",
      description:
        "Record the user's decision for one transaction. Only call this after the user confirmed the category in chat.",
      schema: z.object({
        transactionId: z.string(),
        category: z.enum(MODEL_LABELS),
        isBusiness: z.boolean(),
        note: z.string().max(200).optional(),
      }),
    },
  );

  const set_merchant_rule = tool(
    async ({ merchantKey, category, isBusiness, condition }, config) => {
      const userId = requireUserId(config);
      const row = await dbSetMerchantRule(scoped(d.db, userId), {
        merchant_key: merchantKey,
        label: category,
        is_business: isBusiness,
        condition,
      });
      return json({
        id: row.id,
        merchantKey: row.merchant_key,
        label: row.label,
        isBusiness: row.is_business,
        condition: row.condition,
      });
    },
    {
      name: "set_merchant_rule",
      description:
        'Save a standing rule when the user says "always" or "never" about a merchant (e.g. Adobe is always business). Applies to future transactions deterministically.',
      schema: z.object({
        merchantKey: z.string().describe("merchant_key from a transaction"),
        category: z.enum(MODEL_LABELS),
        isBusiness: z.boolean(),
        condition: z
          .string()
          .max(120)
          .optional()
          .describe(
            "free-text condition; a conditional rule is advisory for the categorizer, not deterministic",
          ),
      }),
    },
  );

  const set_payer = tool(
    async ({ counterparty, isIncome }, config) => {
      const userId = requireUserId(config);
      const row = await dbSetPayer(scoped(d.db, userId), counterparty, isIncome, "user");
      if (d.store)
        await appendMemory(
          d.store,
          userId,
          "Payers",
          `${counterparty} → ${isIncome ? "1099 income" : "not income"} (confirmed ${new Date().toISOString().slice(0, 10)})`,
        );
      return json({
        id: row.id,
        counterparty: row.counterparty,
        isIncome: row.is_income,
        confirmedAt: row.confirmed_at,
      });
    },
    {
      name: "set_payer",
      description:
        "Confirm whether a counterparty that pays the user is 1099 business income. Deposits matching it become income_1099 automatically.",
      schema: z.object({ counterparty: z.string(), isIncome: z.boolean() }),
    },
  );

  const list_bank_items = tool(
    async (_input, config) => {
      const userId = requireUserId(config);
      const s = scoped(d.db, userId);
      const [items, accounts] = await Promise.all([listBankItems(s), listBankAccounts(s)]);
      return json(
        items.map((i) => ({
          itemId: i.id,
          institution: i.institution,
          status: i.status,
          needsRelink: i.status === "login_required",
          accounts: accounts
            .filter((a) => a.bank_item === i.id)
            .map((a) => ({
              accountId: a.id,
              name: a.name,
              mask: a.mask,
              type: a.type,
              mostlyBusiness: a.mostly_business,
            })),
        })),
      );
    },
    {
      name: "list_bank_items",
      description:
        "Linked bank connections with their accounts (name, last-4 mask, mostlyBusiness). Use accountId with set_mostly_business. needsRelink=true means the user must link that bank again.",
      schema: z.object({}),
    },
  );

  const get_categorization = tool(
    async ({ transactionId }, config) => {
      const userId = requireUserId(config);
      return json(await currentCategorization(scoped(d.db, userId), transactionId));
    },
    {
      name: "get_categorization",
      description: "Current label for one transaction.",
      schema: z.object({ transactionId: z.string() }),
    },
  );

  return [
    plaid_sync_transactions,
    list_review_queue,
    record_categorization,
    set_merchant_rule,
    set_payer,
    list_bank_items,
    get_categorization,
    ...profileTools(d),
    ...estimateTools(d),
    ...gmailTools(d),
  ];
}

export type TaxxyTools = ReturnType<typeof buildTools>;
