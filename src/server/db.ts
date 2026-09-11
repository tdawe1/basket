import type { Household, Item, List, Note, PublicUser, Reminder, Section, Suggestion } from "../shared/types.ts";
import { formatInvite, SESSION_MS } from "./auth.ts";
import type { Sql } from "./sql.ts";

export type UserRow = {
  id: string;
  household_id: string;
  username: string;
  password_hash: string;
  display_name: string;
  color: string;
  created_at: number;
  last_seen: number;
};

const ONLINE_MS = 20_000;

const ITEM_SELECT = `
  SELECT
    i.id, i.list_id, i.name, i.quantity, i.category, i.notes, i.checked, i.section_id,
    i.created_at, i.updated_at,
    a.id AS added_id, a.display_name AS added_name, a.username AS added_username, a.color AS added_color,
    c.id AS checked_id, c.display_name AS checked_name, c.username AS checked_username, c.color AS checked_color
  FROM items i
  JOIN users a ON a.id = i.added_by
  LEFT JOIN users c ON c.id = i.checked_by
`;

type ItemJoin = {
  id: string;
  list_id: string;
  name: string;
  quantity: string;
  category: string;
  notes: string;
  checked: number;
  section_id: string;
  created_at: number;
  updated_at: number;
  added_id: string;
  added_name: string;
  added_username: string;
  added_color: string;
  checked_id: string | null;
  checked_name: string | null;
  checked_username: string | null;
  checked_color: string | null;
};

export function toPublicUser(row: {
  id: string;
  display_name: string;
  username: string;
  color: string;
}): PublicUser {
  return {
    id: row.id,
    displayName: row.display_name,
    username: row.username,
    color: row.color,
  };
}

