import type { RecordId, Surreal } from "surrealdb";
import { plain } from "../client.js";
import { userRecord } from "../tenancy.js";

export interface User {
  id: string;
  email: string;
  auth_provider_id?: string | null;
  status: "active" | "disabled" | "deleted";
}

/** The only unscoped table: creating a user is what creates a scope. */
export async function ensureUser(db: Surreal, userId: string, email: string): Promise<User> {
  const id: RecordId = userRecord(userId);
  const [rows] = await db.query<[unknown[]]>("UPSERT $id SET email = $email", { id, email });
  return plain<User[]>(rows)[0] as User;
}

export async function findUserByEmail(db: Surreal, email: string): Promise<User | null> {
  const [rows] = await db.query<[unknown[]]>("SELECT * FROM user WHERE email = $email LIMIT 1", {
    email,
  });
  return plain<User[]>(rows ?? [])[0] ?? null;
}
