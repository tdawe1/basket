import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FileStore } from "./files.ts";

export function diskFiles(dir: string): FileStore {
  mkdirSync(dir, { recursive: true });
  return {
    maxBytes: 8 * 1024 * 1024,
    async put(id, file) {
      writeFileSync(join(dir, `${id}.bin`), file.bytes);
      writeFileSync(join(dir, `${id}.mime`), file.mime, "utf8");
    },
    async get(id) {
      try {
        const bytes = new Uint8Array(readFileSync(join(dir, `${id}.bin`)));
        const mime = readFileSync(join(dir, `${id}.mime`), "utf8").trim() || "application/octet-stream";
        return { bytes, mime };
      } catch {
        return undefined;
      }
    },
    async delete(id) {
      try {
        unlinkSync(join(dir, `${id}.bin`));
      } catch {
        /* missing */
      }
      try {
        unlinkSync(join(dir, `${id}.mime`));
      } catch {
        /* missing */
      }
    },
  };
}