export function mapItem(row: ItemJoin): Item {
  return {
    id: row.id,
    listId: row.list_id,
    name: row.name,
    quantity: row.quantity,
    category: row.category,
    notes: row.notes,
    checked: Number(row.checked) === 1,
    sectionId: row.section_id || null,
    addedBy: {
      id: row.added_id,
      displayName: row.added_name,
      username: row.added_username,
      color: row.added_color,
    },
    checkedBy: row.checked_id
      ? {
          id: row.checked_id,
          displayName: row.checked_name as string,
          username: row.checked_username as string,
          color: row.checked_color as string,
        }
      : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapList(row: {
  id: string;
  name: string;
  emoji: string;
  sort_order: number;
  created_at: number;
}): List {
  return {
    id: row.id,
    name: row.name,
    emoji: row.emoji,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
  };
}

export async function getUserByUsername(sql: Sql, username: string): Promise<UserRow | undefined> {
  return sql.get<UserRow>("SELECT * FROM users WHERE username = ? COLLATE NOCASE", username);
}

export async function getUserById(sql: Sql, id: string): Promise<UserRow | undefined> {
  return sql.get<UserRow>("SELECT * FROM users WHERE id = ?", id);
}

export async function getSessionUser(sql: Sql, sessionId: string): Promise<UserRow | undefined> {
  const row = await sql.get<UserRow & { session_id: string; expires_at: number }>(
    `SELECT s.id AS session_id, s.expires_at,
            u.id, u.household_id, u.username, u.password_hash, u.display_name, u.color, u.created_at, u.last_seen
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = ?`,
    sessionId,
  );
  if (!row) return undefined;
  if (row.expires_at < Date.now()) {
    await sql.run("DELETE FROM sessions WHERE id = ?", sessionId);
    return undefined;
  }
  return row;
}

export async function createSession(sql: Sql, userId: string, sessionId: string): Promise<void> {
  const now = Date.now();
  await sql.run(
    "INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
    sessionId,
    userId,
    now + SESSION_MS,
    now,
  );
}

export async function listMembers(sql: Sql, householdId: string) {
  const rows = await sql.all<{
    id: string;
    display_name: string;
    username: string;
    color: string;
    last_seen: number;
  }>(
    "SELECT id, display_name, username, color, last_seen FROM users WHERE household_id = ? ORDER BY created_at",
    householdId,
  );
  const now = Date.now();
  return rows.map((row) => ({
    ...toPublicUser(row),
    online: Number(row.last_seen) > now - ONLINE_MS,
  }));
}

export async function getHousehold(sql: Sql, householdId: string): Promise<Household | undefined> {
  const row = await sql.get<{ id: string; name: string; invite_code: string }>(
    "SELECT id, name, invite_code FROM households WHERE id = ?",
    householdId,
  );
  if (!row) return undefined;
  return {
    id: row.id,
    name: row.name,
    inviteCode: formatInvite(row.invite_code),
    members: await listMembers(sql, householdId),
  };
}

export async function getHouseholdByInvite(sql: Sql, code: string): Promise<{ id: string } | undefined> {
  const normalised = code.replace(/[-\s]/g, "").toUpperCase();
  return sql.get<{ id: string }>(
    "SELECT id FROM households WHERE REPLACE(UPPER(invite_code), '-', '') = ?",
    normalised,
  );
}

export async function listLists(sql: Sql, householdId: string): Promise<List[]> {
  const rows = await sql.all<{
    id: string;
    name: string;
    emoji: string;
    sort_order: number;
    created_at: number;
  }>(
    "SELECT id, name, emoji, sort_order, created_at FROM lists WHERE household_id = ? ORDER BY sort_order, created_at",
    householdId,
  );
  return rows.map(mapList);
}

export async function getListForHousehold(
  sql: Sql,
  listId: string,
  householdId: string,
): Promise<List | undefined> {
  const row = await sql.get<{
    id: string;
    name: string;
    emoji: string;
    sort_order: number;
    created_at: number;
  }>("SELECT id, name, emoji, sort_order, created_at FROM lists WHERE id = ? AND household_id = ?", listId, householdId);
  return row ? mapList(row) : undefined;
}

export async function listItems(sql: Sql, householdId: string): Promise<Item[]> {
  const rows = await sql.all<ItemJoin>(
    `${ITEM_SELECT}
     JOIN lists l ON l.id = i.list_id
     WHERE l.household_id = ?
     ORDER BY i.created_at DESC`,
    householdId,
  );
  return rows.map(mapItem);
}

export async function getItemForHousehold(
  sql: Sql,
  itemId: string,
  householdId: string,
): Promise<Item | undefined> {
  const row = await sql.get<ItemJoin>(
    `${ITEM_SELECT}
     JOIN lists l ON l.id = i.list_id
     WHERE i.id = ? AND l.household_id = ?`,
    itemId,
    householdId,
  );
  return row ? mapItem(row) : undefined;
}

export async function suggestions(sql: Sql, householdId: string, q: string): Promise<Suggestion[]> {
  const query = q.trim().toLowerCase();
  return sql.all<Suggestion>(
    `SELECT i.name, i.category, i.quantity, COUNT(*) AS count
     FROM items i
     JOIN lists l ON l.id = i.list_id
     WHERE l.household_id = ?
       AND (? = '' OR INSTR(LOWER(i.name), ?) > 0)
     GROUP BY LOWER(i.name)
     ORDER BY count DESC, MAX(i.created_at) DESC
     LIMIT 12`,
    householdId,
    query,
    query,
  );
}

export async function nextListSort(sql: Sql, householdId: string): Promise<number> {
  const row = await sql.get<{ n: number }>(
    "SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM lists WHERE household_id = ?",
    householdId,
  );
  return row?.n ?? 0;
}
export function mapSection(row: {
  id: string;
  list_id: string;
  name: string;
  sort_order: number;
  created_at: number;
}): Section {
  return {
    id: row.id,
    listId: row.list_id,
    name: row.name,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
  };
}

export async function listSections(sql: Sql, householdId: string): Promise<Section[]> {
  const rows = await sql.all<{
    id: string;
    list_id: string;
    name: string;
    sort_order: number;
    created_at: number;
  }>(
    `SELECT s.id, s.list_id, s.name, s.sort_order, s.created_at
     FROM sections s JOIN lists l ON l.id = s.list_id
     WHERE l.household_id = ?
     ORDER BY s.sort_order ASC, s.created_at ASC`,
    householdId,
  );
  return rows.map(mapSection);
}

export async function getSectionForHousehold(
  sql: Sql,
  sectionId: string,
  householdId: string,
): Promise<Section | undefined> {
  const row = await sql.get<{
    id: string;
    list_id: string;
    name: string;
    sort_order: number;
    created_at: number;
  }>(
    `SELECT s.id, s.list_id, s.name, s.sort_order, s.created_at
     FROM sections s JOIN lists l ON l.id = s.list_id
     WHERE s.id = ? AND l.household_id = ?`,
    sectionId,
    householdId,
  );
  return row ? mapSection(row) : undefined;
}

export async function nextSectionSort(sql: Sql, listId: string): Promise<number> {
  const row = await sql.get<{ n: number }>(
    "SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM sections WHERE list_id = ?",
    listId,
  );
  return row?.n ?? 0;
}

export async function memberCount(sql: Sql, householdId: string): Promise<number> {
  const row = await sql.get<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE household_id = ?", householdId);
  return Number(row?.n ?? 0);
}

type ReminderJoin = {
  id: string;
  list_id: string | null;
  item_id: string | null;
  kind: string;
  title: string;
  due_at: number;
  duration_min: number;
  created_at: number;
  uid: string;
  display_name: string;
  username: string;
  color: string;
};

export function mapReminder(row: ReminderJoin): Reminder {
  return {
    id: row.id,
    listId: row.list_id,
    itemId: row.item_id,
    kind: row.kind === "nudge" ? "nudge" : row.kind === "item" ? "item" : "trip",
    title: row.title,
    dueAt: row.due_at,
    durationMin: row.duration_min,
    createdBy: {
      id: row.uid,
      displayName: row.display_name,
      username: row.username,
      color: row.color,
    },
    createdAt: row.created_at,
  };
}

export async function pruneReminders(sql: Sql, householdId: string, now = Date.now()): Promise<void> {
  await sql.run(
    "DELETE FROM reminders WHERE household_id = ? AND kind = 'nudge' AND created_at < ?",
    householdId,
    now - 24 * 60 * 60 * 1000,
  );
  await sql.run(
    "DELETE FROM reminders WHERE household_id = ? AND kind = 'trip' AND due_at < ?",
    householdId,
    now - 7 * 24 * 60 * 60 * 1000,
  );
  await sql.run(
    "DELETE FROM reminders WHERE household_id = ? AND kind = 'item' AND due_at < ?",
    householdId,
    now - 7 * 24 * 60 * 60 * 1000,
  );
}

function isMissingRemindersTable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /no such table/i.test(msg) && /reminders/i.test(msg);
}

export async function listReminders(sql: Sql, householdId: string, now = Date.now()): Promise<Reminder[]> {
  try {
    await pruneReminders(sql, householdId, now);
  } catch (err) {
    if (isMissingRemindersTable(err)) return [];
    throw err;
  }
  try {
    const rows = await sql.all<ReminderJoin>(
      `SELECT r.id, r.list_id, r.item_id, r.kind, r.title, r.due_at, r.duration_min, r.created_at,
              u.id AS uid, u.display_name, u.username, u.color
       FROM reminders r
       JOIN users u ON u.id = r.created_by
      WHERE r.household_id = ?
        AND (
          (r.kind = 'nudge' AND r.created_at > ?)
          OR (r.kind = 'trip' AND r.due_at > ?)
          OR (r.kind = 'item' AND r.due_at > ?)
        )
      ORDER BY r.due_at ASC
      LIMIT 50`,
      householdId,
      now - 60 * 60 * 1000,
      now - 12 * 60 * 60 * 1000,
      now - 12 * 60 * 60 * 1000,
    );
    return rows.map(mapReminder);
  } catch (err) {
    if (isMissingRemindersTable(err)) return [];
    throw err;
  }
}

export async function getReminderForHousehold(
  sql: Sql,
  reminderId: string,
  householdId: string,
): Promise<Reminder | undefined> {
  const row = await sql.get<ReminderJoin>(
    `SELECT r.id, r.list_id, r.item_id, r.kind, r.title, r.due_at, r.duration_min, r.created_at,
            u.id AS uid, u.display_name, u.username, u.color
     FROM reminders r
     JOIN users u ON u.id = r.created_by
     WHERE r.id = ? AND r.household_id = ?`,
    reminderId,
    householdId,
  );
  return row ? mapReminder(row) : undefined;
}

type NoteJoin = {
  id: string;
  title: string;
  body: string;
  file_name: string | null;
  file_mime: string | null;
  file_size: number | null;
  created_at: number;
  updated_at: number;
  uid: string;
  display_name: string;
  username: string;
  color: string;
};

export function mapNote(row: NoteJoin): Note {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    fileName: row.file_name,
    fileMime: row.file_mime,
    fileSize: row.file_size == null ? null : Number(row.file_size),
    createdBy: {
      id: row.uid,
      displayName: row.display_name,
      username: row.username,
      color: row.color,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isMissingNotesTable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /no such table/i.test(msg) && /notes/i.test(msg);
}

const NOTE_SELECT = `
  SELECT n.id, n.title, n.body, n.file_name, n.file_mime, n.file_size, n.created_at, n.updated_at,
         u.id AS uid, u.display_name, u.username, u.color
  FROM notes n
  JOIN users u ON u.id = n.created_by
`;

export async function listNotes(sql: Sql, householdId: string): Promise<Note[]> {
  try {
    const rows = await sql.all<NoteJoin>(
      `${NOTE_SELECT}
       WHERE n.household_id = ?
       ORDER BY n.updated_at DESC
       LIMIT 100`,
      householdId,
    );
    return rows.map(mapNote);
  } catch (err) {
    if (isMissingNotesTable(err)) return [];
    throw err;
  }
}

export async function getNoteForHousehold(
  sql: Sql,
  noteId: string,
  householdId: string,
): Promise<Note | undefined> {
  try {
    const row = await sql.get<NoteJoin>(
      `${NOTE_SELECT}
       WHERE n.id = ? AND n.household_id = ?`,
      noteId,
      householdId,
    );
    return row ? mapNote(row) : undefined;
  } catch (err) {
    if (isMissingNotesTable(err)) return undefined;
    throw err;
  }
}
