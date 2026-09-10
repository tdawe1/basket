import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app.ts";
import { openNodeSql } from "./sql-node.ts";
import type { Sql } from "./sql.ts";
import {
  appleClientSecret,
  b64urlDecode,
  b64urlEncode,
  codeChallenge,
  derFromP1363,
  resetAppleJwksForTests,
  usernameFromEmail,
  verifyAppleIdToken,
} from "./oauth.ts";

let app: ReturnType<typeof createApp>;
let sql: Sql;
const cookieJar = new Map<string, string>();
const realFetch = globalThis.fetch;

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
  return { status: res.status, headers: res.headers, json };
}

// Mutable stubs for provider HTTP.
let googleProfile: Record<string, unknown> = {};
let appleIdToken = "";

function stubProviders() {
  globalThis.fetch = (async (url: unknown) => {
    const u = String(url);
    const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
    if (u.includes("oauth2.googleapis.com/token")) return json({ access_token: "g-access" });
    if (u.includes("googleapis.com/oauth2/v3/userinfo")) return json(googleProfile);
    if (u.includes("appleid.apple.com/auth/token")) {
      return json({ access_token: "a-access", id_token: appleIdToken });
    }
    throw new Error(`unexpected fetch: ${u}`);
  }) as typeof fetch;
}

function stateFromAuthorizeUrl(url: string): string {
  const state = new URL(url).searchParams.get("state");
  assert.ok(state, "authorize url carries state");
  return state;
}

