import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app.ts";
import { openNodeSql } from "./sql-node.ts";
import type { Sql } from "./sql.ts";
import { resetLoginThrottleForTests } from "./auth.ts";

let app: ReturnType<typeof createApp>;
let sql: Sql;
const cookieJar = new Map<string, string>();

function saveCookies(header: string | null) {
  if (!header) return;
  for (const part of header.split(",")) {
    const [pair] = part.split(";");
    const eq = pair.indexOf("=");
    if (eq > 0) cookieJar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

function cookieHeader(): string {
  return [...cookieJar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

async function api(path: string, opts: { method?: string; body?: object; cookies?: boolean } = {}) {
  const method = opts.method ?? (opts.body ? "POST" : "GET");
  const res = await app.request(path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(opts.cookies === false ? {} : { cookie: cookieHeader() }),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  saveCookies(res.headers.get("set-cookie"));
  let json: unknown = null;
  if ((res.headers.get("content-type") ?? "").includes("json")) json = await res.json();
  return { status: res.status, json };
}

describe("recovery codes", { concurrency: 1 }, () => {
  before(async () => {
    const dir = mkdtempSync(join(tmpdir(), "basket-recovery-"));
    sql = await openNodeSql(join(dir, "test.sqlite"));
    app = createApp(() => sql);
  });

  after(() => {
    cookieJar.clear();
    resetLoginThrottleForTests();
  });

  it("register and join hand out one-time codes", async () => {
    cookieJar.clear();
    const created = (await api("/api/auth/register", {
      body: { householdName: "Flat 1", displayName: "Alex", username: "alex", password: "password1" },
    })).json as { ok: boolean; recoveryCodes: string[] };
    assert.equal(created.ok, true);
    assert.equal(created.recoveryCodes.length, 10);
    for (const code of created.recoveryCodes) {
      assert.match(code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    }
    assert.equal(new Set(created.recoveryCodes).size, 10);

    const boot = (await api("/api/bootstrap")).json as { household: { inviteCode: string } };
    cookieJar.clear();
    const joined = (await api("/api/auth/join", {
      body: { inviteCode: boot.household.inviteCode, displayName: "Sam", username: "sam", password: "password1" },
      cookies: false,
    })).json as { ok: boolean; recoveryCodes: string[] };
    assert.equal(joined.ok, true);
    assert.equal(joined.recoveryCodes.length, 10);
  });

  it("redeem sets a new password, burns the set, kills sessions", async () => {
    const boot = (await api("/api/bootstrap")).json as { user: { id: string } };
    assert.ok(boot.user);
    const oldSession = cookieHeader();
    const codes = (
      (await api("/api/recovery/codes/regenerate", { body: {} })).json as { codes: string[] }
    ).codes;
    assert.equal(codes.length, 10);
    cookieJar.clear();

    const wrong = await api(
      "/api/auth/recover",
      { body: { username: "sam", code: "XXXX-XXXX", password: "password2" }, cookies: false },
    );
    assert.equal(wrong.status, 400);

    const short = await api(
      "/api/auth/recover",
      { body: { username: "sam", code: codes[0], password: "short" }, cookies: false },
    );
    assert.equal(short.status, 400);

    const redeemed = (await api(
      "/api/auth/recover",
      { body: { username: "sam", code: codes[0], password: "password2" }, cookies: false },
    )).json as { ok: boolean; recoveryCodes: string[] };
    assert.equal(redeemed.ok, true);
    assert.equal(redeemed.recoveryCodes.length, 10);
    assert.ok(!redeemed.recoveryCodes.includes(codes[0]));

    // Burned set: a sibling code no longer works.
    const replay = await api(
      "/api/auth/recover",
      { body: { username: "sam", code: codes[1], password: "password3" }, cookies: false },
    );
    assert.equal(replay.status, 400);

    const oldLogin = await api(
      "/api/auth/login",
      { body: { username: "sam", password: "password1" }, cookies: false },
    );
    assert.equal(oldLogin.status, 401);
    const newLogin = await api(
      "/api/auth/login",
      { body: { username: "sam", password: "password2" }, cookies: false },
    );
    assert.equal(newLogin.status, 200);

    const stale = await app.request("/api/bootstrap", { headers: { cookie: oldSession } });
    assert.equal(stale.status, 401);
  });

  it("redeem attempts are throttled", async () => {
    resetLoginThrottleForTests();
    for (let i = 0; i < 5; i++) {
      const res = await api(
        "/api/auth/recover",
        { body: { username: "alex", code: "XXXX-XXXX", password: "password2" }, cookies: false },
      );
      assert.equal(res.status, 400);
    }
    const limited = await api(
      "/api/auth/recover",
      { body: { username: "alex", code: "XXXX-XXXX", password: "password2" }, cookies: false },
    );
    assert.equal(limited.status, 429);
    resetLoginThrottleForTests();
  });

  it("regenerate needs auth and invalidates the old set", async () => {
    const anon = await api("/api/recovery/codes/regenerate", { body: {}, cookies: false });
    assert.equal(anon.status, 401);

    cookieJar.clear();
    await api("/api/auth/login", { body: { username: "alex", password: "password1" } });
    const first = ((await api("/api/recovery/codes/regenerate", { body: {} })).json as { codes: string[] }).codes;
    const second = ((await api("/api/recovery/codes/regenerate", { body: {} })).json as { codes: string[] }).codes;
    assert.equal(second.length, 10);
    cookieJar.clear();
    const stale = await api(
      "/api/auth/recover",
      { body: { username: "alex", code: first[0], password: "password2" }, cookies: false },
    );
    assert.equal(stale.status, 400);
    const fresh = await api(
      "/api/auth/recover",
      { body: { username: "alex", code: second[0], password: "password2" }, cookies: false },
    );
    assert.equal(fresh.status, 200);
  });
});
