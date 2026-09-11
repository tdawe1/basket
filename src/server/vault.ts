// Node-only vault bridge (Proton Pass CLI). Must stay safe to import on
// Cloudflare Workers/Vercel: no top-level node: imports; the child_process
// module is loaded lazily and any failure degrades to "not available".

export type VaultItemSummary = {
  id: string;
  title: string;
  itemType: string;
  state: string;
};

export type VaultItemDetail = VaultItemSummary & {
  note: string;
  fields: Record<string, unknown>;
};

function readEnv(key: string, bindings?: Record<string, unknown>): string | undefined {
  const fromBindings = bindings?.[key];
  if (typeof fromBindings === "string" && fromBindings) return fromBindings;
  const g = globalThis as unknown as { process?: { env?: Record<string, unknown> } };
  const value = g.process?.env?.[key];
  return typeof value === "string" && value ? value : undefined;
}

export function vaultConfig(bindings?: Record<string, unknown>): {
  configured: boolean;
  vault: string;
  token?: string;
  bin?: string;
} {
  const token = readEnv("PROTON_PASS_PERSONAL_ACCESS_TOKEN", bindings);
  const vault = readEnv("PROTON_PASS_VAULT", bindings) ?? "Shared";
  const bin = readEnv("PASS_CLI_BIN", bindings) ?? "pass-cli";
  if (!token) return { configured: false, vault };
  return { configured: true, vault, token, bin };
}

async function runCli(bin: string, args: string[], token: string, timeoutMs = 15000): Promise<string> {
  // Promise executor is required here: execFile is callback-based and the
  // project lib is ES2022 (no Promise.withResolvers).
  return new Promise<string>((resolve, reject) => {
    (async () => {
      let execFile: (
        file: string,
        args: string[],
        opts: Record<string, unknown>,
        cb: (error: unknown, stdout: unknown, stderr: unknown) => void,
      ) => void;
      try {
        ({ execFile } = await import("node:child_process"));
      } catch {
        reject(new Error("Shared passwords are not available."));
        return;
      }
      execFile(
        bin,
        args,
        {
          timeout: timeoutMs,
          maxBuffer: 4 * 1024 * 1024,
          env: { ...(globalThis as { process?: { env?: Record<string, string> } }).process?.env, PROTON_PASS_PERSONAL_ACCESS_TOKEN: token },
        },
        (error, stdout, stderr) => {
          if (error) {
            const detail = String(stderr ?? "").trim().slice(0, 300);
            reject(new Error(detail || String((error as Error)?.message ?? error).slice(0, 300)));
            return;
          }
          resolve(String(stdout ?? ""));
        },
      );
    })().catch((error: unknown) => reject(error instanceof Error ? error : new Error("Could not read vault.")));
  });
}

type ListJson = {
  items?: Array<{ id?: unknown; title?: unknown; item_type?: unknown; state?: unknown }>;
};

type ViewJson = {
  item?: {
    id?: unknown;
    state?: unknown;
    content?: {
      title?: unknown;
      note?: unknown;
      content?: Record<string, unknown>;
    };
  };
};

const cache = new Map<string, { at: number; value: VaultItemSummary[] }>();
const CACHE_MS = 60_000;
// Sealed-field envelopes must fit the vault_items.fields column intact.
// Oversized entries are rejected, never truncated: a sliced envelope can
// never authenticate, so truncation would silently brick the item.
const MAX_SEALED = 30000;

function asSummary(row: NonNullable<ListJson["items"]>[number]): VaultItemSummary | null {
  if (typeof row.id !== "string" || !row.id) return null;
  return {
    id: row.id,
    title: typeof row.title === "string" ? row.title : "Untitled",
    itemType: typeof row.item_type === "string" ? row.item_type : "unknown",
    state: typeof row.state === "string" ? row.state : "Active",
  };
}

export async function listVaultItems(
  bindings?: Record<string, unknown>,
  opts?: { refresh?: boolean },
): Promise<{ vault: string; items: VaultItemSummary[] }> {
  const cfg = vaultConfig(bindings);
  if (!cfg.configured || !cfg.token || !cfg.bin) throw new Error("Vault is not configured.");
  const key = cfg.vault;
  if (!opts?.refresh) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return { vault: key, items: hit.value };
  }
  const out = await runCli(cfg.bin, ["item", "list", "--vault-name", cfg.vault, "--output", "json"], cfg.token);
  let parsed: ListJson;
  try {
    parsed = JSON.parse(out) as ListJson;
  } catch {
    throw new Error("Could not read vault.");
  }
  const items = (parsed.items ?? []).map(asSummary).filter((v: VaultItemSummary | null): v is VaultItemSummary => v !== null);
  cache.set(key, { at: Date.now(), value: items });
  return { vault: key, items };
}

