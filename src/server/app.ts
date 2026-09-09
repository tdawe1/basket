import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Context } from "hono";
import { CATEGORY_IDS, USER_COLORS, guessCategory } from "../shared/categories.ts";
import {
  COOKIE,
  SESSION_MS,
  hashPassword,
  newId,
  newInviteCode,
  validateDisplayName,
  validatePassword,
  validateUsername,
  verifyPassword,
} from "./auth.ts";
import {
  createSession,
  getHousehold,
  getHouseholdByInvite,
  getItemForHousehold,
  getListForHousehold,
  getNoteForHousehold,
  getReminderForHousehold,
  getSessionUser,
  getUserByUsername,
  listItems,
  listLists,
  listNotes,
  listReminders,
  mapList,
  memberCount,
  nextListSort,
  suggestions,
  type UserRow,
} from "./db.ts";
import { MAX_NOTE_FILE_BYTES, safeDownloadName, sniffNoteFile, sqlFiles, type FileStore } from "./files.ts";
import type { Sql } from "./sql.ts";

export type AppBindings = {
  DB?: unknown;
  DATABASE_URL?: string;
  DATABASE_AUTH_TOKEN?: string;
  COOKIE_SECURE?: string;
};

type Env = {
  Bindings: AppBindings;
  Variables: { sql: Sql; files: FileStore };
};

function clip(value: unknown, max: number): string {
  return String(value ?? "").trim().slice(0, max);
}

function cookieSecure(c: Context<Env>): boolean {
  if (c.env?.COOKIE_SECURE === "true" || c.env?.COOKIE_SECURE === "1") return true;
  return new URL(c.req.url).protocol === "https:";
}

function setSession(c: Context<Env>, sessionId: string) {
  setCookie(c, COOKIE, sessionId, {
    httpOnly: true,
    path: "/",
    sameSite: "Lax",
    secure: cookieSecure(c),
    maxAge: SESSION_MS / 1000,
  });
}

async function currentUser(c: Context<Env>): Promise<UserRow | null> {
  const sid = getCookie(c, COOKIE);
  if (!sid) return null;
  return (await getSessionUser(c.get("sql"), sid)) ?? null;
}

async function requireUser(c: Context<Env>): Promise<UserRow | Response> {
  const user = await currentUser(c);
  if (!user) return c.json({ error: "Please sign in." }, 401);
  return user;
}

function isUser(value: UserRow | Response): value is UserRow {
  return !(value instanceof Response);
}

