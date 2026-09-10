import { USER_COLORS } from "../shared/categories.ts";
import { newId, newInviteCode, validateDisplayName, validateUsername } from "./auth.ts";
import {
  getHouseholdByInvite,
  getUserById,
  getUserByUsername,
  memberCount,
  type UserRow,
} from "./db.ts";
import type { Sql } from "./sql.ts";

export type OAuthProvider = "google" | "apple";
export type OAuthMode = "login" | "create" | "join" | "link";

export type OAuthEnv = {
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  APPLE_CLIENT_ID?: string;
  APPLE_TEAM_ID?: string;
  APPLE_KEY_ID?: string;
  APPLE_PRIVATE_KEY?: string;
  OAUTH_REDIRECT_BASE?: string;
};

export function isProvider(value: unknown): value is OAuthProvider {
  return value === "google" || value === "apple";
}

export function oauthConfigured(env: OAuthEnv, provider: OAuthProvider): boolean {
  if (provider === "google") return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
  return Boolean(
    env.APPLE_CLIENT_ID && env.APPLE_TEAM_ID && env.APPLE_KEY_ID && env.APPLE_PRIVATE_KEY,
  );
}

export function oauthCallbackUrl(env: OAuthEnv, reqUrl: string): string {
  const base = (env.OAUTH_REDIRECT_BASE || "").replace(/\/$/, "");
  if (base) return `${base}/api/auth/oauth/callback`;
  return new URL("/api/auth/oauth/callback", reqUrl).toString();
}

// --- base64url (no Buffer: must run on Workers too) ---

export function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(text: string): Uint8Array {
  const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// --- PKCE ---

export async function newCodeVerifier(): Promise<string> {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
}

export async function codeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return b64urlEncode(new Uint8Array(digest));
}

// --- authorize URLs ---

export async function authorizeUrl(
  env: OAuthEnv,
  provider: OAuthProvider,
  opts: { state: string; challenge: string; redirectUri: string },
): Promise<string> {
  if (provider === "google") {
    const q = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID || "",
      redirect_uri: opts.redirectUri,
      response_type: "code",
      scope: "openid email profile",
      state: opts.state,
      code_challenge: opts.challenge,
      code_challenge_method: "S256",
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
  }
  const q = new URLSearchParams({
    client_id: env.APPLE_CLIENT_ID || "",
    redirect_uri: opts.redirectUri,
    response_type: "code",
    scope: "name email",
    response_mode: "query",
    state: opts.state,
    code_challenge: opts.challenge,
    code_challenge_method: "S256",
  });
  return `https://appleid.apple.com/auth/authorize?${q}`;
}

// --- pending-state store (single-use, 10-minute expiry) ---

export type OAuthPending = {
  state: string;
  provider: OAuthProvider;
  mode: OAuthMode;
  userId: string | null;
  params: Record<string, string>;
  verifier: string;
};

const STATE_TTL_MS = 10 * 60 * 1000;

export async function createPendingState(
  sql: Sql,
  opts: { provider: OAuthProvider; mode: OAuthMode; userId?: string; params?: Record<string, string> },
  now = Date.now(),
): Promise<OAuthPending> {
  const state = b64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
  const verifier = await newCodeVerifier();
  await sql.run(
    "INSERT INTO oauth_states (state, provider, mode, user_id, params, verifier, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    state,
    opts.provider,
    opts.mode,
    opts.userId ?? null,
    JSON.stringify(opts.params ?? {}),
    verifier,
    now + STATE_TTL_MS,
    now,
  );
  await sql.run("DELETE FROM oauth_states WHERE expires_at < ?", now).catch(() => undefined);
  return {
    state,
    provider: opts.provider,
    mode: opts.mode,
    userId: opts.userId ?? null,
    params: opts.params ?? {},
    verifier,
  };
}

