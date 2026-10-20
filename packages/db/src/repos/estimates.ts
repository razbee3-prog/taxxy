import { recordAudit } from "../audit.js";
import type { Row, ScopedDb } from "../tenancy.js";

export interface EstimateRow extends Row {
  tax_year: number;
  quarter: number;
  input_snapshot: Record<string, unknown>;
  result: Record<string, unknown>;
  engine_version: string;
  constants_version: string;
  status: "draft" | "accepted" | "edited";
  edits: Record<string, unknown> | null;
}

export async function insertEstimate(
  s: ScopedDb,
  e: Omit<EstimateRow, keyof Row | "status" | "edits">,
): Promise<EstimateRow> {
  const row = await s.create<EstimateRow>("estimate", { ...e, status: "draft" });
  await recordAudit(s, {
    actor: "agent",
    action: "estimate.create",
    target: row.id,
    after: { engine_version: e.engine_version },
  });
  return row;
}

export async function acceptEstimate(
  s: ScopedDb,
  estimateId: string,
  edits?: Record<string, unknown>,
): Promise<EstimateRow> {
  const before = await s.get<EstimateRow>(estimateId);
  const row = await s.update<EstimateRow>(estimateId, {
    status: edits && Object.keys(edits).length ? "edited" : "accepted",
    edits: edits ?? null,
  });
  await recordAudit(s, {
    actor: "user",
    action: "estimate.accept",
    target: row.id,
    before: { status: before?.status },
    after: { status: row.status, edits },
  });
  return row;
}

export async function listEstimates(s: ScopedDb, taxYear?: number): Promise<EstimateRow[]> {
  return taxYear
    ? s.select<EstimateRow>("estimate", "tax_year = $y", { y: taxYear }, "ORDER BY created_at DESC")
    : s.select<EstimateRow>("estimate", "true", {}, "ORDER BY created_at DESC");
}
