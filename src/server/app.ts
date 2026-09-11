import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Context } from "hono";
import { CATEGORY_IDS, USER_COLORS, guessCategory } from "../shared/categories.ts";
import {
  COOKIE,
  SESSION_MS,
  clearLoginFailures,
  hashPassword,
  hashRecoveryCode,
  loginAllowed,
  mintRecoveryCodes,
  newId,
  newInviteCode,
  recordLoginFailure,
  timingSafeEqual,
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
  getSectionForHousehold,
  getSessionUser,
  getUserByUsername,
  listItems,
  listLists,
  listNotes,
  listReminders,
  listSections,
  mapList,
  mapSection,
  memberCount,
  nextListSort,
  nextSectionSort,
  suggestions,
  type UserRow,
} from "./db.ts";
import { MAX_NOTE_FILE_BYTES, safeDownloadName, sniffNoteFile, sqlFiles, type FileStore } from "./files.ts";
import { genericServerErrorResponse } from "./http-error.ts";
import {
  authorizeUrl,
  codeChallenge,
  consumePendingState,
  createPendingState,
  exchangeCode,
  fetchProfile,
  finishOAuthLogin,
  isProvider,
  linkOAuthAccount,
  listOAuthAccounts,
  oauthCallbackUrl,
  oauthConfigured,
  userHasPassword,
  type OAuthEnv,
  type OAuthMode,
} from "./oauth.ts";
import type { Sql } from "./sql.ts";
import { getCachedItem, listCachedItems, listVaultItems, normalizeExportedItem, replaceVaultCache, vaultCacheMeta, vaultConfig, viewVaultItem, type VaultCacheEntry } from "./vault.ts";

export type AppBindings = {
  DB?: unknown;
  DATABASE_URL?: string;
  DATABASE_AUTH_TOKEN?: string;
  COOKIE_SECURE?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  APPLE_CLIENT_ID?: string;
  APPLE_TEAM_ID?: string;
  APPLE_KEY_ID?: string;
  APPLE_PRIVATE_KEY?: string;
  OAUTH_REDIRECT_BASE?: string;
  PROTON_PASS_PERSONAL_ACCESS_TOKEN?: string;
  PROTON_PASS_VAULT?: string;
  PASS_CLI_BIN?: string;
  VAULT_SYNC_SECRET?: string;
  VAULT_CACHE_KEY?: string;
  VAULT_HOUSEHOLD_ID?: string;
};

type Env = {
  Bindings: AppBindings;
  Variables: { sql: Sql; files: FileStore };
};

function clip(value: unknown, max: number): string {
  return String(value ?? "").trim().slice(0, max);
}

function secretsEqual(a: string, b: string): boolean {
  if (!a || !b) return false;
  const enc = new TextEncoder();
  return timingSafeEqual(enc.encode(a), enc.encode(b));
}

async function resolveItemSection(
  sql: Sql,
  raw: unknown,
  listId: string,
  householdId: string,
): Promise<{ sectionId: string } | { error: string; status: number }> {
  if (typeof raw !== "string" || !raw) return { sectionId: "" };
  const section = await getSectionForHousehold(sql, raw, householdId);
  if (!section) return { error: "Subsection not found.", status: 404 };
  if (section.listId !== listId) return { error: "Subsection does not belong to this list.", status: 400 };
  return { sectionId: section.id };
}

function vaultEnv(bindings: Record<string, unknown>, key: string): string | undefined {
  const fromBindings = bindings[key];
  if (typeof fromBindings === "string" && fromBindings) return fromBindings;
  return nodeEnv(key);
}

