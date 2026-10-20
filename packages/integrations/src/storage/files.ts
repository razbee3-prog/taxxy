import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Object storage for attachments. v1 = local disk under FILES_DIR; Spaces/S3 can implement the same shape. */
export interface FileStore {
  put(
    userId: string,
    bytes: Uint8Array,
    mime: string,
    filename: string,
  ): Promise<{ fileRef: string; sha256: string }>;
  get(fileRef: string): Promise<{ bytes: Uint8Array; mime: string; filename: string }>;
}

export function localFileStore(root: string): FileStore {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80);
  return {
    async put(userId, bytes, mime, filename) {
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const dir = join(root, safe(userId));
      await mkdir(dir, { recursive: true });
      const name = `${sha256.slice(0, 16)}-${safe(filename)}`;
      await writeFile(join(dir, name), bytes);
      await writeFile(join(dir, `${name}.meta.json`), JSON.stringify({ mime, filename, sha256 }));
      return { fileRef: `local:${safe(userId)}/${name}`, sha256 };
    },
    async get(fileRef) {
      const rel = fileRef.replace(/^local:/, "");
      if (rel.includes("..")) throw new Error("bad fileRef");
      const bytes = await readFile(join(root, rel));
      const meta = JSON.parse(await readFile(join(root, `${rel}.meta.json`), "utf8")) as {
        mime: string;
        filename: string;
      };
      return { bytes, ...meta };
    },
  };
}

export function memoryFileStore(): FileStore {
  const files = new Map<string, { bytes: Uint8Array; mime: string; filename: string }>();
  return {
    async put(userId, bytes, mime, filename) {
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const fileRef = `mem:${userId}/${sha256.slice(0, 16)}-${filename}`;
      files.set(fileRef, { bytes, mime, filename });
      return { fileRef, sha256 };
    },
    async get(fileRef) {
      const f = files.get(fileRef);
      if (!f) throw new Error(`no file ${fileRef}`);
      return f;
    },
  };
}