export async function consumePendingState(sql: Sql, state: string): Promise<OAuthPending | undefined> {
  const row = await sql.get<{
    state: string;
    provider: string;
    mode: string;
    user_id: string | null;
    params: string;
    verifier: string;
    expires_at: number;
  }>("SELECT * FROM oauth_states WHERE state = ?", state);
  if (row) await sql.run("DELETE FROM oauth_states WHERE state = ?", state).catch(() => undefined);
  if (!row || row.expires_at < Date.now() || !isProvider(row.provider)) return undefined;
  let params: Record<string, string> = {};
  try {
    params = JSON.parse(row.params) as Record<string, string>;
  } catch {
    params = {};
  }
  return {
    state: row.state,
    provider: row.provider,
    mode: row.mode as OAuthMode,
    userId: row.user_id,
    params,
    verifier: row.verifier,
  };
}

// --- token exchange ---

async function postForm(url: string, fields: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error("oauth_exchange_failed");
  return data;
}

function pemToBytes(pem: string): Uint8Array {
  const body = pem
    .replace(/\\n/g, "\n")
    .replace(/-----[^-]+-----/g, "")
    .replace(/\s+/g, "");
  return b64urlDecode(body);
}

// IEEE P1363 (r || s) as returned by WebCrypto -> DER for JWT.
export function derFromP1363(sig: Uint8Array): Uint8Array {
  const half = sig.length / 2;
  const parts = [sig.subarray(0, half), sig.subarray(half)];
  const encoded: number[] = [];
  for (const part of parts) {
    let start = 0;
    while (start < part.length - 1 && part[start] === 0) start++;
    const slice = part.subarray(start);
    const needsZero = (slice[0] ?? 0) >= 0x80;
    const len = slice.length + (needsZero ? 1 : 0);
    encoded.push(0x02, len);
    if (needsZero) encoded.push(0x00);
    for (const b of slice) encoded.push(b);
  }
  return Uint8Array.from([0x30, encoded.length, ...encoded]);
}

// Apple requires an ES256-signed client-secret JWT for the token exchange.
export async function appleClientSecret(env: OAuthEnv, nowSec = Math.floor(Date.now() / 1000)): Promise<string> {
  if (!env.APPLE_TEAM_ID || !env.APPLE_KEY_ID || !env.APPLE_CLIENT_ID || !env.APPLE_PRIVATE_KEY) {
    throw new Error("oauth_not_configured");
  }
  const te = new TextEncoder();
  const header = b64urlEncode(te.encode(JSON.stringify({ alg: "ES256", kid: env.APPLE_KEY_ID })));
  const payload = b64urlEncode(
    te.encode(
      JSON.stringify({
        iss: env.APPLE_TEAM_ID,
        iat: nowSec,
        exp: nowSec + 300,
        aud: "https://appleid.apple.com",
        sub: env.APPLE_CLIENT_ID,
      }),
    ),
  );
  const keyBytes = Uint8Array.from(pemToBytes(env.APPLE_PRIVATE_KEY));
  const key = await crypto.subtle.importKey("pkcs8", keyBytes, { name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign",
  ]);
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, te.encode(`${header}.${payload}`)),
  );
  return `${header}.${payload}.${b64urlEncode(derFromP1363(sig))}`;
}

export type OAuthTokens = { accessToken: string; idToken: string | null };

export async function exchangeCode(
  env: OAuthEnv,
  provider: OAuthProvider,
  opts: { code: string; verifier: string; redirectUri: string },
): Promise<OAuthTokens> {
  if (provider === "google") {
    const data = await postForm("https://oauth2.googleapis.com/token", {
      code: opts.code,
      client_id: env.GOOGLE_CLIENT_ID || "",
      client_secret: env.GOOGLE_CLIENT_SECRET || "",
      redirect_uri: opts.redirectUri,
      grant_type: "authorization_code",
      code_verifier: opts.verifier,
    });
    if (typeof data.access_token !== "string" || !data.access_token) throw new Error("oauth_exchange_failed");
    return { accessToken: data.access_token, idToken: null };
  }
  const data = await postForm("https://appleid.apple.com/auth/token", {
    code: opts.code,
    client_id: env.APPLE_CLIENT_ID || "",
    client_secret: await appleClientSecret(env),
    redirect_uri: opts.redirectUri,
    grant_type: "authorization_code",
    code_verifier: opts.verifier,
  });
  if (typeof data.access_token !== "string" || !data.access_token) throw new Error("oauth_exchange_failed");
  if (typeof data.id_token !== "string" || !data.id_token) throw new Error("oauth_exchange_failed");
  return { accessToken: data.access_token, idToken: data.id_token };
}

