import type { Bootstrap, Household, Item, List, Note, Reminder, Suggestion } from "../shared/types.ts";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, opts: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, headers, ...rest } = opts;
  const res = await fetch(path, {
    ...rest,
    credentials: "include",
    headers: {
      ...(json !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(res.status, data.error || "Something went wrong.");
  return data as T;
}

export const api = {
  health: () => request<{ ok: boolean }>("/api/health"),
  bootstrap: () => request<Bootstrap>("/api/bootstrap"),
  register: (body: {
    householdName: string;
    displayName: string;
    username: string;
    password: string;
  }) => request("/api/auth/register", { method: "POST", json: body }),
  join: (body: { inviteCode: string; displayName: string; username: string; password: string }) =>
    request("/api/auth/join", { method: "POST", json: body }),
  login: (body: { username: string; password: string }) =>
    request("/api/auth/login", { method: "POST", json: body }),
  logout: () => request("/api/auth/logout", { method: "POST", json: {} }),
  renameHousehold: (name: string) =>
    request<Household>("/api/household", { method: "PATCH", json: { name } }),
  rotateInvite: () =>
    request<{ inviteCode: string }>("/api/household/invite/rotate", { method: "POST", json: {} }),
  createList: (body: { name: string; emoji: string }) =>
    request<List>("/api/lists", { method: "POST", json: body }),
  updateList: (id: string, body: { name?: string; emoji?: string }) =>
    request<List>(`/api/lists/${id}`, { method: "PATCH", json: body }),
  deleteList: (id: string) => request(`/api/lists/${id}`, { method: "DELETE" }),
  addItem: (
    listId: string,
    body: { name: string; quantity?: string; category?: string; notes?: string },
  ) => request<Item>(`/api/lists/${listId}/items`, { method: "POST", json: body }),
  updateItem: (
    id: string,
    body: Partial<{ name: string; quantity: string; category: string; notes: string; checked: boolean }>,
  ) => request<Item>(`/api/items/${id}`, { method: "PATCH", json: body }),
  deleteItem: (id: string) => request(`/api/items/${id}`, { method: "DELETE" }),
  clearChecked: (listId: string) =>
    request<{ removed: number }>(`/api/lists/${listId}/clear-checked`, { method: "POST", json: {} }),
  suggestions: (q: string) =>
    request<Suggestion[]>(`/api/suggestions?q=${encodeURIComponent(q)}`),
  createReminder: (body: {
    kind: "trip" | "nudge";
    title?: string;
    listId?: string;
    dueAt?: number;
    durationMin?: number;
  }) => request<Reminder>("/api/reminders", { method: "POST", json: body }),
  deleteReminder: (id: string) => request(`/api/reminders/${id}`, { method: "DELETE" }),
  createNote: (body: { title?: string; body?: string }) =>
    request<Note>("/api/notes", { method: "POST", json: body }),
  updateNote: (id: string, body: Partial<{ title: string; body: string }>) =>
    request<Note>(`/api/notes/${id}`, { method: "PATCH", json: body }),
  deleteNote: (id: string) => request(`/api/notes/${id}`, { method: "DELETE" }),
  uploadNoteFile: async (id: string, file: File) => {
    const res = await fetch(`/api/notes/${id}/file`, {
      method: "PUT",
      credentials: "include",
      body: (() => {
        const data = new FormData();
        data.set("file", file);
        return data;
      })(),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new ApiError(res.status, data.error || "Something went wrong.");
    return data as Note;
  },
  deleteNoteFile: (id: string) => request<Note>(`/api/notes/${id}/file`, { method: "DELETE" }),
  noteFileUrl: (id: string, download = false) =>
    `/api/notes/${id}/file${download ? "?download=1" : ""}`,
};
