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
  });
});