// --- profiles ---

export type OAuthProfile = { sub: string; email: string; emailVerified: boolean; name: string };

async function googleProfile(accessToken: string): Promise<OAuthProfile> {
  const res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const data = (await res.json().catch(() => ({}))) as {
    sub?: unknown;
    email?: unknown;
    email_verified?: unknown;
    name?: unknown;
  };
  if (!res.ok || typeof data.sub !== "string" || !data.sub) throw new Error("oauth_profile_failed");
  return {
    sub: data.sub,
    email: typeof data.email === "string" ? data.email : "",
    emailVerified: data.email_verified === true,
    name: typeof data.name === "string" ? data.name : "",
  };
}

let appleJwksCache: { at: number; keys: Array<Record<string, unknown>> } | null = null;

export function resetAppleJwksForTests(): void {
  appleJwksCache = null;
}

async function appleJwks(): Promise<Array<Record<string, unknown>>> {
  if (appleJwksCache && Date.now() - appleJwksCache.at < 24 * 60 * 60 * 1000) return appleJwksCache.keys;
  const res = await fetch("https://appleid.apple.com/auth/keys");
  const data = (await res.json().catch(() => ({}))) as { keys?: unknown };
  if (!res.ok || !Array.isArray(data.keys)) throw new Error("oauth_profile_failed");
  appleJwksCache = { at: Date.now(), keys: data.keys as Array<Record<string, unknown>> };
  return appleJwksCache.keys;
}

export async function verifyAppleIdToken(env: OAuthEnv, idToken: string): Promise<OAuthProfile> {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("oauth_profile_failed");
  const te = new TextEncoder();
  const header = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[0]))) as { kid?: unknown; alg?: unknown };
  const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1]))) as {
    iss?: unknown;
    aud?: unknown;
    exp?: unknown;
    sub?: unknown;
    email?: unknown;
    email_verified?: unknown;
  };
  if (header.alg !== "RS256" || typeof header.kid !== "string") throw new Error("oauth_profile_failed");
  const keys = await appleJwks();
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error("oauth_profile_failed");
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk as unknown as JsonWebKey,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    Uint8Array.from(b64urlDecode(parts[2])),
    te.encode(`${parts[0]}.${parts[1]}`),
  );
  if (!ok) throw new Error("oauth_profile_failed");
  const nowSec = Math.floor(Date.now() / 1000);
  if (
    payload.iss !== "https://appleid.apple.com" ||
    payload.aud !== env.APPLE_CLIENT_ID ||
    typeof payload.exp !== "number" ||
    payload.exp < nowSec ||
    typeof payload.sub !== "string" ||
    !payload.sub
  ) {
    throw new Error("oauth_profile_failed");
  }
  const email = typeof payload.email === "string" ? payload.email : "";
  const verified = payload.email_verified === true || payload.email_verified === "true";
  return { sub: payload.sub, email, emailVerified: verified, name: "" };
}

export async function fetchProfile(
  env: OAuthEnv,
  provider: OAuthProvider,
  tokens: OAuthTokens,
): Promise<OAuthProfile> {
  if (provider === "google") return googleProfile(tokens.accessToken);
  if (!tokens.idToken) throw new Error("oauth_profile_failed");
  return verifyAppleIdToken(env, tokens.idToken);
}

// --- linked accounts ---

export type OAuthLink = { provider: string; email: string };

export async function getOAuthAccount(
  sql: Sql,
  provider: OAuthProvider,
  sub: string,
): Promise<{ user_id: string; email: string } | undefined> {
  return sql.get<{ user_id: string; email: string }>(
    "SELECT user_id, email FROM oauth_accounts WHERE provider = ? AND sub = ?",
    provider,
    sub,
  );
}

export async function listOAuthAccounts(sql: Sql, userId: string): Promise<OAuthLink[]> {
  return sql.all<OAuthLink>("SELECT provider, email FROM oauth_accounts WHERE user_id = ? ORDER BY provider", userId);
}

