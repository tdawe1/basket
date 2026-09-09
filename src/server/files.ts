import type { Sql } from "./sql.ts";

export const MAX_NOTE_FILE_BYTES = 8 * 1024 * 1024;

export type StoredFile = {
  bytes: Uint8Array;
  mime: string;
};

export type FileStore = {
  put(id: string, file: StoredFile): Promise<void>;
  get(id: string): Promise<StoredFile | undefined>;
  delete(id: string): Promise<void>;
};

const PDF = [0x25, 0x50, 0x44, 0x46]; // %PDF
const PNG = [0x89, 0x50, 0x4e, 0x47];
const JPEG = [0xff, 0xd8, 0xff];

function startsWith(bytes: Uint8Array, sig: number[]): boolean {
  if (bytes.length < sig.length) return false;
  return sig.every((b, i) => bytes[i] === b);
}

export function sniffNoteFile(bytes: Uint8Array, declared = "", filename = ""): string | null {
  const name = filename.toLowerCase();
  const kind = declared.toLowerCase();
  if (startsWith(bytes, PDF) || kind.includes("pdf") || name.endsWith(".pdf")) {
    return startsWith(bytes, PDF) ? "application/pdf" : null;
  }
  if (startsWith(bytes, PNG) || kind.includes("png") || name.endsWith(".png")) {
    return startsWith(bytes, PNG) ? "image/png" : null;
  }
  if (startsWith(bytes, JPEG) || kind.includes("jpeg") || kind.includes("jpg") || name.endsWith(".jpg") || name.endsWith(".jpeg")) {
    return startsWith(bytes, JPEG) ? "image/jpeg" : null;
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function b64ToBytes(data: string): Uint8Array {
  const bin = atob(data);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function memoryFiles(): FileStore {
  const map = new Map<string, StoredFile>();
  return {
    async put(id, file) {
      map.set(id, { mime: file.mime, bytes: file.bytes.slice() });
    },
    async get(id) {
      const found = map.get(id);
      return found ? { mime: found.mime, bytes: found.bytes.slice() } : undefined;
    },
    async delete(id) {
      map.delete(id);
    },
  };
}

export function sqlFiles(sql: Sql): FileStore {
  return {
    async put(id, file) {
      const data = bytesToB64(file.bytes);
      await sql.run("DELETE FROM note_blobs WHERE id = ?", id);
      await sql.run("INSERT INTO note_blobs (id, mime, data) VALUES (?, ?, ?)", id, file.mime, data);
    },
    async get(id) {
      const row = await sql.get<{ mime: string; data: string }>(
        "SELECT mime, data FROM note_blobs WHERE id = ?",
        id,
      );
      if (!row) return undefined;
      return { mime: row.mime, bytes: b64ToBytes(row.data) };
    },
    async delete(id) {
      await sql.run("DELETE FROM note_blobs WHERE id = ?", id);
    },
  };
}

export function safeDownloadName(name: string, mime: string): string {
  const trimmed = name.replace(/[/\\?%*:|"<>]/g, "").trim() || "attachment";
  if (trimmed.includes(".")) return trimmed;
  if (mime === "application/pdf") return `${trimmed}.pdf`;
  if (mime === "image/png") return `${trimmed}.png`;
  if (mime === "image/jpeg") return `${trimmed}.jpg`;
  if (mime === "image/webp") return `${trimmed}.webp`;
  return trimmed;
}
