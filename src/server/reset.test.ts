import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app.ts";
import { openNodeSql } from "./sql-node.ts";
import type { Sql } from "./sql.ts";

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

describe("password reset", { concurrency: 1 }, () => {
  before(async () => {
    const dir = mkdtempSync(join(tmpdir(), "basket-reset-"));
    sql = await openNodeSql(join(dir, "test.sqlite"));
    app = createApp(() => sql);
  });

  after(() => {
    cookieJar.clear();
  });

  it("issuing a token requires auth", async () => {
    const res = await api("/api/members/someone/reset-token", { body: {}, cookies: false });
    assert.equal(res.status, 401);
  });

  it("full flow: issue, redeem, sessions killed, single-use", async () => {
    cookieJar.clear();
    const created = await api("/api/auth/register", {
      body: { householdName: "Flat 1", displayName: "Alex", username: "alex", password: "password1" },
    });
    assert.equal(created.status, 200);
    const boot = (await api("/api/bootstrap")).json as { user: { id: string } };
    const oldSession = cookieHeader();

    const issued = (await api(`/api/members/${boot.user.id}/reset-token`, { body: {} })).json as { token: string };
    assert.ok(issued.token.length >= 32);

    const wrong = await api(
      "/api/auth/reset",
      { body: { username: "alex", token: "nope", password: "password2" }, cookies: false },
    );
    assert.equal(wrong.status, 400);

    const short = await api(
      "/api/auth/reset",
      { body: { username: "alex", token: issued.token, password: "short" }, cookies: false },
    );
    assert.equal(short.status, 400);

    const redeemed = await api(
      "/api/auth/reset",
      { body: { username: "alex", token: issued.token, password: "password2" }, cookies: false },
    );
    assert.equal(redeemed.status, 200);

    // Token burns on use.
    const replay = await api(
      "/api/auth/reset",
      { body: { username: "alex", token: issued.token, password: "password3" }, cookies: false },
    );
    assert.equal(replay.status, 400);

    // Old password dead, new password works.
    const oldLogin = await api(
      "/api/auth/login",
      { body: { username: "alex", password: "password1" }, cookies: false },
    );
    assert.equal(oldLogin.status, 401);
    const newLogin = await api(
      "/api/auth/login",
      { body: { username: "alex", password: "password2" }, cookies: false },
    );
    assert.equal(newLogin.status, 200);

    // Pre-reset session was revoked.
    const stale = await app.request("/api/bootstrap", { headers: { cookie: oldSession } });
    assert.equal(stale.status, 401);
  });

  it("cannot issue for another household or an OAuth-only member", async () => {
    cookieJar.clear();
    const bob = await api("/api/auth/register", {
      body: { householdName: "Flat 2", displayName: "Bob", username: "bob", password: "password1" },
    });
    assert.equal(bob.status, 200);
    const alex = await sql.get<{ id: string }>("SELECT id FROM users WHERE username = ?", "alex");
    assert.ok(alex);
    const cross = await api(`/api/members/${alex.id}/reset-token`, { body: {} });
    assert.equal(cross.status, 404);

    await sql.run(
      "INSERT INTO users (id, household_id, username, password_hash, display_name, color, created_at, last_seen) VALUES (?, (SELECT household_id FROM users WHERE username = ?), ?, ?, ?, ?, ?, ?)",
      "oauth-user",
      "bob",
      "bob-oauth",
      "",
      "Bob OAuth",
      "#fff",
      Date.now(),
      Date.now(),
    );
    const oauthOnly = await api("/api/members/oauth-user/reset-token", { body: {} });
    assert.equal(oauthOnly.status, 400);
  });

  it("expired tokens are rejected", async () => {
    const bob = await sql.get<{ id: string }>("SELECT id FROM users WHERE username = ?", "bob");
    assert.ok(bob);
    await sql.run(
      "INSERT INTO password_resets (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
      "expired-token",
      bob.id,
      Date.now() - 1000,
      Date.now() - 1000,
    );
    const res = await api(
      "/api/auth/reset",
      { body: { username: "bob", token: "expired-token", password: "password2" }, cookies: false },
    );
    assert.equal(res.status, 400);
  });
});
