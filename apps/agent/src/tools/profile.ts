import {
  getTaxProfile,
  scoped,
  setMostlyBusiness,
  type TaxProfilePatch,
  upsertTaxProfile,
} from "@taxxy/db";
import { z } from "zod";
import type { AppDeps } from "../deps.js";
import { appendMemory } from "../memory.js";
import { missingProfileFields } from "../services/estimate.js";
import { requireUserId } from "./context.js";
import { gtool as tool } from "./guard.js";

const json = (v: unknown) => JSON.stringify(v);

const patchSchema = z.object({
  state: z.string().length(2).optional().describe("two-letter US state"),
  business_description: z.string().max(300).optional(),
  naics: z.string().max(10).optional(),
  w2_wages: z.number().min(0).optional().describe("expected annual W-2 wages"),
  w2_withholding_expected: z
    .number()
    .min(0)
    .optional()
    .describe("expected annual federal withholding"),
  prior_year: z
    .object({ total_tax: z.number().min(0), agi: z.number().min(0), confirmed: z.boolean() })
    .optional()
    .describe(
      "Form 1040 line 24 and line 11 from last year; confirmed only after the user confirms both",
    ),
  se_health_premiums: z.number().min(0).optional(),
  sep_contribution: z.number().min(0).optional(),
  home_office: z.boolean().optional(),
  complete: z.boolean().optional(),
});

export function profileTools(d: AppDeps) {
  const get_tax_profile = tool(
    async (_i, config) => {
      const userId = requireUserId(config);
      const p = await getTaxProfile(scoped(d.db, userId));
      return json({ profile: p, missing: missingProfileFields(p) });
    },
    {
      name: "get_tax_profile",
      description: "The user's tax profile and which intake fields are still missing.",
      schema: z.object({}),
    },
  );

  const upsert_tax_profile = tool(
    async (patch, config) => {
      const userId = requireUserId(config);
      const clean = Object.fromEntries(
        Object.entries(patch).filter(([, v]) => v !== undefined),
      ) as TaxProfilePatch;
      const p = await upsertTaxProfile(scoped(d.db, userId), clean, "user");
      if (d.store) {
        if (clean.business_description)
          await appendMemory(
            d.store,
            userId,
            "Stable facts",
            `Business: ${clean.business_description}`,
          );
        if (clean.state)
          await appendMemory(d.store, userId, "Stable facts", `State: ${clean.state}`);
        if (clean.prior_year?.confirmed)
          await appendMemory(
            d.store,
            userId,
            "Safe harbor",
            `Prior year confirmed on ${new Date().toISOString().slice(0, 10)}: total tax and AGI on file`,
          );
      }
      return json({ profile: p, missing: missingProfileFields(p) });
    },
    {
      name: "upsert_tax_profile",
      description:
        "Save intake answers. Send only the fields the user just gave you. Set complete=true when every intake question is answered.",
      schema: patchSchema,
    },
  );

  const set_mostly_business = tool(
    async ({ accountId, mostlyBusiness }, config) => {
      const userId = requireUserId(config);
      const a = await setMostlyBusiness(scoped(d.db, userId), accountId, mostlyBusiness);
      return json({ id: a.id, name: a.name, mask: a.mask, mostlyBusiness: a.mostly_business });
    },
    {
      name: "set_mostly_business",
      description:
        "Mark a linked account as mostly business (shifts the categorizer's prior; never decides per account).",
      schema: z.object({ accountId: z.string(), mostlyBusiness: z.boolean() }),
    },
  );

  return [get_tax_profile, upsert_tax_profile, set_mostly_business];
}