export async function viewVaultItem(
  id: string,
  bindings?: Record<string, unknown>,
): Promise<VaultItemDetail> {
  const cfg = vaultConfig(bindings);
  if (!cfg.configured || !cfg.token || !cfg.bin) throw new Error("Vault is not configured.");
  if (!isVaultItemId(id)) throw new Error("Unknown password entry.");
  const out = await runCli(
    cfg.bin,
    ["item", "view", "--vault-name", cfg.vault, "--item-id", id, "--output", "json"],
    cfg.token,
  );
  let parsed: ViewJson;
  try {
    parsed = JSON.parse(out) as ViewJson;
  } catch {
    throw new Error("Could not read vault.");
  }
  const item = parsed.item;
  const inner = item?.content;
  if (!item || typeof item.id !== "string" || !inner) throw new Error("Unknown password entry.");
  const typed = inner.content && typeof inner.content === "object" ? inner.content : {};
  const typeName = Object.keys(typed)[0] ?? "unknown";
  return {
    id: item.id,
    title: typeof inner.title === "string" && inner.title ? inner.title : "Untitled",
    itemType: typeName.toLowerCase(),
    state: typeof item.state === "string" ? item.state : "Active",
    note: typeof inner.note === "string" ? inner.note : "",
    fields: typed,
  };
}

export function clearVaultCacheForTests(): void {
  cache.clear();
}

// Proton Pass item ids are base64url-ish (letters, digits, -, _, =).
const ITEM_ID = /^[A-Za-z0-9\-_=]{1,512}$/;

export function isVaultItemId(id: unknown): id is string {
  return typeof id === "string" && ITEM_ID.test(id);
}

export type VaultCacheEntry = {
  id: string;
  title: string;
  itemType: string;
  state: string;
  note: string;
  fields: Record<string, unknown>;
};

// Normalizes one raw item from `item list --show-secrets` / `item view`
// (both nest the typed payload at content.content). Only Active items are
// kept: trashed/deleted entries must stop being served once Proton drops them.
type ExportedItem = {
  id?: unknown;
  state?: unknown;
  content?: {
    title?: unknown;
    note?: unknown;
    content?: unknown;
  };
};

export function normalizeExportedItem(raw: unknown): VaultCacheEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as ExportedItem;
  if (!isVaultItemId(item.id)) return null;
  if (typeof item.state === "string" && item.state !== "Active") return null;
  const inner = item.content;
  const typed = inner?.content && typeof inner.content === "object"
    ? (inner.content as Record<string, unknown>)
    : {};
  const typeName = Object.keys(typed)[0] ?? "unknown";
  return {
    id: item.id,
    title: typeof inner?.title === "string" && inner.title ? inner.title : "Untitled",
    itemType: typeName.toLowerCase(),
    state: typeof item.state === "string" ? item.state : "Active",
    note: typeof inner?.note === "string" ? inner.note : "",
    fields: typed,
  };
}

export function normalizeExportedList(parsed: unknown): VaultCacheEntry[] {
  const items = (parsed as { items?: unknown })?.items;
  if (!Array.isArray(items)) return [];
  const out: VaultCacheEntry[] = [];
  for (const raw of items) {
    const entry = normalizeExportedItem(raw);
    if (entry) out.push(entry);
  }
  return out;
}

type VaultRow = {
  id: string;
  title: string;
  item_type: string;
  state: string;
  note: string;
  fields: string;
  synced_at: number;
};

function webSubtle(): SubtleCrypto {
  const subtle = (globalThis as { crypto?: Crypto }).crypto?.subtle;
  if (!subtle) throw new Error("Vault is not configured.");
  return subtle;
}

function b64encode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function cacheCryptoKey(secret: string): Promise<CryptoKey> {
  const subtle = webSubtle();
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

// Seals the credential payload. Titles/notes stay plaintext (needed for
// listing); the secret-bearing fields envelope binds vault+id as AAD.
export async function sealFields(
  secret: string,
  vault: string,
  id: string,
  fields: Record<string, unknown>,
): Promise<string> {
  const subtle = webSubtle();
  const key = await cacheCryptoKey(secret);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const aad = new TextEncoder().encode(`${vault}:${id}`);
  const ct = await subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad },
    key,
    new TextEncoder().encode(JSON.stringify(fields)),
  );
  return JSON.stringify({ v: 1, iv: b64encode(iv), ct: b64encode(new Uint8Array(ct)) });
}

