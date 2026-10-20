import type { Row, ScopedDb } from "./tenancy.js";

export type Actor = "user" | "agent" | "system";

export interface AuditEvent extends Row {
  actor: Actor;
  action: string;
  target: string;
  before: unknown;
  after: unknown;
}

export interface AuditInput {
  actor: Actor;
  action: string;
  target: string;
  before?: unknown;
  after?: unknown;
}

/** Every profile, rule, categorization and estimate change writes one of these. */
export async function recordAudit(s: ScopedDb, ev: AuditInput): Promise<AuditEvent> {
  return s.create<AuditEvent>("audit_event", {
    actor: ev.actor,
    action: ev.action,
    target: ev.target,
    before: ev.before === undefined ? undefined : ev.before,
    after: ev.after === undefined ? undefined : ev.after,
  });
}

export async function listAudit(s: ScopedDb, target?: string, limit = 50): Promise<AuditEvent[]> {
  return target
    ? s.select<AuditEvent>(
        "audit_event",
        "target = $target",
        { target },
        `ORDER BY created_at DESC LIMIT ${limit}`,
      )
    : s.select<AuditEvent>("audit_event", "true", {}, `ORDER BY created_at DESC LIMIT ${limit}`);
}
