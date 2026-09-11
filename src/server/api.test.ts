import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "./app.ts";
import { LOGIN_MAX_FAILURES, resetLoginThrottleForTests } from "./auth.ts";
import { SQL_FILE_MAX_BYTES } from "./files.ts";
import { openNodeSql } from "./sql-node.ts";
import type { Sql } from "./sql.ts";
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

  it("list subsections group items and clear on delete", async () => {
    cookieJar.clear();
    const created = await api("/api/auth/register", {
      body: {
        householdName: "Section House",
        displayName: "Sam",
        username: "sam_sections",
        password: "password1",
      },
    });
    assert.equal(created.status, 200);
    const boot = (await api("/api/bootstrap")).json as {
      lists: Array<{ id: string }>;
      sections: unknown[];
    };
    const listId = boot.lists[0].id;
    assert.equal(boot.sections.length, 0);

    const noName = await api(`/api/lists/${listId}/sections`, { body: { name: " " } });
    assert.equal(noName.status, 400);

    const section = (
      await api(`/api/lists/${listId}/sections`, { body: { name: "Freezer" } })
    ).json as { id: string; listId: string; name: string };
    assert.equal(section.name, "Freezer");
    assert.equal(section.listId, listId);

    const foreign = await api("/api/lists/no-such-list/sections", { body: { name: "X" } });
    assert.equal(foreign.status, 404);

    const item = (
      await api(`/api/lists/${listId}/items`, { body: { name: "Peas", sectionId: section.id } })
    ).json as { id: string; sectionId: string | null };
    assert.equal(item.sectionId, section.id);

    const badSection = await api(`/api/lists/${listId}/items`, {
      body: { name: "Beans", sectionId: "no-such-section" },
    });
    assert.equal(badSection.status, 404);

    const moved = (
      await api(`/api/items/${item.id}`, { method: "PATCH", body: { sectionId: null } })
    ).json as { sectionId: string | null };
    assert.equal(moved.sectionId, null);

    const renamed = (
      await api(`/api/sections/${section.id}`, { method: "PATCH", body: { name: "Deep freeze" } })
    ).json as { name: string };
    assert.equal(renamed.name, "Deep freeze");

    const withItems = (
      await api(`/api/lists/${listId}/items`, { body: { name: "Fish", sectionId: section.id } })
    ).json as { id: string };
    const removed = await api(`/api/sections/${section.id}`, { method: "DELETE" });
    assert.equal(removed.status, 204);
    const freed = (
      await api(`/api/items/${withItems.id}`, { method: "PATCH", body: { checked: true } })
    ).json as { sectionId: string | null };
    assert.equal(freed.sectionId, null);

    const listed = (await api("/api/bootstrap")).json as { sections: unknown[] };
    assert.equal(listed.sections.length, 0);
  });

  it("item reminders attach to items and clear on delete", async () => {
    cookieJar.clear();
    const created = await api("/api/auth/register", {
      body: {
        householdName: "Reminder House",
        displayName: "Jo",
        username: "jo_remind",
        password: "password1",
      },
    });
    assert.equal(created.status, 200);
    const boot = (await api("/api/bootstrap")).json as { lists: Array<{ id: string }> };
    const listId = boot.lists[0].id;

    const item = (
      await api(`/api/lists/${listId}/items`, { body: { name: "Milk" } })
    ).json as { id: string };

    const missing = await api("/api/reminders", {
      body: { kind: "item", dueAt: Date.now() + 3600000 },
    });
    assert.equal(missing.status, 400);

    const foreign = await api("/api/reminders", {
      body: { kind: "item", itemId: "no-such-item", dueAt: Date.now() + 3600000 },
    });
    assert.equal(foreign.status, 404);

    const dueAt = Date.now() + 3600000;
    const reminder = (
      await api("/api/reminders", { body: { kind: "item", itemId: item.id, dueAt } })
    ).json as { id: string; kind: string; itemId: string | null; listId: string | null; title: string };
    assert.equal(reminder.kind, "item");
    assert.equal(reminder.itemId, item.id);
    assert.equal(reminder.listId, listId);
    assert.equal(reminder.title, "Buy Milk");

    const otherList = (
      await api("/api/lists", { body: { name: "Other" } })
    ).json as { id: string };
    const pinned = (
      await api("/api/reminders", {
        body: { kind: "item", itemId: item.id, listId: otherList.id, dueAt: Date.now() + 3600000 },
      })
    ).json as { id: string; listId: string | null };
    assert.equal(pinned.listId, listId);
    await api(`/api/reminders/${pinned.id}`, { method: "DELETE" });

    const listed = (await api("/api/bootstrap")).json as {
      reminders: Array<{ id: string }>;
    };
    assert.ok(listed.reminders.some((r) => r.id === reminder.id));

    const gone = await api(`/api/items/${item.id}`, { method: "DELETE" });
    assert.equal(gone.status, 204);
    const after = (await api("/api/bootstrap")).json as {
      reminders: Array<{ id: string }>;
    };
    assert.ok(!after.reminders.some((r) => r.id === reminder.id));
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

  it("reminders: nudge, trip, calendar payload, isolation", async () => {
    cookieJar.clear();
    const created = await api("/api/auth/register", {
      body: {
        householdName: "Remind House",
        displayName: "Riley",
        username: "riley",
        password: "password1",
      },
    });
    assert.equal(created.status, 200);

    const boot = (await api("/api/bootstrap")).json as {
      lists: Array<{ id: string; name: string }>;
      reminders: unknown[];
    };
    assert.equal(Array.isArray(boot.reminders), true);
    assert.equal(boot.reminders.length, 0);
    const listId = boot.lists[0].id;

    const missingKind = await api("/api/reminders", { body: { listId } });
    assert.equal(missingKind.status, 400);

    const past = await api("/api/reminders", {
      body: { kind: "trip", listId, dueAt: Date.now() - 5 * 60_000 },
    });
    assert.equal(past.status, 400);

    const nudge = (
      await api("/api/reminders", {
        body: { kind: "nudge", listId, title: "Please pick up milk" },
      })
    ).json as {
      id: string;
      kind: string;
      title: string;
      listId: string;
      durationMin: number;
      createdBy: { displayName: string };
    };
    assert.equal(nudge.kind, "nudge");
    assert.equal(nudge.title, "Please pick up milk");
    assert.equal(nudge.listId, listId);
    assert.equal(nudge.durationMin, 0);
    assert.equal(nudge.createdBy.displayName, "Riley");

    const dueAt = Date.now() + 2 * 60 * 60 * 1000;
    const trip = (
      await api("/api/reminders", {
        body: { kind: "trip", listId, dueAt, durationMin: 90, title: "Saturday shop" },
      })
    ).json as { id: string; kind: string; dueAt: number; durationMin: number; title: string };
    assert.equal(trip.kind, "trip");
    assert.equal(trip.title, "Saturday shop");
    assert.equal(trip.durationMin, 90);
    assert.equal(trip.dueAt, dueAt);

    const after = (await api("/api/bootstrap")).json as {
      reminders: Array<{ id: string; kind: string }>;
    };
    assert.equal(after.reminders.length, 2);
    assert.ok(after.reminders.some((r) => r.id === trip.id));
    assert.ok(after.reminders.some((r) => r.id === nudge.id));

    const gone = await api(`/api/reminders/${trip.id}`, { method: "DELETE" });
    assert.equal(gone.status, 204);
    const trimmed = (await api("/api/bootstrap")).json as { reminders: Array<{ id: string }> };
    assert.equal(trimmed.reminders.some((r) => r.id === trip.id), false);

    cookieJar.clear();
    const other = await api("/api/auth/register", {
      body: {
        householdName: "Other remind",
        displayName: "Pat",
        username: "patremind",
        password: "password3",
      },
    });
    assert.equal(other.status, 200);
    const sneak = await api(`/api/reminders/${nudge.id}`, { method: "DELETE" });
    assert.equal(sneak.status, 404);
    const isolated = (await api("/api/bootstrap")).json as { reminders: unknown[] };
    assert.equal(isolated.reminders.length, 0);
  });

  it("notes: text, pdf upload, isolation", async () => {
    cookieJar.clear();
    const created = await api("/api/auth/register", {
      body: {
        householdName: "Notes House",
        displayName: "Nora",
        username: "nora",
        password: "password1",
      },
    });
    assert.equal(created.status, 200);

    const boot = (await api("/api/bootstrap")).json as { notes: unknown[] };
    assert.equal(Array.isArray(boot.notes), true);
    assert.equal(boot.notes.length, 0);

    const note = (
      await api("/api/notes", {
        body: { title: "School letter", body: "Bring water bottle." },
      })
    ).json as { id: string; title: string; body: string; fileName: string | null };
    assert.equal(note.title, "School letter");
    assert.equal(note.body, "Bring water bottle.");
    assert.equal(note.fileName, null);

    const pdf = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
    const upload = await app.request(`/api/notes/${note.id}/file`, {
      method: "PUT",
      headers: {
        cookie: cookieHeader(),
        "content-type": "application/pdf",
        "x-file-name": "letter.pdf",
      },
      body: pdf,
    });
    assert.equal(upload.status, 200);
    const uploaded = (await upload.json()) as { fileName: string; fileMime: string; fileSize: number };
    assert.equal(uploaded.fileName, "letter.pdf");
    assert.equal(uploaded.fileMime, "application/pdf");
    assert.equal(uploaded.fileSize, pdf.byteLength);

    const fileRes = await app.request(`/api/notes/${note.id}/file`, {
      headers: { cookie: cookieHeader() },
    });
    assert.equal(fileRes.status, 200);
    assert.equal(fileRes.headers.get("content-type"), "application/pdf");
    const got = Buffer.from(await fileRes.arrayBuffer());
    assert.equal(got.equals(pdf), true);

    const exe = await app.request(`/api/notes/${note.id}/file`, {
      method: "PUT",
      headers: {
        cookie: cookieHeader(),
        "content-type": "application/pdf",
        "x-file-name": "virus.exe",
      },
      body: Buffer.from("MZ this is not a pdf"),
    });
    assert.equal(exe.status, 400);

    cookieJar.clear();
    await api("/api/auth/register", {
      body: {
        householdName: "Other notes",
        displayName: "Pat",
        username: "patnotes",
        password: "password3",
      },
    });
    const sneak = await app.request(`/api/notes/${note.id}/file`, {
      headers: { cookie: cookieHeader() },
    });
    assert.equal(sneak.status, 404);
    const isolatedNotes = (await api("/api/bootstrap")).json as { notes: unknown[] };
    assert.equal(isolatedNotes.notes.length, 0);

    cookieJar.clear();
    await api("/api/auth/login", { body: { username: "nora", password: "password1" } });
    const oversized = await app.request(`/api/notes/${note.id}/file`, {
      method: "PUT",
      headers: {
        cookie: cookieHeader(),
        "content-type": "application/pdf",
        "content-length": String(SQL_FILE_MAX_BYTES + 1),
        "x-file-name": "huge.pdf",
      },
      body: "%PDF-1.4\n",
    });
    assert.equal(oversized.status, 413);
  });

  it("throttles repeated failed logins", async () => {
    resetLoginThrottleForTests();
    cookieJar.clear();
    let last = { status: 0, json: null as unknown };
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) {
      last = await api("/api/auth/login", { body: { username: "throttleuser", password: "wrong-password" } });
      assert.equal(last.status, 401);
    }
    const blocked = await api("/api/auth/login", {
      body: { username: "throttleuser", password: "wrong-password" },
    });
    assert.equal(blocked.status, 429);
  });

  it("vault sync requires a secret and a cache key", async () => {
    delete process.env.VAULT_SYNC_SECRET;
    delete process.env.VAULT_CACHE_KEY;
    const noSecret = await api("/api/vault/sync", {
      method: "POST",
      body: { vault: "Shared", items: [] },
    });
    assert.equal(noSecret.status, 503);
    process.env.VAULT_SYNC_SECRET = "test-sync-secret";
    try {
      const noKey = await app.request("/api/vault/sync", {
        method: "POST",
        headers: { "content-type": "application/json", "x-vault-sync-secret": "test-sync-secret" },
        body: JSON.stringify({ vault: "Shared", items: [] }),
      });
      assert.equal(noKey.status, 503);
    } finally {
      delete process.env.VAULT_SYNC_SECRET;
    }
  });

  it("vault sync encrypts the cache and gates reads by household", async () => {
    process.env.VAULT_SYNC_SECRET = "test-sync-secret";
    process.env.VAULT_CACHE_KEY = "test-cache-key";
    try {
      async function authed(path: string, cookie: string) {
        const res = await app.request(path, { headers: { cookie } });
        const json = (await res.json().catch(() => null)) as unknown;
        return { status: res.status, json };
      }
      cookieJar.clear();
      assert.equal(
        (
          await api("/api/auth/register", {
            body: {
              householdName: "Vault House",
              displayName: "Sam",
              username: "sam_vault",
              password: "password1",
            },
          })
        ).status,
        200,
      );
      const cookie1 = cookieHeader();
      const house1 = ((await api("/api/bootstrap")).json as { household: { id: string } }).household.id;

      const payload = {
        vault: "Shared",
        items: [
          {
            id: "cache-id-1",
            state: "Active",
            content: {
              title: "example.com",
              note: "shared login",
              content: { Login: { username: "sam", password: "s3cret", urls: ["https://example.com"] } },
            },
          },
          { state: "Active", content: null },
          { id: "trashed-1", state: "Trashed", content: { title: "old", note: "", content: {} } },
        ],
      };
      const denied = await app.request("/api/vault/sync", {
        method: "POST",
        headers: { "content-type": "application/json", "x-vault-sync-secret": "wrong" },
        body: JSON.stringify(payload),
      });
      assert.equal(denied.status, 401);

      const tooLarge = await app.request("/api/vault/sync", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(3 * 1024 * 1024),
          "x-vault-sync-secret": "test-sync-secret",
        },
        body: JSON.stringify(payload),
      });
      assert.equal(tooLarge.status, 413);

      const synced = await app.request("/api/vault/sync", {
        method: "POST",
        headers: { "content-type": "application/json", "x-vault-sync-secret": "test-sync-secret" },
        body: JSON.stringify({ ...payload, vault: "Evil" }),
      });
      assert.equal(synced.status, 200);
      const result = (await synced.json()) as { updated: number; vault: string };
      assert.equal(result.updated, 1);
      assert.equal(result.vault, "Shared");

      const huge = await app.request("/api/vault/sync", {
        method: "POST",
        headers: { "content-type": "application/json", "x-vault-sync-secret": "test-sync-secret" },
        body: JSON.stringify({
          items: [
            {
              id: "cache-id-2",
              state: "Active",
              content: { title: "small", note: "", content: { Login: { username: "jo" } } },
            },
            {
              id: "cache-id-huge",
              state: "Active",
              content: { title: "huge", note: "x".repeat(200_000), content: {} },
            },
          ],
        }),
      });
      assert.equal(huge.status, 200);
      assert.equal(((await huge.json()) as { updated: number }).updated, 1);
      assert.equal((await authed("/api/vault/items/cache-id-huge", cookie1)).status, 404);
      const restored = await app.request("/api/vault/sync", {
        method: "POST",
        headers: { "content-type": "application/json", "x-vault-sync-secret": "test-sync-secret" },
        body: JSON.stringify({ ...payload, vault: "Evil" }),
      });
      assert.equal(restored.status, 200);

      const status = (await authed("/api/vault/status", cookie1)).json as {
        configured: boolean;
        source: string;
        count: number;
      };
      assert.equal(status.configured, true);
      assert.equal(status.source, "cache");
      assert.equal(status.count, 1);

      const list = (await authed("/api/vault/items", cookie1)).json as {
        vault: string;
        items: Array<{ id: string; title: string }>;
      };
      assert.equal(list.items.length, 1);
      assert.equal(list.items[0].title, "example.com");

      const detail = (await authed("/api/vault/items/cache-id-1", cookie1)).json as {
        fields: { Login: { username: string } };
      };
      assert.equal(detail.fields.Login.username, "sam");

      assert.equal((await authed("/api/vault/items/no-such-id", cookie1)).status, 404);
      assert.equal((await authed("/api/vault/items/trashed-1", cookie1)).status, 404);

      // Wrong cache key: titles list, secrets do not open.
      process.env.VAULT_CACHE_KEY = "wrong-key";
      assert.equal((await authed("/api/vault/items", cookie1)).status, 200);
      assert.equal((await authed("/api/vault/items/cache-id-1", cookie1)).status, 503);
      process.env.VAULT_CACHE_KEY = "test-cache-key";

      // Second household is locked out once the vault is pinned to the first.
      cookieJar.clear();
      assert.equal(
        (
          await api("/api/auth/register", {
            body: {
              householdName: "Other House",
              displayName: "Jo",
              username: "jo_other",
              password: "password1",
            },
          })
        ).status,
        200,
      );
      const cookie2 = cookieHeader();
      process.env.VAULT_HOUSEHOLD_ID = house1;
      try {
        assert.equal((await authed("/api/vault/status", cookie2)).status, 403);
        assert.equal((await authed("/api/vault/items", cookie2)).status, 403);
        assert.equal((await authed("/api/vault/items/cache-id-1", cookie1)).status, 200);
      } finally {
        delete process.env.VAULT_HOUSEHOLD_ID;
      }
      assert.equal((await authed("/api/vault/items", cookie2)).status, 200);
    } finally {
      delete process.env.VAULT_SYNC_SECRET;
      delete process.env.VAULT_CACHE_KEY;
      delete process.env.VAULT_HOUSEHOLD_ID;
    }
  });

  it("register rolls back so a failed attempt leaves no extra household", async () => {
    const dir = mkdtempSync(join(tmpdir(), "basket-rollback-"));
    const inner = await openNodeSql(join(dir, "test.sqlite"));
    const sql: Sql = {
      exec: (q) => inner.exec(q),
      get: (q, ...p) => inner.get(q, ...p),
      all: (q, ...p) => inner.all(q, ...p),
      transaction: (fn) => inner.transaction(fn),
      run: async (q, ...p) => {
        if (q.includes("INSERT INTO sessions")) throw new Error("injected session failure");
        return inner.run(q, ...p);
      },
    };
    const isolated = createApp(() => sql);
    const before = await inner.get<{ n: number }>("SELECT COUNT(*) AS n FROM households");
    const res = await isolated.request("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        householdName: "Rollback House",
        displayName: "Rae",
        username: "rae_rollback",
        password: "password1",
      }),
    });
    assert.equal(res.status, 500);
    const after = await inner.get<{ n: number }>("SELECT COUNT(*) AS n FROM households");
    assert.equal(Number(after?.n ?? 0), Number(before?.n ?? 0));
  });

  it("account email, storage, cloud links, share-via-email", async () => {
    cookieJar.clear();
    const created = await api("/api/auth/register", {
      body: {
        householdName: "Mail House",
        displayName: "Mo",
        username: "mo_mail",
        password: "password1",
      },
    });
    assert.equal(created.status, 200);

    const bad = await api("/api/account", { method: "PATCH", body: { email: "not-an-email" } });
    assert.equal(bad.status, 400);

    const saved = (await api("/api/account", { method: "PATCH", body: { email: "mo@example.com" } })).json as {
      email?: string;
    };
    assert.equal(saved.email, "mo@example.com");
    const boot = (await api("/api/bootstrap")).json as { user: { email?: string } };
    assert.equal(boot.user.email, "mo@example.com");

    const usage = (await api("/api/storage/usage")).json as { files: number; bytes: number };
    assert.equal(usage.files, 0);
    assert.equal(usage.bytes, 0);
    const files = (await api("/api/storage/files")).json as unknown[];
    assert.deepEqual(files, []);

    const unknown = await api("/api/cloud/links", { body: { provider: "geocities" } });
    assert.equal(unknown.status, 400);
    const linked = (await api("/api/cloud/links", { body: { provider: "google" } })).json as {
      provider: string;
      status: string;
    };
    assert.equal(linked.provider, "google");
    assert.equal(linked.status, "pending");
    const links = (await api("/api/cloud/links")).json as Array<{ provider: string }>;
    assert.ok(links.some((l) => l.provider === "google"));
    const unlinked = await api("/api/cloud/links/google", { method: "DELETE" });
    assert.equal(unlinked.status, 204);

    // No SMTP in the test env: configured address, unconfigured transport.
    const item = (
      await api("/api/lists/unknown/items", { body: { name: "x" } })
    );
    assert.equal(item.status, 404);
    const boot2 = (await api("/api/bootstrap")).json as { lists: Array<{ id: string }> };
    const posted = (
      await api(`/api/lists/${boot2.lists[0].id}/items`, { body: { name: "Eggs" } })
    ).json as { id: string };
    const shared = await api("/api/share/email", { body: { itemId: posted.id } });
    assert.equal(shared.status, 503);
    const tested = await api("/api/account/test-email", { method: "POST", body: {} });
    assert.equal(tested.status, 503);

    cookieJar.clear();
    const created2 = await api("/api/auth/register", {
      body: {
        householdName: "No Mail House",
        displayName: "No",
        username: "no_mail",
        password: "password1",
      },
    });
    assert.equal(created2.status, 200);
    const noAddr = await api("/api/account/test-email", { method: "POST", body: {} });
    assert.equal(noAddr.status, 400);
  });
});