describe("oauth", { concurrency: 1 }, () => {
  before(async () => {
    const dir = mkdtempSync(join(tmpdir(), "basket-oauth-"));
    sql = await openNodeSql(join(dir, "test.sqlite"));
    app = createApp(() => sql);
    process.env.GOOGLE_CLIENT_ID = "test-google-id";
    process.env.GOOGLE_CLIENT_SECRET = "test-google-secret";
    stubProviders();
  });

  after(() => {
    globalThis.fetch = realFetch;
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    cookieJar.clear();
    resetAppleJwksForTests();
  });

  it("pure helpers: base64url, usernames, PKCE vector", async () => {
    const bytes = crypto.getRandomValues(new Uint8Array(48));
    assert.deepEqual(b64urlDecode(b64urlEncode(bytes)), bytes);
    assert.equal(usernameFromEmail("Alex.Smith+2@example.com"), "alexsmith2");
    assert.equal(usernameFromEmail("a@b.co"), "user");
    assert.equal(usernameFromEmail("no-at-sign"), "noatsign");
    // RFC 7636 Appendix B vector.
    assert.equal(
      await codeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("DER round-trips P1363 signatures", () => {
    const sig = crypto.getRandomValues(new Uint8Array(64));
    sig[0] = 0x01; // avoid leading-zero edge in this sample
    sig[32] = 0x01;
    const der = derFromP1363(sig);
    assert.equal(der[0], 0x30);
    let i = 2;
    const parts: Uint8Array[] = [];
    for (let n = 0; n < 2; n++) {
      assert.equal(der[i], 0x02);
      const len = der[i + 1];
      parts.push(der.subarray(i + 2, i + 2 + len));
      i += 2 + len;
    }
    assert.equal(i, der.length);
    const strip = (p: Uint8Array) => (p[0] === 0 ? p.subarray(1) : p);
    assert.deepEqual(strip(parts[0]), sig.subarray(0, 32));
    assert.deepEqual(strip(parts[1]), sig.subarray(32, 64));
  });

  it("providers endpoint reflects configuration", async () => {
    const res = (await api("/api/auth/oauth/providers", { cookies: false })).json as {
      google: boolean;
      apple: boolean;
    };
    assert.equal(res.google, true);
    assert.equal(res.apple, false);
  });

  it("start validates provider and mode params", async () => {
    const bad = await api("/api/auth/oauth/start", { body: { provider: "github", mode: "login" } });
    assert.equal(bad.status, 400);
    const unconfigured = await api("/api/auth/oauth/start", { body: { provider: "apple", mode: "login" } });
    assert.equal(unconfigured.status, 400);
    const missing = await api("/api/auth/oauth/start", {
      body: { provider: "google", mode: "create", householdName: "", displayName: "Alex" },
    });
    assert.equal(missing.status, 400);
  });

  it("google create makes a household user and links the account", async () => {
    cookieJar.clear();
    googleProfile = { sub: "g-alex", email: "Alex@Example.com", email_verified: true, name: "Alex" };
    const started = (await api("/api/auth/oauth/start", {
      body: { provider: "google", mode: "create", householdName: "Flat 1", displayName: "Alex" },
      cookies: false,
    })).json as { url: string };
    assert.ok(started.url.includes("accounts.google.com"));

    const cb = await app.request(`/api/auth/oauth/callback?code=code1&state=${stateFromAuthorizeUrl(started.url)}`, {
      headers: { cookie: "" },
    });
    assert.equal(cb.status, 302);
    assert.equal(new URL(cb.headers.get("location") || "", "http://x").pathname, "/");
    saveCookies(cb.headers.get("set-cookie"));

    const boot = (await api("/api/bootstrap")).json as {
      user: { id: string; username: string; displayName: string };
      household: { name: string };
    };
    assert.equal(boot.household.name, "Flat 1");
    assert.equal(boot.user.username, "alex");
    assert.equal(boot.user.displayName, "Alex");
  });

  it("google login reuses the linked account", async () => {
    const before = (await api("/api/bootstrap")).json as { user: { id: string } };
    cookieJar.clear();
    googleProfile = { sub: "g-alex", email: "Alex@Example.com", email_verified: true, name: "Alex" };
    const started = (await api("/api/auth/oauth/start", {
      body: { provider: "google", mode: "login" },
      cookies: false,
    })).json as { url: string };
    const cb = await app.request(`/api/auth/oauth/callback?code=code2&state=${stateFromAuthorizeUrl(started.url)}`, {
      headers: { cookie: "" },
    });
    assert.equal(cb.status, 302);
    saveCookies(cb.headers.get("set-cookie"));
    const afterLogin = (await api("/api/bootstrap")).json as { user: { id: string } };
    assert.equal(afterLogin.user.id, before.user.id);
  });

  it("google login with an unknown account fails closed", async () => {
    cookieJar.clear();
    googleProfile = { sub: "g-stranger", email: "stranger@example.com", email_verified: true, name: "Sam" };
    const started = (await api("/api/auth/oauth/start", {
      body: { provider: "google", mode: "login" },
      cookies: false,
    })).json as { url: string };
    const cb = await app.request(`/api/auth/oauth/callback?code=code3&state=${stateFromAuthorizeUrl(started.url)}`, {
      headers: { cookie: "" },
    });
    assert.equal(cb.status, 302);
    assert.ok((cb.headers.get("location") || "").includes("oauth_error="));
    assert.equal(cb.headers.get("set-cookie"), null);
  });

  it("expired state is single-use and rejected", async () => {
    await sql.run(
      "INSERT INTO oauth_states (state, provider, mode, user_id, params, verifier, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      "stale-state",
      "google",
      "login",
      null,
      "{}",
      "verifier",
      Date.now() - 1000,
      Date.now() - 1000,
    );
    const cb = await app.request("/api/auth/oauth/callback?code=x&state=stale-state", { headers: { cookie: "" } });
    assert.equal(cb.status, 302);
    assert.ok((cb.headers.get("location") || "").includes("oauth_error=expired"));
  });

  it("password user can link and unlink google", async () => {
    cookieJar.clear();
    const created = await api("/api/auth/register", {
      body: { householdName: "Flat 2", displayName: "Sam", username: "sam", password: "password1" },
    });
    assert.equal(created.status, 200);

    googleProfile = { sub: "g-sam", email: "sam@example.com", email_verified: true, name: "Sam" };
    const started = (await api("/api/auth/oauth/start", { body: { provider: "google", mode: "link" } })).json as {
      url: string;
    };
    const cb = await app.request(`/api/auth/oauth/callback?code=code4&state=${stateFromAuthorizeUrl(started.url)}`, {
      headers: { cookie: cookieHeader() },
    });
    assert.equal(cb.status, 302);
    saveCookies(cb.headers.get("set-cookie"));

    const links = (await api("/api/auth/oauth/links")).json as Array<{ provider: string; email: string }>;
    assert.deepEqual(links, [{ provider: "google", email: "sam@example.com" }]);

    const unlinked = await api("/api/auth/oauth/google", { method: "DELETE" });
    assert.equal(unlinked.status, 204);
  });

  it("oauth-only user cannot unlink their last login", async () => {
    cookieJar.clear();
    googleProfile = { sub: "g-solo", email: "solo@example.com", email_verified: true, name: "Solo" };
    const started = (await api("/api/auth/oauth/start", {
      body: { provider: "google", mode: "create", householdName: "Solo", displayName: "Solo" },
      cookies: false,
    })).json as { url: string };
    const cb = await app.request(`/api/auth/oauth/callback?code=code5&state=${stateFromAuthorizeUrl(started.url)}`, {
      headers: { cookie: "" },
    });
    assert.equal(cb.status, 302);
    saveCookies(cb.headers.get("set-cookie"));

    const unlinked = await api("/api/auth/oauth/google", { method: "DELETE" });
    assert.equal(unlinked.status, 400);
  });

  it("apple client secret signs and id tokens verify (generated keys)", async () => {
    // ES256 signing key for the client secret.
    const ec = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", ec.privateKey));
    let bin = "";
    for (const b of pkcs8) bin += String.fromCharCode(b);
    const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(bin)}\n-----END PRIVATE KEY-----\n`;
    const env = {
      APPLE_CLIENT_ID: "com.example.basket",
      APPLE_TEAM_ID: "TEAM123",
      APPLE_KEY_ID: "KEY123",
      APPLE_PRIVATE_KEY: pem,
    };
    const secret = await appleClientSecret(env, 1_700_000_000);
    assert.equal(secret.split(".").length, 3);

    // RSA key for the id_token; stub the JWKS fetch with its public half.
    const rsa = await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    );
    const pubJwk = (await crypto.subtle.exportKey("jwk", rsa.publicKey)) as Record<string, unknown>;
    const prevFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ keys: [{ ...pubJwk, kid: "rsa1", alg: "RS256", use: "sig" }] }), {
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    try {
      const te = new TextEncoder();
      const h = b64urlEncode(te.encode(JSON.stringify({ alg: "RS256", kid: "rsa1" })));
      const nowSec = Math.floor(Date.now() / 1000);
      const p = b64urlEncode(
        te.encode(
          JSON.stringify({
            iss: "https://appleid.apple.com",
            aud: "com.example.basket",
            exp: nowSec + 600,
            iat: nowSec,
            sub: "a-sub-1",
            email: "solo@apple.example",
            email_verified: "true",
          }),
        ),
      );
      const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", rsa.privateKey, te.encode(`${h}.${p}`)));
      const profile = await verifyAppleIdToken(env, `${h}.${p}.${b64urlEncode(sig)}`);
      assert.equal(profile.sub, "a-sub-1");
      assert.equal(profile.email, "solo@apple.example");
      assert.equal(profile.emailVerified, true);
    } finally {
      globalThis.fetch = prevFetch;
      resetAppleJwksForTests();
    }
  });
});
