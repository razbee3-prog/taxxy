import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { createCredential, ensureUser, findCredentialByEmail } from "@taxxy/db";
import type { Surreal } from "surrealdb";

/** Swappable auth boundary: the rest of the web app only needs a userId from a verified session. */
export interface AuthProvider {
  signUp(email: string, password: string): Promise<{ userId: string; email: string }>;
  signIn(email: string, password: string): Promise<{ userId: string; email: string } | null>;
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  return `scrypt$${salt}$${scryptSync(password, salt, 64).toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [, salt, hash] = stored.split("$");
  if (!salt || !hash) return false;
  const a = Buffer.from(hash, "hex");
  const b = scryptSync(password, salt, 64);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class LocalAuthProvider implements AuthProvider {
  constructor(private readonly db: Surreal) {}
  async signUp(email: string, password: string) {
    if (password.length < 10) throw new Error("password must be at least 10 characters");
    const userId = `u_${randomBytes(10).toString("hex")}`;
    await ensureUser(this.db, userId, email.toLowerCase());
    await createCredential(this.db, userId, email, hashPassword(password));
    return { userId, email: email.toLowerCase() };
  }
  async signIn(email: string, password: string) {
    const c = await findCredentialByEmail(this.db, email);
    if (!c || !verifyPassword(password, c.password_hash)) return null;
    return { userId: String(c.user).replace(/^user:/, ""), email: c.email };
  }
}

/** Stateless signed session: `base64url(payload).hmac`, 30-day expiry. */
export interface Session {
  userId: string;
  email: string;
  exp: number;
}

export function signSession(
  secret: string,
  s: Omit<Session, "exp">,
  ttlMs = 30 * 86_400_000,
): string {
  const payload = Buffer.from(JSON.stringify({ ...s, exp: Date.now() + ttlMs })).toString(
    "base64url",
  );
  return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
}

export function verifySession(secret: string, token: string | undefined): Session | null {
  if (!token) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const s = JSON.parse(Buffer.from(payload, "base64url").toString()) as Session;
    return s.exp > Date.now() ? s : null;
  } catch {
    return null;
  }
}