// When VAULT_HOUSEHOLD_ID is set, only that household may read the cache.
// Unset keeps single-household behavior (any signed-in user).
function vaultVisible(user: UserRow, bindings: Record<string, unknown>): boolean {
  const householdId = vaultEnv(bindings, "VAULT_HOUSEHOLD_ID");
  if (!householdId) return true;
  return user.household_id === householdId;
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

function nodeEnv(key: string): string | undefined {
  const g: unknown = globalThis;
  if (!g || typeof g !== "object" || !("process" in g)) return undefined;
  const proc: unknown = g.process;
  if (!proc || typeof proc !== "object" || !("env" in proc)) return undefined;
  const env: unknown = proc.env;
  if (!env || typeof env !== "object") return undefined;
  // Index into the runtime env bag; the typeof check below validates the read.
  const table = env as Record<string, unknown>;
  const value: unknown = table[key];
  return typeof value === "string" && value ? value : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function oauthEnv(c: Context<Env>): OAuthEnv {
  const b = c.env ?? {};
  return {
    GOOGLE_CLIENT_ID: str(b.GOOGLE_CLIENT_ID) ?? nodeEnv("GOOGLE_CLIENT_ID"),
    GOOGLE_CLIENT_SECRET: str(b.GOOGLE_CLIENT_SECRET) ?? nodeEnv("GOOGLE_CLIENT_SECRET"),
    APPLE_CLIENT_ID: str(b.APPLE_CLIENT_ID) ?? nodeEnv("APPLE_CLIENT_ID"),
    APPLE_TEAM_ID: str(b.APPLE_TEAM_ID) ?? nodeEnv("APPLE_TEAM_ID"),
    APPLE_KEY_ID: str(b.APPLE_KEY_ID) ?? nodeEnv("APPLE_KEY_ID"),
    APPLE_PRIVATE_KEY: str(b.APPLE_PRIVATE_KEY) ?? nodeEnv("APPLE_PRIVATE_KEY"),
    OAUTH_REDIRECT_BASE: str(b.OAUTH_REDIRECT_BASE) ?? nodeEnv("OAUTH_REDIRECT_BASE"),
  };
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

function fileTooLarge(cap: number): string {
  if (cap >= 1024 * 1024) return `File is too large (max ${Math.round(cap / (1024 * 1024))} MB).`;
  return `File is too large (max ${Math.round(cap / 1024)} KB).`;
}

export function createApp(
  getSql: (c: Context<Env>) => Sql | Promise<Sql>,
  getFiles?: (c: Context<Env>) => FileStore | Promise<FileStore>,
) {
  const app = new Hono<Env>();
  // No stack traces or framework-default HTML ever reach clients (Node/Vercel
  // have no other catch-all; the Worker wraps fetch separately).
  app.onError(() => genericServerErrorResponse());

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
    const passwordHash = await hashPassword(password);
    // Shown once; only hashes are stored.
    const recovery = await mintRecoveryCodes();

    try {
      await sql.transaction(async () => {
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
          passwordHash,
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
        for (const hash of recovery.hashes) {
          await sql.run(
            "INSERT INTO recovery_codes (code_hash, user_id, created_at) VALUES (?, ?, ?)",
            hash,
            userId,
            now,
          );
        }
      });
    } catch {
      await sql.run("DELETE FROM sessions WHERE id = ?", sessionId).catch(() => undefined);
      await sql.run("DELETE FROM recovery_codes WHERE user_id = ?", userId).catch(() => undefined);
      await sql.run("DELETE FROM lists WHERE id = ?", listId).catch(() => undefined);
      await sql.run("DELETE FROM users WHERE id = ?", userId).catch(() => undefined);
      await sql.run("DELETE FROM households WHERE id = ?", householdId).catch(() => undefined);
      return c.json({ error: "Could not create household." }, 500);
    }
    setSession(c, sessionId);
    return c.json({ ok: true, recoveryCodes: recovery.codes });
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
    const recovery = await mintRecoveryCodes();
    // Check-then-insert races under concurrent joins with the same username;
    // the loser hits UNIQUE. Report it as taken instead of a 500.
    try {
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
      for (const hash of recovery.hashes) {
        await sql.run(
          "INSERT INTO recovery_codes (code_hash, user_id, created_at) VALUES (?, ?, ?)",
          hash,
          userId,
          now,
        );
      }
    } catch {
      return c.json({ error: "That username is taken." }, 409);
    }
    await createSession(sql, userId, sessionId);
    setSession(c, sessionId);
    return c.json({ ok: true, recoveryCodes: recovery.codes });
  });

  app.post("/api/auth/login", async (c) => {
    const sql = c.get("sql");
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const username = clip(body.username, 32);
    const password = String(body.password ?? "");
    if (!loginAllowed(username)) {
      return c.json({ error: "Too many sign-in attempts. Try again later." }, 429);
    }
    const user = await getUserByUsername(sql, username);
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      recordLoginFailure(username);
      return c.json({ error: "Wrong username or password." }, 401);
    }
    clearLoginFailures(username);
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

  app.get("/api/auth/oauth/providers", (c) => {
    const env = oauthEnv(c);
    return c.json({ google: oauthConfigured(env, "google"), apple: oauthConfigured(env, "apple") });
  });

  app.post("/api/auth/oauth/start", async (c) => {
    const sql = c.get("sql");
    const env = oauthEnv(c);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const provider = body.provider;
    const mode = body.mode as OAuthMode;
    if (!isProvider(provider) || !oauthConfigured(env, provider)) {
      return c.json({ error: "That login is not set up." }, 400);
    }
    if (mode !== "login" && mode !== "create" && mode !== "join" && mode !== "link") {
      return c.json({ error: "Pick a sign-in option." }, 400);
    }
    let userId: string | undefined;
    if (mode === "link") {
      const user = await requireUser(c);
      if (!isUser(user)) return user;
      userId = user.id;
    }
    const params: Record<string, string> = {};
    if (mode === "create") {
      const householdName = clip(body.householdName, 60);
      const displayName = clip(body.displayName, 40);
      if (!householdName) return c.json({ error: "Give your household a name." }, 400);
      const nameErr = validateDisplayName(displayName);
      if (nameErr) return c.json({ error: nameErr }, 400);
      params.householdName = householdName;
      params.displayName = displayName;
    }
    if (mode === "join") {
      const inviteCode = clip(body.inviteCode, 20);
      const displayName = clip(body.displayName, 40);
      const nameErr = validateDisplayName(displayName);
      if (nameErr) return c.json({ error: nameErr }, 400);
      if (!(await getHouseholdByInvite(sql, inviteCode))) {
        return c.json({ error: "That invite code was not found." }, 404);
      }
      params.inviteCode = inviteCode;
      params.displayName = displayName;
    }
    const redirectUri = oauthCallbackUrl(env, c.req.url);
    const pending = await createPendingState(sql, { provider, mode, userId, params });
    const url = await authorizeUrl(env, provider, {
      state: pending.state,
      challenge: await codeChallenge(pending.verifier),
      redirectUri,
    });
    return c.json({ url });
  });

  app.get("/api/auth/oauth/callback", async (c) => {
    const sql = c.get("sql");
    const env = oauthEnv(c);
    const fail = (code: string) => c.redirect(`/?oauth_error=${encodeURIComponent(code)}`);
    if (c.req.query("error")) return fail("denied");
    const code = c.req.query("code");
    const state = c.req.query("state");
    if (!code || !state) return fail("invalid");
    const pending = await consumePendingState(sql, state);
    if (!pending || !oauthConfigured(env, pending.provider)) return fail("expired");
    const redirectUri = oauthCallbackUrl(env, c.req.url);
    let profile;
    try {
      const tokens = await exchangeCode(env, pending.provider, { code, verifier: pending.verifier, redirectUri });
      profile = await fetchProfile(env, pending.provider, tokens);
    } catch {
      return fail("failed");
    }
    const result = await finishOAuthLogin(sql, pending.provider, profile.sub, profile, {
      mode: pending.mode,
      userId: pending.userId,
      householdName: pending.params.householdName,
      displayName: pending.params.displayName,
      inviteCode: pending.params.inviteCode,
    });
    if ("error" in result) return fail(result.error);
    const sessionId = newId() + newId();
    await createSession(sql, result.userId, sessionId);
    setSession(c, sessionId);
    return c.redirect("/");
  });

  app.get("/api/auth/oauth/links", async (c) => {
    const user = await requireUser(c);
    if (!isUser(user)) return user;
    return c.json(await listOAuthAccounts(c.get("sql"), user.id));
  });

  app.delete("/api/auth/oauth/:provider", async (c) => {
    const user = await requireUser(c);
    if (!isUser(user)) return user;
    const provider = c.req.param("provider");
    if (!isProvider(provider)) return c.json({ error: "Unknown login method." }, 400);
    const sql = c.get("sql");
    const links = await listOAuthAccounts(sql, user.id);
    if (!links.some((l) => l.provider === provider)) return c.json({ error: "That login is not linked." }, 404);
    if (!userHasPassword(user) && links.length < 2) {
      return c.json({ error: "Link another login method first." }, 400);
    }
    await sql.run("DELETE FROM oauth_accounts WHERE provider = ? AND user_id = ?", provider, user.id);
    return c.body(null, 204);
  });

  // Password recovery without email: one-time recovery codes shown once at
  // signup (Settings can regenerate them). Only hashes are stored; redeeming
  // a code sets a new password, burns the whole set, and kills every session.
  app.post("/api/auth/recover", async (c) => {
    const sql = c.get("sql");
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const username = clip(body.username, 32);
    const code = String(body.code ?? "");
    const password = String(body.password ?? "");
    if (!loginAllowed(username)) {
      return c.json({ error: "Too many sign-in attempts. Try again later." }, 429);
    }
    const passErr = validatePassword(password);
    if (passErr) return c.json({ error: passErr }, 400);
    const user = await getUserByUsername(sql, username);
    // One message whether the username or the code was wrong.
    const hash = await hashRecoveryCode(code);
    const row = user
      ? await sql.get<{ user_id: string }>(
          "SELECT user_id FROM recovery_codes WHERE user_id = ? AND code_hash = ?",
          user.id,
          hash,
        )
      : undefined;
    if (!user || !row) {
      recordLoginFailure(username);
      return c.json({ error: "That recovery code is not valid." }, 400);
    }
    const fresh = await mintRecoveryCodes();
    const now = Date.now();
    await sql.transaction(async () => {
      await sql.run("UPDATE users SET password_hash = ? WHERE id = ?", await hashPassword(password), user.id);
      await sql.run("DELETE FROM recovery_codes WHERE user_id = ?", user.id);
      for (const h of fresh.hashes) {
        await sql.run(
          "INSERT INTO recovery_codes (code_hash, user_id, created_at) VALUES (?, ?, ?)",
          h,
          user.id,
          now,
        );
      }
      await sql.run("DELETE FROM sessions WHERE user_id = ?", user.id);
    });
    clearLoginFailures(username);
    return c.json({ ok: true, recoveryCodes: fresh.codes });
  });

  app.post("/api/recovery/codes/regenerate", async (c) => {
    const user = await requireUser(c);
    if (!isUser(user)) return user;
    const sql = c.get("sql");
    const recovery = await mintRecoveryCodes();
    const now = Date.now();
    await sql.transaction(async () => {
      await sql.run("DELETE FROM recovery_codes WHERE user_id = ?", user.id);
      for (const hash of recovery.hashes) {
        await sql.run(
          "INSERT INTO recovery_codes (code_hash, user_id, created_at) VALUES (?, ?, ?)",
          hash,
          user.id,
          now,
        );
      }
    });
    return c.json({ codes: recovery.codes });
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
      sections: await listSections(sql, user.household_id),
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
    await sql.transaction(async () => {
      await sql.run("DELETE FROM items WHERE list_id = ?", id);
      await sql.run("DELETE FROM sections WHERE list_id = ?", id);
      await sql.run("DELETE FROM lists WHERE id = ?", id);
    });
    return c.body(null, 204);
  });

  app.post("/api/lists/:id/sections", async (c) => {
    const user = await requireUser(c);
    if (!isUser(user)) return user;
    const sql = c.get("sql");
    const listId = c.req.param("id");
    if (!(await getListForHousehold(sql, listId, user.household_id))) {
      return c.json({ error: "List not found." }, 404);
    }
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const name = clip(body.name, 40);
    if (!name) return c.json({ error: "Subsection name is required." }, 400);
    const now = Date.now();
    const id = newId();
    const sort = await nextSectionSort(sql, listId);
    await sql.run(
      "INSERT INTO sections (id, list_id, name, sort_order, created_at) VALUES (?, ?, ?, ?, ?)",
      id,
      listId,
      name,
      sort,
      now,
    );
    return c.json(mapSection({ id, list_id: listId, name, sort_order: sort, created_at: now }));
  });

  app.patch("/api/sections/:id", async (c) => {
    const user = await requireUser(c);
    if (!isUser(user)) return user;
    const sql = c.get("sql");
    const id = c.req.param("id");
    const existing = await getSectionForHousehold(sql, id, user.household_id);
    if (!existing) return c.json({ error: "Subsection not found." }, 404);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const name = body.name !== undefined ? clip(body.name, 40) : existing.name;
    if (!name) return c.json({ error: "Subsection name is required." }, 400);
    await sql.run("UPDATE sections SET name = ? WHERE id = ?", name, id);
    return c.json({ ...existing, name });
  });

  app.delete("/api/sections/:id", async (c) => {
    const user = await requireUser(c);
    if (!isUser(user)) return user;
    const sql = c.get("sql");
    const id = c.req.param("id");
    const existing = await getSectionForHousehold(sql, id, user.household_id);
    if (!existing) return c.json({ error: "Subsection not found." }, 404);
    await sql.transaction(async () => {
      await sql.run("UPDATE items SET section_id = '' WHERE section_id = ?", id);
      await sql.run("DELETE FROM sections WHERE id = ?", id);
    });
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
    const resolved = await resolveItemSection(sql, body.sectionId, listId, user.household_id);
    if ("error" in resolved) return c.json({ error: resolved.error }, resolved.status as 400 | 404);
    const now = Date.now();
    const id = newId();
    await sql.run(
      `INSERT INTO items (id, list_id, name, quantity, category, notes, checked, section_id, added_by, checked_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, NULL, ?, ?)`,
      id,
      listId,
      name,
      quantity,
      category,
      notes,
      resolved.sectionId,
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
    const sectionResolved =
      body.sectionId !== undefined
        ? await resolveItemSection(sql, body.sectionId, existing.listId, user.household_id)
        : null;
    if (sectionResolved && "error" in sectionResolved) {
      return c.json({ error: sectionResolved.error }, sectionResolved.status as 400 | 404);
    }
    const sectionId = sectionResolved ? sectionResolved.sectionId : (existing.sectionId ?? "");
    let checked = existing.checked ? 1 : 0;
    let checkedBy: string | null = existing.checkedBy?.id ?? null;
    if (typeof body.checked === "boolean") {
      checked = body.checked ? 1 : 0;
      checkedBy = body.checked ? user.id : null;
    }
    const now = Date.now();
    await sql.run(
      `UPDATE items SET name = ?, quantity = ?, category = ?, notes = ?, checked = ?, checked_by = ?, section_id = ?, updated_at = ?
       WHERE id = ?`,
      name,
      quantity,
      category,
      notes,
      checked,
      checkedBy,
      sectionId,
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
    await sql.transaction(async () => {
      await sql.run("DELETE FROM reminders WHERE item_id = ?", id);
      await sql.run("DELETE FROM items WHERE id = ?", id);
    });
    return c.body(null, 204);
  });

  app.post("/api/reminders", async (c) => {
    const user = await requireUser(c);
    if (!isUser(user)) return user;
    const sql = c.get("sql");
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const kind =
      body.kind === "nudge" ? "nudge" : body.kind === "trip" ? "trip" : body.kind === "item" ? "item" : "";
    if (!kind) return c.json({ error: "Reminder type is required." }, 400);

    const listIdRaw = clip(body.listId, 40);
    let listId = listIdRaw || null;
    let listName = "";
    let listEmoji = "";
    if (listId) {
      const list = await getListForHousehold(sql, listId, user.household_id);
      if (!list) return c.json({ error: "List not found." }, 404);
      listName = list.name;
      listEmoji = list.emoji;
    }

    const itemIdRaw = typeof body.itemId === "string" ? body.itemId : "";
    let itemId: string | null = null;
    let itemName = "";
    if (itemIdRaw) {
      const item = await getItemForHousehold(sql, itemIdRaw, user.household_id);
      if (!item) return c.json({ error: "Item not found." }, 404);
      itemId = item.id;
      itemName = item.name;
      if (!listId) listId = item.listId;
    }
    if (kind === "item" && !itemId) return c.json({ error: "Item is required." }, 400);

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
        return c.json({ error: "Pick a time within the next year." }, 400);
      }
      if (!Number.isFinite(durationMin)) durationMin = 60;
      durationMin = Math.min(240, Math.max(15, Math.round(durationMin)));
    }

    const fallback =
      kind === "nudge"
        ? listName
          ? `Nudge: ${listName}`
          : "Nudge"
        : kind === "item"
          ? `Buy ${itemName}`
          : listName
            ? `Shop: ${listEmoji} ${listName}`
            : "Shopping trip";
    const title = clip(body.title, 120) || fallback;

    const id = newId();
    await sql.run(
      `INSERT INTO reminders (id, household_id, list_id, item_id, kind, title, due_at, duration_min, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      user.household_id,
      listId,
      itemId,
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
    const cap = files.maxBytes ?? MAX_NOTE_FILE_BYTES;
    const declaredLength = Number(c.req.header("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > cap) {
      return c.json({ error: fileTooLarge(cap) }, 413);
    }
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
    if (bytes.byteLength > cap) return c.json({ error: fileTooLarge(cap) }, 413);
    const mime = sniffNoteFile(bytes, declared, filename);
    if (!mime) return c.json({ error: "That file type is not allowed." }, 400);
    try {
      await files.put(id, { bytes, mime });
    } catch {
      return c.json({ error: fileTooLarge(cap) }, 413);
    }
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
        "x-content-type-options": "nosniff",
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
    const rows = await sql.transaction(async () => {
      const found = await sql.all<{ id: string }>("SELECT id FROM items WHERE list_id = ? AND checked = 1", id);
      await sql.run("DELETE FROM items WHERE list_id = ? AND checked = 1", id);
      return found;
    });
    return c.json({ removed: rows.length });
  });
  app.get("/api/vault/status", async (c) => {
    const user = await requireUser(c);
    if (!isUser(user)) return user;
    const bindings = (c.env ?? {}) as Record<string, unknown>;
    if (!vaultVisible(user, bindings)) return c.json({ error: "Shared passwords are not available." }, 403);
    const cfg = vaultConfig(bindings);
    const meta = await vaultCacheMeta(c.get("sql"), cfg.vault).catch(() => ({ count: 0, syncedAt: null }));
    const unlocked = meta.count > 0 && !!vaultEnv(bindings, "VAULT_CACHE_KEY");
    const source = unlocked ? "cache" : cfg.configured ? "live" : "unavailable";
    return c.json({
      configured: cfg.configured || unlocked,
      vault: cfg.vault,
      source,
      syncedAt: meta.syncedAt,
      count: meta.count,
    });
  });

  app.get("/api/vault/items", async (c) => {
    const user = await requireUser(c);
    if (!isUser(user)) return user;
    const bindings = (c.env ?? {}) as Record<string, unknown>;
    if (!vaultVisible(user, bindings)) return c.json({ error: "Shared passwords are not available." }, 403);
    const sql = c.get("sql");
    const cfg = vaultConfig(bindings);
    if (vaultEnv(bindings, "VAULT_CACHE_KEY")) {
      const cached = await listCachedItems(sql, cfg.vault).catch(() => []);
      if (cached.length > 0) return c.json({ vault: cfg.vault, items: cached });
    }
    try {
      return c.json(await listVaultItems(bindings));
    } catch {
      return c.json({ error: "Shared passwords are not available." }, 503);
    }
  });

  app.get("/api/vault/items/:id", async (c) => {
    const user = await requireUser(c);
    if (!isUser(user)) return user;
    const bindings = (c.env ?? {}) as Record<string, unknown>;
    if (!vaultVisible(user, bindings)) return c.json({ error: "Shared passwords are not available." }, 403);
    const sql = c.get("sql");
    const cfg = vaultConfig(bindings);
    const key = vaultEnv(bindings, "VAULT_CACHE_KEY");
    const meta = await vaultCacheMeta(sql, cfg.vault).catch(() => ({ count: 0, syncedAt: null }));
    if (meta.count > 0 && !key) return c.json({ error: "Shared passwords are not available." }, 503);
    if (key) {
      try {
        const cached = await getCachedItem(sql, cfg.vault, c.req.param("id"), key);
        if (cached) return c.json(cached);
      } catch {
        return c.json({ error: "Shared passwords are not available." }, 503);
      }
      if (meta.count > 0) return c.json({ error: "Unknown password entry." }, 404);
    }
    try {
      return c.json(await viewVaultItem(c.req.param("id"), bindings));
    } catch (error) {
      const message = error instanceof Error && error.message === "Unknown password entry."
        ? "Unknown password entry."
        : "Shared passwords are not available.";
      const status = message === "Unknown password entry." ? 404 : 503;
      return c.json({ error: message }, status);
    }
  });
  app.post("/api/vault/sync", async (c) => {
    const bindings = (c.env ?? {}) as Record<string, unknown>;
    const secret = typeof bindings.VAULT_SYNC_SECRET === "string" && bindings.VAULT_SYNC_SECRET
      ? bindings.VAULT_SYNC_SECRET
      : nodeEnv("VAULT_SYNC_SECRET");
    if (!secret) return c.json({ error: "Shared passwords are not available." }, 503);
    const header = c.req.header("x-vault-sync-secret") ?? "";
    if (!secretsEqual(header, secret)) return c.json({ error: "Please sign in." }, 401);
    const cacheKey = vaultEnv(bindings, "VAULT_CACHE_KEY");
    if (!cacheKey) return c.json({ error: "Shared passwords are not available." }, 503);
    // Bound the body before parsing: the cache caps at 5000 items x 20KB.
    const contentLength = Number(c.req.header("content-length") ?? 0);
    if (Number.isFinite(contentLength) && contentLength > 2 * 1024 * 1024) {
      return c.json({ error: "Request is too large." }, 413);
    }
    const cfg = vaultConfig(bindings);
    // The vault bucket is server-pinned: callers cannot write arbitrary buckets.
    const vault = cfg.vault;
    const body = (await c.req.json().catch(() => ({}))) as { items?: unknown };
    if (!Array.isArray(body.items)) return c.json({ error: "Items are required." }, 400);
    const entries: VaultCacheEntry[] = [];
    for (const raw of body.items.slice(0, 5000)) {
      const entry = normalizeExportedItem(raw);
      if (entry) entries.push(entry);
    }
    const updated = await replaceVaultCache(c.get("sql"), vault, entries, cacheKey);
    return c.json({ vault, updated });
  });

  return app;
}