export function createApp(
  getSql: (c: Context<Env>) => Sql | Promise<Sql>,
  getFiles?: (c: Context<Env>) => FileStore | Promise<FileStore>,
) {
  const app = new Hono<Env>();

  app.get("/api/health", (c) => c.json({ ok: true }));

  app.use("/api/*", async (c, next) => {
    const sql = await getSql(c);
    c.set("sql", sql);
    c.set("files", getFiles ? await getFiles(c) : sqlFiles(sql));
    await next();
  });

  app.post("/api/auth/register", async (c) => {
    const sql = c.get("sql");
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const householdName = clip(body.householdName, 60);
    const displayName = clip(body.displayName, 40);
    const username = clip(body.username, 32);
    const password = String(body.password ?? "");

    if (!householdName) return c.json({ error: "Give your household a name." }, 400);
    const nameErr = validateDisplayName(displayName);
    if (nameErr) return c.json({ error: nameErr }, 400);
    const userErr = validateUsername(username);
    if (userErr) return c.json({ error: userErr }, 400);
    const passErr = validatePassword(password);
    if (passErr) return c.json({ error: passErr }, 400);
    if (await getUserByUsername(sql, username)) {
      return c.json({ error: "That username is taken." }, 409);
    }

    const now = Date.now();
    const householdId = newId();
    const userId = newId();
    const listId = newId();
    const invite = newInviteCode();
    const sessionId = newId() + newId();

    await sql.run(
      "INSERT INTO households (id, name, invite_code, created_at) VALUES (?, ?, ?, ?)",
      householdId,
      householdName,
      invite,
      now,
    );
    await sql.run(
      `INSERT INTO users (id, household_id, username, password_hash, display_name, color, created_at, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      userId,
      householdId,
      username,
      await hashPassword(password),
      displayName,
      USER_COLORS[0],
      now,
      now,
    );
    await sql.run(
      "INSERT INTO lists (id, household_id, name, emoji, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      listId,
      householdId,
      "Groceries",
      "🛒",
      0,
      now,
    );
    await createSession(sql, userId, sessionId);
    setSession(c, sessionId);
    return c.json({ ok: true });
  });

  app.post("/api/auth/join", async (c) => {
    const sql = c.get("sql");
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const inviteCode = clip(body.inviteCode, 20);
    const displayName = clip(body.displayName, 40);
    const username = clip(body.username, 32);
    const password = String(body.password ?? "");

    const nameErr = validateDisplayName(displayName);
    if (nameErr) return c.json({ error: nameErr }, 400);
    const userErr = validateUsername(username);
    if (userErr) return c.json({ error: userErr }, 400);
    const passErr = validatePassword(password);
    if (passErr) return c.json({ error: passErr }, 400);

    const household = await getHouseholdByInvite(sql, inviteCode);
    if (!household) return c.json({ error: "That invite code was not found." }, 404);
    if (await getUserByUsername(sql, username)) {
      return c.json({ error: "That username is taken." }, 409);
    }

    const count = await memberCount(sql, household.id);
    const userId = newId();
    const now = Date.now();
    const sessionId = newId() + newId();
    await sql.run(
      `INSERT INTO users (id, household_id, username, password_hash, display_name, color, created_at, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      userId,
      household.id,
      username,
      await hashPassword(password),
      displayName,
      USER_COLORS[count % USER_COLORS.length],
      now,
      now,
    );
    await createSession(sql, userId, sessionId);
    setSession(c, sessionId);
    return c.json({ ok: true });
  });

  app.post("/api/auth/login", async (c) => {
    const sql = c.get("sql");
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const username = clip(body.username, 32);
    const password = String(body.password ?? "");
    const user = await getUserByUsername(sql, username);
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      return c.json({ error: "Wrong username or password." }, 401);
    }
    const sessionId = newId() + newId();
    await createSession(sql, user.id, sessionId);
    setSession(c, sessionId);
    return c.json({ ok: true });
  });

  app.post("/api/auth/logout", async (c) => {
    const sql = c.get("sql");
    const sid = getCookie(c, COOKIE);
    if (sid) await sql.run("DELETE FROM sessions WHERE id = ?", sid);
    deleteCookie(c, COOKIE, { path: "/", secure: cookieSecure(c) });
    return c.json({ ok: true });
  });

  app.get("/api/bootstrap", async (c) => {
    const user = await requireUser(c);
    if (!isUser(user)) return user;
    const sql = c.get("sql");
    await sql.run("UPDATE users SET last_seen = ? WHERE id = ?", Date.now(), user.id);
    const household = await getHousehold(sql, user.household_id);
    if (!household) return c.json({ error: "Household not found." }, 404);
    return c.json({
      user: {
        id: user.id,
        displayName: user.display_name,
        username: user.username,
        color: user.color,
      },
      household,
      lists: await listLists(sql, user.household_id),
      items: await listItems(sql, user.household_id),
      reminders: await listReminders(sql, user.household_id),
      notes: await listNotes(sql, user.household_id),
    });
  });

  app.patch("/api/household", async (c) => {
    const user = await requireUser(c);
    if (!isUser(user)) return user;
    const sql = c.get("sql");
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const name = clip(body.name, 60);
    if (!name) return c.json({ error: "Household name is required." }, 400);
    await sql.run("UPDATE households SET name = ? WHERE id = ?", name, user.household_id);
    return c.json(await getHousehold(sql, user.household_id));
  });

  app.post("/api/household/invite/rotate", async (c) => {
    const user = await requireUser(c);
    if (!isUser(user)) return user;
    const sql = c.get("sql");
    const invite = newInviteCode();
    await sql.run("UPDATE households SET invite_code = ? WHERE id = ?", invite, user.household_id);
    const household = await getHousehold(sql, user.household_id);
    return c.json({ inviteCode: household?.inviteCode });
  });

  app.post("/api/lists", async (c) => {
    const user = await requireUser(c);
    if (!isUser(user)) return user;
    const sql = c.get("sql");
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const name = clip(body.name, 40);
    const emoji = clip(body.emoji, 8) || "🛒";
    if (!name) return c.json({ error: "List name is required." }, 400);
    const now = Date.now();
    const id = newId();
    const sort = await nextListSort(sql, user.household_id);
    await sql.run(
      "INSERT INTO lists (id, household_id, name, emoji, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      id,
      user.household_id,
      name,
      emoji,
      sort,
      now,
    );
    return c.json(mapList({ id, name, emoji, sort_order: sort, created_at: now }));
  });

  app.patch("/api/lists/:id", async (c) => {
    const user = await requireUser(c);
    if (!isUser(user)) return user;
    const sql = c.get("sql");
    const id = c.req.param("id");
    const existing = await getListForHousehold(sql, id, user.household_id);
    if (!existing) return c.json({ error: "List not found." }, 404);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const name = body.name !== undefined ? clip(body.name, 40) : existing.name;
    const emoji = body.emoji !== undefined ? clip(body.emoji, 8) || "🛒" : existing.emoji;
    if (!name) return c.json({ error: "List name is required." }, 400);
    await sql.run("UPDATE lists SET name = ?, emoji = ? WHERE id = ?", name, emoji, id);
    return c.json({ ...existing, name, emoji });
  });

  app.delete("/api/lists/:id", async (c) => {
    const user = await requireUser(c);
    if (!isUser(user)) return user;
    const sql = c.get("sql");
    const id = c.req.param("id");
    const existing = await getListForHousehold(sql, id, user.household_id);
    if (!existing) return c.json({ error: "List not found." }, 404);
    await sql.run("DELETE FROM items WHERE list_id = ?", id);
    await sql.run("DELETE FROM lists WHERE id = ?", id);
    return c.body(null, 204);
  });

  app.get("/api/suggestions", async (c) => {
    const user = await requireUser(c);
    if (!isUser(user)) return user;
    const q = clip(c.req.query("q"), 80);
    return c.json(await suggestions(c.get("sql"), user.household_id, q));
  });

  app.post("/api/lists/:id/items", async (c) => {
    const user = await requireUser(c);
    if (!isUser(user)) return user;
    const sql = c.get("sql");
    const listId = c.req.param("id");
    if (!(await getListForHousehold(sql, listId, user.household_id))) {
      return c.json({ error: "List not found." }, 404);
    }
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const name = clip(body.name, 120);
    if (!name) return c.json({ error: "Item name is required." }, 400);
    const quantity = clip(body.quantity, 40);
    const notes = clip(body.notes, 240);
    let category = clip(body.category, 32);
    if (!CATEGORY_IDS.has(category)) category = guessCategory(name);
    const now = Date.now();
    const id = newId();
    await sql.run(
      `INSERT INTO items (id, list_id, name, quantity, category, notes, checked, added_by, checked_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, NULL, ?, ?)`,
      id,
      listId,
      name,
      quantity,
      category,
      notes,
      user.id,
      now,
      now,
    );
    return c.json(await getItemForHousehold(sql, id, user.household_id));
  });

  app.patch("/api/items/:id", async (c) => {
    const user = await requireUser(c);
    if (!isUser(user)) return user;
    const sql = c.get("sql");
    const id = c.req.param("id");
    const existing = await getItemForHousehold(sql, id, user.household_id);
    if (!existing) return c.json({ error: "Item not found." }, 404);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

    const name = body.name !== undefined ? clip(body.name, 120) : existing.name;
    if (!name) return c.json({ error: "Item name is required." }, 400);
    const quantity = body.quantity !== undefined ? clip(body.quantity, 40) : existing.quantity;
    const notes = body.notes !== undefined ? clip(body.notes, 240) : existing.notes;
    let category = body.category !== undefined ? clip(body.category, 32) : existing.category;
    if (!CATEGORY_IDS.has(category)) category = existing.category;

    let checked = existing.checked ? 1 : 0;
    let checkedBy: string | null = existing.checkedBy?.id ?? null;
    if (typeof body.checked === "boolean") {
      checked = body.checked ? 1 : 0;
      checkedBy = body.checked ? user.id : null;
    }

    const now = Date.now();
    await sql.run(
      `UPDATE items SET name = ?, quantity = ?, category = ?, notes = ?, checked = ?, checked_by = ?, updated_at = ?
       WHERE id = ?`,
      name,
      quantity,
      category,
      notes,
      checked,
      checkedBy,
      now,
      id,
    );
    return c.json(await getItemForHousehold(sql, id, user.household_id));
  });

  app.delete("/api/items/:id", async (c) => {
    const user = await requireUser(c);
    if (!isUser(user)) return user;
    const sql = c.get("sql");
    const id = c.req.param("id");
    const existing = await getItemForHousehold(sql, id, user.household_id);
    if (!existing) return c.json({ error: "Item not found." }, 404);
    await sql.run("DELETE FROM items WHERE id = ?", id);
    return c.body(null, 204);
  });

  app.post("/api/reminders", async (c) => {
    const user = await requireUser(c);
    if (!isUser(user)) return user;
    const sql = c.get("sql");
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const kind = body.kind === "nudge" ? "nudge" : body.kind === "trip" ? "trip" : "";
    if (!kind) return c.json({ error: "Reminder type is required." }, 400);

    const listIdRaw = clip(body.listId, 40);
    const listId = listIdRaw || null;
    let listName = "";
    let listEmoji = "";
    if (listId) {
      const list = await getListForHousehold(sql, listId, user.household_id);
      if (!list) return c.json({ error: "List not found." }, 404);
      listName = list.name;
      listEmoji = list.emoji;
    }

    const now = Date.now();
    let dueAt = Number(body.dueAt);
    let durationMin = Number(body.durationMin);
    if (kind === "nudge") {
      dueAt = now;
      durationMin = 0;
    } else {
      if (!Number.isFinite(dueAt)) return c.json({ error: "Pick a time in the future." }, 400);
      if (dueAt < now - 60_000) return c.json({ error: "Pick a time in the future." }, 400);
      if (dueAt > now + 366 * 24 * 60 * 60 * 1000) {
        return c.json({ error: "Pick a time in the future." }, 400);
      }
      if (!Number.isFinite(durationMin)) durationMin = 60;
      durationMin = Math.min(240, Math.max(15, Math.round(durationMin)));
    }

    const fallback =
      kind === "nudge"
        ? listName
          ? `Nudge: ${listName}`
          : "Nudge"
        : listName
          ? `Shop: ${listEmoji} ${listName}`
          : "Shopping trip";
    const title = clip(body.title, 120) || fallback;

    const id = newId();
    await sql.run(
      `INSERT INTO reminders (id, household_id, list_id, kind, title, due_at, duration_min, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      user.household_id,
      listId,
      kind,
      title,
      dueAt,
      durationMin,
      user.id,
      now,
    );
    return c.json(await getReminderForHousehold(sql, id, user.household_id));
  });

  app.delete("/api/reminders/:id", async (c) => {
    const user = await requireUser(c);
    if (!isUser(user)) return user;
    const sql = c.get("sql");
    const id = c.req.param("id");
    const existing = await getReminderForHousehold(sql, id, user.household_id);
    if (!existing) return c.json({ error: "Reminder not found." }, 404);
    await sql.run("DELETE FROM reminders WHERE id = ?", id);
    return c.body(null, 204);
  });

  app.post("/api/notes", async (c) => {
    const user = await requireUser(c);
    if (!isUser(user)) return user;
    const sql = c.get("sql");
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const title = clip(body.title, 120) || "Untitled";
    const text = clip(body.body, 8000);
    const now = Date.now();
    const id = newId();
    await sql.run(
      `INSERT INTO notes (id, household_id, title, body, file_name, file_mime, file_size, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?)`,
      id,
      user.household_id,
      title,
      text,
      user.id,
      now,
      now,
    );
    return c.json(await getNoteForHousehold(sql, id, user.household_id));
  });

  app.patch("/api/notes/:id", async (c) => {
    const user = await requireUser(c);
    if (!isUser(user)) return user;
    const sql = c.get("sql");
    const id = c.req.param("id");
    const existing = await getNoteForHousehold(sql, id, user.household_id);
    if (!existing) return c.json({ error: "Note not found." }, 404);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const title = body.title !== undefined ? clip(body.title, 120) || "Untitled" : existing.title;
    const text = body.body !== undefined ? clip(body.body, 8000) : existing.body;
    await sql.run(
      "UPDATE notes SET title = ?, body = ?, updated_at = ? WHERE id = ?",
      title,
      text,
      Date.now(),
      id,
    );
    return c.json(await getNoteForHousehold(sql, id, user.household_id));
  });

  app.delete("/api/notes/:id", async (c) => {
    const user = await requireUser(c);
    if (!isUser(user)) return user;
    const sql = c.get("sql");
    const files = c.get("files");
    const id = c.req.param("id");
    const existing = await getNoteForHousehold(sql, id, user.household_id);
    if (!existing) return c.json({ error: "Note not found." }, 404);
    await files.delete(id);
    await sql.run("DELETE FROM notes WHERE id = ?", id);
    return c.body(null, 204);
  });

  app.put("/api/notes/:id/file", async (c) => {
    const user = await requireUser(c);
    if (!isUser(user)) return user;
    const sql = c.get("sql");
    const files = c.get("files");
    const id = c.req.param("id");
    const existing = await getNoteForHousehold(sql, id, user.household_id);
    if (!existing) return c.json({ error: "Note not found." }, 404);

    const contentType = c.req.header("content-type") || "";
    let bytes: Uint8Array;
    let filename = clip(c.req.header("x-file-name"), 120) || "attachment";
    let declared = contentType;
    if (contentType.includes("multipart/form-data")) {
      const parsed = await c.req.parseBody();
      const uploaded = parsed.file;
      if (!(uploaded instanceof File)) return c.json({ error: "Attach a PDF or image." }, 400);
      bytes = new Uint8Array(await uploaded.arrayBuffer());
      filename = clip(uploaded.name, 120) || filename;
      declared = uploaded.type || declared;
    } else {
      bytes = new Uint8Array(await c.req.arrayBuffer());
    }
    if (!bytes.byteLength) return c.json({ error: "Attach a PDF or image." }, 400);
    if (bytes.byteLength > MAX_NOTE_FILE_BYTES) return c.json({ error: "File is too large (max 8 MB)." }, 413);
    const mime = sniffNoteFile(bytes, declared, filename);
    if (!mime) return c.json({ error: "That file type is not allowed." }, 400);

    await files.put(id, { bytes, mime });
    const storedName = safeDownloadName(filename, mime);
    await sql.run(
      "UPDATE notes SET file_name = ?, file_mime = ?, file_size = ?, updated_at = ? WHERE id = ?",
      storedName,
      mime,
      bytes.byteLength,
      Date.now(),
      id,
    );
    return c.json(await getNoteForHousehold(sql, id, user.household_id));
  });

  app.get("/api/notes/:id/file", async (c) => {
    const user = await requireUser(c);
    if (!isUser(user)) return user;
    const sql = c.get("sql");
    const files = c.get("files");
    const id = c.req.param("id");
    const existing = await getNoteForHousehold(sql, id, user.household_id);
    if (!existing || !existing.fileMime) return c.json({ error: "Note not found." }, 404);
    const stored = await files.get(id);
    if (!stored) return c.json({ error: "Note not found." }, 404);
    const name = safeDownloadName(existing.fileName || "attachment", stored.mime);
    const inline = c.req.query("download") !== "1";
    const payload = Uint8Array.from(stored.bytes);
    return new Response(payload, {
      headers: {
        "content-type": stored.mime,
        "content-length": String(payload.byteLength),
        "content-disposition": `${inline ? "inline" : "attachment"}; filename="${name.replace(/"/g, "")}"`,
        "cache-control": "private, max-age=60",
      },
    });
  });

  app.delete("/api/notes/:id/file", async (c) => {
    const user = await requireUser(c);
    if (!isUser(user)) return user;
    const sql = c.get("sql");
    const files = c.get("files");
    const id = c.req.param("id");
    const existing = await getNoteForHousehold(sql, id, user.household_id);
    if (!existing) return c.json({ error: "Note not found." }, 404);
    await files.delete(id);
    await sql.run(
      "UPDATE notes SET file_name = NULL, file_mime = NULL, file_size = NULL, updated_at = ? WHERE id = ?",
      Date.now(),
      id,
    );
    return c.json(await getNoteForHousehold(sql, id, user.household_id));
  });

  app.post("/api/lists/:id/clear-checked", async (c) => {
    const user = await requireUser(c);
    if (!isUser(user)) return user;
    const sql = c.get("sql");
    const id = c.req.param("id");
    if (!(await getListForHousehold(sql, id, user.household_id))) {
      return c.json({ error: "List not found." }, 404);
    }
    const rows = await sql.all<{ id: string }>("SELECT id FROM items WHERE list_id = ? AND checked = 1", id);
    await sql.run("DELETE FROM items WHERE list_id = ? AND checked = 1", id);
    return c.json({ removed: rows.length });
  });

  return app;
}
