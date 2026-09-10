import { mkdirSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FileStore } from "./files.ts";

// Server-generated ids are hex; anything else is rejected so a future caller
// can never turn `id` into a path escape (defense in depth — today's callers
// only pass ids gated by a household lookup).
const ID_RE = /^[0-9a-f]+$/i;

export function diskFiles(dir: string): FileStore {
  mkdirSync(dir, { recursive: true });
  return {
    maxBytes: 8 * 1024 * 1024,
    async put(id, file) {
      if (!ID_RE.test(id)) throw new Error("Invalid file id.");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `${id}.bin`), file.bytes);
      await writeFile(join(dir, `${id}.mime`), file.mime, "utf8");
    },
    async get(id) {
      if (!ID_RE.test(id)) return undefined;
      try {
        const bytes = new Uint8Array(await readFile(join(dir, `${id}.bin`)));
        const mime = ((await readFile(join(dir, `${id}.mime`), "utf8")) as string).trim() || "application/octet-stream";
        return { bytes, mime };
      } catch {
        return undefined;
      }
    },
    async delete(id) {
      if (!ID_RE.test(id)) return;
      await rm(join(dir, `${id}.bin`), { force: true });
      await rm(join(dir, `${id}.mime`), { force: true });
    },
  };
}
