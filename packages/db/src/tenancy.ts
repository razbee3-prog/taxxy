import { RecordId, type Surreal } from "surrealdb";
import { plain } from "./client.js";

export class TenancyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenancyError";
  }
}

export function userRecord(userId: string): RecordId {
  if (!userId || /[^A-Za-z0-9_-]/.test(userId)) throw new TenancyError(`invalid userId: ${userId}`);
  return new RecordId("user", userId);
}

export function toRecordId(id: string | RecordId): RecordId {
  if (typeof id !== "string") return id;
  const i = id.indexOf(":");
  if (i < 1) throw new TenancyError(`not a record id: ${id}`);
  return new RecordId(id.slice(0, i), id.slice(i + 1).replace(/^⟨|⟩$/g, ""));
}

/** Schemafull `option<...>` fields accept NONE, not NULL: top-level nulls become NONE. */
function nullsToNone(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v === null ? undefined : v]));
}

const TABLE = /^[a-z_]+$/;
function table(name: string): string {
  if (!TABLE.test(name)) throw new TenancyError(`bad table name: ${name}`);
  return name;
}

export interface Row {
  id: string;
  user: string;
  created_at: string;
  updated_at: string;
}

/**
 * Every app-table access goes through here so `user = $user` is always part of the query.
 * Cross-user reads return nothing; cross-user writes throw TenancyError.
 */
export class ScopedDb {
  readonly user: RecordId;

  constructor(
    readonly db: Surreal,
    readonly userId: string,
  ) {
    this.user = userRecord(userId);
  }

  async select<T extends Row>(
    tbl: string,
    where = "true",
    bindings: Record<string, unknown> = {},
    tail = "",
  ): Promise<T[]> {
    this.assertNoUserBinding(bindings);
    const [rows] = await this.db.query<[unknown[]]>(
      `SELECT * FROM ${table(tbl)} WHERE user = $user AND (${where}) ${tail}`,
      { ...bindings, user: this.user },
    );
    return plain<T[]>(rows ?? []);
  }

  async get<T extends Row>(id: string | RecordId): Promise<T | null> {
    const rid = toRecordId(id);
    const [rows] = await this.db.query<[unknown[]]>("SELECT * FROM ONLY $id WHERE user = $user", {
      id: rid,
      user: this.user,
    });
    return rows ? plain<T>(rows) : null;
  }

  async create<T extends Row>(tbl: string, data: Record<string, unknown>): Promise<T> {
    if ("user" in data) throw new TenancyError("user is set by the scope, not the caller");
    const [rows] = await this.db.query<[unknown[]]>(`CREATE ${table(tbl)} CONTENT $data`, {
      data: { ...nullsToNone(data), user: this.user },
    });
    return plain<T[]>(rows)[0] as T;
  }

  async update<T extends Row>(id: string | RecordId, patch: Record<string, unknown>): Promise<T> {
    if ("user" in patch) throw new TenancyError("user cannot be changed");
    const rid = toRecordId(id);
    const [rows] = await this.db.query<[unknown[]]>("UPDATE $id MERGE $patch WHERE user = $user", {
      id: rid,
      patch: nullsToNone(patch),
      user: this.user,
    });
    const row = plain<T[]>(rows ?? [])[0];
    if (!row) throw new TenancyError(`record ${rid.toString()} is not owned by ${this.userId}`);
    return row;
  }

  /** Create with a caller-chosen id (e.g. Plaid ids) so re-syncs are idempotent. */
  async createWithId<T extends Row>(
    id: string | RecordId,
    data: Record<string, unknown>,
  ): Promise<T> {
    if ("user" in data) throw new TenancyError("user is set by the scope, not the caller");
    const [rows] = await this.db.query<[unknown[]]>("CREATE $id CONTENT $data", {
      id: toRecordId(id),
      data: { ...nullsToNone(data), user: this.user },
    });
    return plain<T[]>(rows)[0] as T;
  }

  /** Raw SurrealQL that must reference `$user`; the binding is injected by the scope. */
  async query<T>(surql: string, bindings: Record<string, unknown> = {}): Promise<T[]> {
    this.assertNoUserBinding(bindings);
    if (!/\$user\b/.test(surql)) throw new TenancyError("scoped query must filter on $user");
    const [rows] = await this.db.query<[unknown[]]>(surql, { ...bindings, user: this.user });
    return plain<T[]>(rows ?? []);
  }

  async delete(id: string | RecordId): Promise<boolean> {
    const rid = toRecordId(id);
    const [rows] = await this.db.query<[unknown[]]>("DELETE $id WHERE user = $user RETURN BEFORE", {
      id: rid,
      user: this.user,
    });
    return (rows ?? []).length > 0;
  }

  private assertNoUserBinding(b: Record<string, unknown>) {
    if ("user" in b) throw new TenancyError("binding name `user` is reserved for the scope");
  }
}

export function scoped(db: Surreal, userId: string): ScopedDb {
  return new ScopedDb(db, userId);
}