export async function linkOAuthAccount(
  sql: Sql,
  provider: OAuthProvider,
  sub: string,
  userId: string,
  email: string,
): Promise<void> {
  await sql.run(
    "INSERT INTO oauth_accounts (provider, sub, user_id, email, created_at) VALUES (?, ?, ?, ?, ?)",
    provider,
    sub,
    userId,
    email,
    Date.now(),
  );
}

export function usernameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? "";
  const clean = local
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, 20);
  return clean.length >= 3 ? clean : "user";
}

export async function uniqueUsername(sql: Sql, base: string): Promise<string> {
  const stem = base.slice(0, 24) || "user";
  for (let i = 0; i < 10; i++) {
    const candidate = i === 0 ? stem : `${stem.slice(0, 19)}_${newId().slice(0, 4)}`;
    if (!(await getUserByUsername(sql, candidate))) return candidate;
  }
  return `${stem.slice(0, 20)}_${newId().slice(0, 8)}`;
}

// --- finish: link-or-create, then the route mints the session ---

export type FinishParams = {
  mode: OAuthMode;
  userId?: string | null;
  householdName?: string;
  displayName?: string;
  inviteCode?: string;
};

export type FinishResult = { userId: string } | { error: string };

export function userHasPassword(user: UserRow): boolean {
  return user.password_hash !== "";
}

export async function finishOAuthLogin(
  sql: Sql,
  provider: OAuthProvider,
  sub: string,
  profile: OAuthProfile,
  params: FinishParams,
): Promise<FinishResult> {
  const now = Date.now();
  const existing = await getOAuthAccount(sql, provider, sub);
  if (existing) {
    const user = await getUserById(sql, existing.user_id);
    if (!user) return { error: "That login is no longer valid." };
    if (profile.emailVerified && profile.email && profile.email !== existing.email) {
      await sql.run("UPDATE oauth_accounts SET email = ? WHERE provider = ? AND sub = ?", profile.email, provider, sub);
    }
    return { userId: user.id };
  }

  if (params.mode === "login") return { error: "No account is linked to that login yet." };
  if (params.mode === "link") {
    if (!params.userId) return { error: "Please sign in first." };
    const user = await getUserById(sql, params.userId);
    if (!user) return { error: "Please sign in first." };
    try {
      await linkOAuthAccount(sql, provider, sub, user.id, profile.emailVerified ? profile.email : "");
    } catch {
      return { error: "That login is already linked to another account." };
    }
    return { userId: user.id };
  }

  const displayName = (params.displayName || profile.name || profile.email.split("@")[0] || "").trim().slice(0, 40);
  const nameErr = validateDisplayName(displayName || "Member");
  if (nameErr) return { error: nameErr };
  const username = await uniqueUsername(sql, usernameFromEmail(profile.email || displayName));
  if (validateUsername(username)) return { error: "Could not derive a username." };
  // OAuth-only users have no password; the empty hash never verifies.
  const passwordHash = "";

  try {
    return await sql.transaction(async () => {
      let userId: string;
      if (params.mode === "create") {
        const householdName = (params.householdName || "").trim().slice(0, 60);
        if (!householdName) return { error: "Give your household a name." };
        const householdId = newId();
        userId = newId();
        const listId = newId();
        await sql.run(
          "INSERT INTO households (id, name, invite_code, created_at) VALUES (?, ?, ?, ?)",
          householdId,
          householdName,
          newInviteCode(),
          now,
        );
        await sql.run(
          "INSERT INTO users (id, household_id, username, password_hash, display_name, color, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          userId,
          householdId,
          username,
          passwordHash,
          displayName || "Member",
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
      } else {
        const household = await getHouseholdByInvite(sql, params.inviteCode || "");
        if (!household) return { error: "That invite code was not found." };
        const count = await memberCount(sql, household.id);
        userId = newId();
        await sql.run(
          "INSERT INTO users (id, household_id, username, password_hash, display_name, color, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          userId,
          household.id,
          username,
          passwordHash,
          displayName || "Member",
          USER_COLORS[count % USER_COLORS.length],
          now,
          now,
        );
      }
      await linkOAuthAccount(sql, provider, sub, userId, profile.emailVerified ? profile.email : "");
      return { userId };
    });
  } catch {
    return { error: "Could not create household." };
  }
}