export async function openFields(
  secret: string,
  vault: string,
  id: string,
  sealed: string,
): Promise<Record<string, unknown>> {
  let envelope: unknown;
  try {
    envelope = JSON.parse(sealed);
  } catch {
    throw new Error("Could not read vault.");
  }
  if (
    !envelope || typeof envelope !== "object" ||
    (envelope as { v?: unknown }).v !== 1 ||
    typeof (envelope as { iv?: unknown }).iv !== "string" ||
    typeof (envelope as { ct?: unknown }).ct !== "string"
  ) {
    throw new Error("Could not read vault.");
  }
  const { iv, ct } = envelope as { iv: string; ct: string };
  const subtle = webSubtle();
  const key = await cacheCryptoKey(secret);
  try {
    const pt = await subtle.decrypt(
      { name: "AES-GCM", iv: b64decode(iv) as BufferSource, additionalData: new TextEncoder().encode(`${vault}:${id}`) },
      key,
      b64decode(ct) as BufferSource,
    );
    const value: unknown = JSON.parse(new TextDecoder().decode(pt));
    if (!value || typeof value !== "object") throw new Error("bad payload");
    return value as Record<string, unknown>;
  } catch {
    throw new Error("Could not read vault.");
  }
}


export async function vaultCacheMeta(
  sql: { get<T>(q: string, ...p: Array<string | number | null>): Promise<T | undefined> },
  vault: string,
): Promise<{ count: number; syncedAt: number | null }> {
  const row = await sql.get<{ count: number; synced_at: number | null }>(
    "SELECT COUNT(*) AS count, MAX(synced_at) AS synced_at FROM vault_items WHERE vault = ?",
    vault,
  );
  return { count: row?.count ?? 0, syncedAt: row?.synced_at ?? null };
}

export async function listCachedItems(
  sql: {
    all<T>(q: string, ...p: Array<string | number | null>): Promise<T[]>;
  },
  vault: string,
): Promise<VaultItemSummary[]> {
  const rows = await sql.all<VaultRow>(
    "SELECT id, title, item_type, state, note, fields, synced_at FROM vault_items WHERE vault = ? AND state = 'Active' ORDER BY title COLLATE NOCASE",
    vault,
  );
  return rows.map((row) => ({ id: row.id, title: row.title, itemType: row.item_type, state: row.state }));
}

export async function getCachedItem(
  sql: { get<T>(q: string, ...p: Array<string | number | null>): Promise<T | undefined> },
  vault: string,
  id: string,
  secret?: string,
): Promise<VaultItemDetail | undefined> {
  if (!isVaultItemId(id)) return undefined;
  if (!secret) throw new Error("Vault is not configured.");
  const row = await sql.get<VaultRow>(
    "SELECT id, title, item_type, state, note, fields, synced_at FROM vault_items WHERE vault = ? AND id = ? AND state = 'Active'",
    vault,
    id,
  );
  if (!row) return undefined;
  return {
    id: row.id,
    title: row.title,
    itemType: row.item_type,
    state: row.state,
    note: row.note,
    fields: await openFields(secret, vault, row.id, row.fields),
  };
}

export async function replaceVaultCache(
  sql: {
    run(q: string, ...p: Array<string | number | null>): Promise<void>;
    transaction<T>(fn: () => Promise<T>): Promise<T>;
  },
  vault: string,
  entries: VaultCacheEntry[],
  secret?: string,
): Promise<number> {
  if (!secret) throw new Error("Vault is not configured.");
  const now = Date.now();
  const clean = entries.filter((e) => isVaultItemId(e.id)).slice(0, 5000);
  const sealed: Array<{ entry: VaultCacheEntry; fields: string }> = [];
  for (const e of clean) {
    const fields = await sealFields(secret, vault, e.id, e.fields);
    if (fields.length > MAX_SEALED) continue;
    sealed.push({ entry: e, fields });
  }
  await sql.transaction(async () => {
    await sql.run("DELETE FROM vault_items WHERE vault = ?", vault);
    for (const { entry: e, fields } of sealed) {
      await sql.run(
        "INSERT INTO vault_items (vault, id, title, item_type, state, note, fields, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        vault,
        e.id,
        e.title.slice(0, 200),
        e.itemType.slice(0, 40),
        e.state.slice(0, 20),
        e.note.slice(0, 2000),
        fields,
        now,
      );
    }
  });
  return sealed.length;
}
