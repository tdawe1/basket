export const COOKIE = "basket";
export const SESSION_MS = 1000 * 60 * 60 * 24 * 180;

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function pbkdf2(password: string, salt: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations: 100_000 },
    key,
    256,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await pbkdf2(password, salt);
  return `pbkdf2:${toHex(salt)}:${toHex(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, hashHex] = stored.split(":");
  if (scheme !== "pbkdf2" || !saltHex || !hashHex) return false;
  const salt = fromHex(saltHex);
  const expected = fromHex(hashHex);
  const hash = await pbkdf2(password, salt);
  return timingSafeEqual(hash, expected);
}

export function newId(): string {
  return toHex(randomBytes(16));
}

export function newInviteCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(8);
  let s = "";
  for (const b of bytes) s += chars[b % chars.length];
  return s;
}

export function formatInvite(code: string): string {
  const raw = code.replace(/[-\s]/g, "").toUpperCase();
  return raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
}

export function newRecoveryCode(): string {
  return formatInvite(newInviteCode());
}

export async function hashRecoveryCode(code: string): Promise<string> {
  const normalized = code.replace(/[-\s]/g, "").toUpperCase();
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`basket-recovery:${normalized}`),
  );
  return toHex(new Uint8Array(digest));
}

export const RECOVERY_CODE_COUNT = 10;

export async function mintRecoveryCodes(): Promise<{ codes: string[]; hashes: string[] }> {
  const codes: string[] = [];
  const seen = new Set<string>();
  while (codes.length < RECOVERY_CODE_COUNT) {
    const code = newRecoveryCode();
    if (seen.has(code)) continue;
    seen.add(code);
    codes.push(code);
  }
  const hashes: string[] = [];
  for (const code of codes) hashes.push(await hashRecoveryCode(code));
  return { codes, hashes };
}

export function sessionIdFromHeader(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  const match = cookieHeader.match(/(?:^|; )basket=([^;]+)/);
  return match?.[1];
}

const USERNAME_RE = /^[a-zA-Z0-9_]{3,32}$/;

export function validateUsername(username: string): string | null {
  if (!USERNAME_RE.test(username)) {
    return "Username must be 3–32 letters, numbers, or underscores.";
  }
  return null;
}

export function validatePassword(password: string): string | null {
  if (password.length < 8) return "Password must be at least 8 characters.";
  if (password.length > 200) return "Password is too long.";
  return null;
}

export function validateDisplayName(name: string): string | null {
  const t = name.trim();
  if (t.length < 1) return "Name is required.";
  if (t.length > 40) return "Name is too long.";
  return null;
}

export const LOGIN_MAX_FAILURES = 5;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;

type FailRow = { n: number; start: number };
const loginFails = new Map<string, FailRow>();

function loginKey(username: string): string {
  return username.trim().toLowerCase();
}

export function loginAllowed(username: string, now = Date.now()): boolean {
  const key = loginKey(username);
  if (!key) return true;
  const row = loginFails.get(key);
  if (!row) return true;
  if (now - row.start > LOGIN_WINDOW_MS) {
    loginFails.delete(key);
    return true;
  }
  return row.n < LOGIN_MAX_FAILURES;
}

export function recordLoginFailure(username: string, now = Date.now()): void {
  const key = loginKey(username);
  if (!key) return;
  const row = loginFails.get(key);
  if (!row || now - row.start > LOGIN_WINDOW_MS) {
    loginFails.set(key, { n: 1, start: now });
    return;
  }
  row.n += 1;
}

export function clearLoginFailures(username: string): void {
  loginFails.delete(loginKey(username));
}

export function resetLoginThrottleForTests(): void {
  loginFails.clear();
}
