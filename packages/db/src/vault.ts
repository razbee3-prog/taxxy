import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM envelope for Plaid / Gmail tokens. Ciphertext format `v1.<iv>.<tag>.<data>` (base64url).
 * Key: 32 bytes, base64 or hex, from VAULT_KEY. Sealed values are stored; plaintext never leaves
 * the integration layer and is never returned to tools or the model.
 */
export class Vault {
  private readonly key: Buffer;

  constructor(key: string | Buffer) {
    this.key = typeof key === "string" ? parseKey(key) : key;
    if (this.key.length !== 32) throw new Error("VAULT_KEY must be 32 bytes (base64 or hex)");
  }

  static generateKey(): string {
    return randomBytes(32).toString("base64");
  }

  seal(plaintext: string, aad?: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    if (aad) cipher.setAAD(Buffer.from(aad));
    const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return ["v1", b64(iv), b64(cipher.getAuthTag()), b64(data)].join(".");
  }

  open(sealed: string, aad?: string): string {
    const [v, iv, tag, data] = sealed.split(".");
    if (v !== "v1" || !iv || !tag || !data) throw new Error("vault: malformed ciphertext");
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64url"));
    if (aad) decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(data, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  }
}

function parseKey(s: string): Buffer {
  if (/^[0-9a-f]{64}$/i.test(s)) return Buffer.from(s, "hex");
  return Buffer.from(s, "base64");
}

function b64(b: Buffer): string {
  return b.toString("base64url");
}
