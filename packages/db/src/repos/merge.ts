import { recordAudit } from "../audit.js";
import type { Row, ScopedDb } from "../tenancy.js";

export interface MergeUserRow extends Row {
  registered_user_id: string;
}

export async function getMergeUser(s: ScopedDb): Promise<MergeUserRow | null> {
  return (await s.select<MergeUserRow>("merge_user", "true", {}, "LIMIT 1"))[0] ?? null;
}

export async function setMergeUser(s: ScopedDb, registeredUserId: string): Promise<MergeUserRow> {
  const existing = await getMergeUser(s);
  if (existing?.registered_user_id === registeredUserId) return existing;
  const row = existing
    ? await s.update<MergeUserRow>(existing.id, { registered_user_id: registeredUserId })
    : await s.create<MergeUserRow>("merge_user", { registered_user_id: registeredUserId });
  await recordAudit(s, {
    actor: "system",
    action: "merge.register",
    target: row.id,
    after: { registered_user_id: registeredUserId },
  });
  return row;
}
