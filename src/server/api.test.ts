import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "./app.ts";
import { openNodeSql } from "./sql-node.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let app: ReturnType<typeof createApp>;
const cookieJar = new Map<string, string>();

function saveCookies(header: string | null) {
  if (!header) return;
  const [pair] = header.split(";");
  const eq = pair.indexOf("=");
  if (eq > 0) cookieJar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
}

function cookieHeader(): string {
  return [...cookieJar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

async function api(
  path: string,
  opts: { method?: string; body?: object; cookies?: boolean } = {},
) {
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
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("json")) json = await res.json();
  return { status: res.status, json };
}

describe("api", { concurrency: 1 }, () => {
  before(async () => {
    const dir = mkdtempSync(join(tmpdir(), "basket-"));
    const sql = await openNodeSql(join(dir, "test.sqlite"));
    app = createApp(() => sql);
  });

  after(() => {
    cookieJar.clear();
  });

  it("health", async () => {
    const res = await api("/api/health", { cookies: false });
    assert.equal(res.status, 200);
  });

  it("bootstrap requires auth", async () => {
    cookieJar.clear();
    const res = await api("/api/bootstrap");
    assert.equal(res.status, 401);
  });

  it("household register, join, shared list, isolation", async () => {
    cookieJar.clear();
    const created = await api("/api/auth/register", {
      body: {
        householdName: "Flat 1",
        displayName: "Alex",
        username: "alex",
        password: "password1",
      },
    });
    assert.equal(created.status, 200);

    const boot = (await api("/api/bootstrap")).json as {
      user: { displayName: string };
      household: { name: string; inviteCode: string };
      lists: Array<{ id: string; name: string }>;
    };
    assert.equal(boot.user.displayName, "Alex");
    assert.equal(boot.household.name, "Flat 1");
    assert.match(boot.household.inviteCode, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    assert.equal(boot.lists[0].name, "Groceries");
    const listId = boot.lists[0].id;
    const invite = boot.household.inviteCode;

    const item = (
      await api(`/api/lists/${listId}/items`, {
        body: { name: "2x milk" },
      })
    ).json as { name: string; category: string; id: string };
    assert.equal(item.name, "2x milk");
    assert.equal(item.category, "dairy");

    const named = (
      await api(`/api/lists/${listId}/items`, {
        body: { name: "Bananas", quantity: "6", category: "fruit-veg" },
      })
    ).json as { id: string; name: string };

    const checked = (
      await api(`/api/items/${named.id}`, {
        method: "PATCH",
        body: { checked: true },
      })
    ).json as { checked: boolean; checkedBy: { displayName: string } };
    assert.equal(checked.checked, true);
    assert.equal(checked.checkedBy.displayName, "Alex");

    const alexCookie = cookieHeader();
    cookieJar.clear();

    const joined = await api("/api/auth/join", {
      body: {
        inviteCode: invite.toLowerCase(),
        displayName: "Sam",
        username: "sam",
        password: "password2",
      },
    });
    assert.equal(joined.status, 200);

    const samBoot = (await api("/api/bootstrap")).json as {
      items: Array<{ name: string; checked: boolean }>;
      household: { members: Array<{ displayName: string }> };
    };
    assert.equal(samBoot.household.members.length, 2);
    assert.equal(samBoot.items.length, 2);
    assert.ok(samBoot.items.some((i) => i.name === "Bananas" && i.checked));

    cookieJar.clear();
    const other = await api("/api/auth/register", {
      body: {
        householdName: "Other house",
        displayName: "Pat",
        username: "pat",
        password: "password3",
      },
    });
    assert.equal(other.status, 200);
    const otherBoot = (await api("/api/bootstrap")).json as { items: unknown[] };
    assert.equal(otherBoot.items.length, 0);

    const sneak = await api(`/api/items/${item.id}`, { method: "PATCH", body: { checked: true } });
    assert.equal(sneak.status, 404);

    cookieJar.clear();
    for (const part of alexCookie.split("; ")) {
      const eq = part.indexOf("=");
      cookieJar.set(part.slice(0, eq), part.slice(eq + 1));
    }

    const cleared = await api(`/api/lists/${listId}/clear-checked`, { method: "POST", body: {} });
    assert.equal(cleared.status, 200);
    const after = (await api("/api/bootstrap")).json as { items: Array<{ name: string }> };
    assert.deepEqual(
      after.items.map((i) => i.name).sort(),
      ["2x milk"],
    );

    const gone = await api(`/api/lists/${listId}`, { method: "DELETE" });
    assert.equal(gone.status, 204);
    const empty = (await api("/api/bootstrap")).json as { lists: unknown[] };
    assert.equal(empty.lists.length, 0);
  });

  it("login and duplicate username", async () => {
    cookieJar.clear();
    const bad = await api("/api/auth/login", { body: { username: "alex", password: "nope-nope" } });
    assert.equal(bad.status, 401);

    const ok = await api("/api/auth/login", { body: { username: "Alex", password: "password1" } });
    assert.equal(ok.status, 200);

    cookieJar.clear();
    const dup = await api("/api/auth/register", {
      body: {
        householdName: "Nope",
        displayName: "Alex 2",
        username: "alex",
        password: "password9",
      },
    });
    assert.equal(dup.status, 409);
  });
});
