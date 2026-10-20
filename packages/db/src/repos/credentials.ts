import type { Surreal } from "surrealdb";
import { plain } from "../client.js";
import { userRecord } from "../tenancy.js";

export interface Credential {
  id: string;
  user: string;
  email: string;
  password_hash: string;
}

export async function createCredential(
  db: Surreal,
  userId: string,
  email: string,
  passwordHash: string,
): Promise<Credential> {
  const [rows] = await db.query<[unknown[]]>(
    "CREATE credential SET user = $user, email = $email, password_hash = $hash",
    {
      user: userRecord(userId),
      email: email.toLowerCase(),
      hash: passwordHash,
    },
  );
  return plain<Credential[]>(rows)[0] as Credential;
}

export async function findCredentialByEmail(
  db: Surreal,
  email: string,
): Promise<Credential | null> {
  const [rows] = await db.query<[unknown[]]>(
    "SELECT * FROM credential WHERE email = $email LIMIT 1",
    { email: email.toLowerCase() },
  );
  return plain<Credential[]>(rows)[0] ?? null;
}
