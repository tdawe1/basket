import { useCallback, useEffect, useRef, useState } from "react";
import {
  buildIcs,
  eventDescription,
  fromLocalInputValue,
  googleCalendarUrl,
  outlookCalendarUrl,
  presetDue,
  toLocalInputValue,
  type DuePreset,
} from "../shared/calendar.ts";
import { CATEGORIES, CATEGORY_IDS, guessCategory, parseQuickAdd } from "../shared/categories.ts";
import type {
  Bootstrap,
  Household,
  Item,
  List,
  Note,
  PublicUser,
  Reminder,
  Section,
  Suggestion,
} from "../shared/types.ts";
import { ApiError, api } from "./api.ts";
import { I18n, detectLang, t, useT, type Lang, type MsgKey } from "./i18n.ts";
import { VaultSection } from "./Vault.tsx";
import { NotesSection } from "./Notes.tsx";
import { CalendarSection } from "./Calendar.tsx";
import { StorageSection } from "./Storage.tsx";
import { downloadIcs, loadSeenReminders, markReminderSeen, requestNotifyPermission, showAppNotification } from "./notify.ts";

const THEMES = ["system", "light", "dark", "ocean", "sunset", "forest"] as const;
type Theme = (typeof THEMES)[number];
type AuthTab = "login" | "create" | "join";

const THEME_META: Record<Exclude<Theme, "system">, { tone: "light" | "dark"; color: string }> = {
  light: { tone: "light", color: "#f3eee4" },
  dark: { tone: "dark", color: "#161310" },
  ocean: { tone: "dark", color: "#0f1b26" },
  sunset: { tone: "light", color: "#fbf0e4" },
  forest: { tone: "dark", color: "#101a12" },
};

const LIST_EMOJIS = ["🛒", "🏠", "🛠️", "💊", "🎁", "🐾", "🧴", "🧺", "📦", "🎄"];

function applyTheme(theme: Theme) {
  const resolved: Exclude<Theme, "system"> =
    theme === "system" ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : theme;
  const meta = THEME_META[resolved];
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.tone = meta.tone;
  const tag = document.querySelector('meta[name="theme-color"]');
  if (tag) tag.setAttribute("content", meta.color);
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

function formatDue(ms: number, lang: Lang): string {
  return new Date(ms).toLocaleString(lang === "ja" ? "ja-JP" : "en-GB", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function upcomingTrips(reminders: Reminder[]): Reminder[] {
  const cutoff = Date.now() - 30 * 60_000;
  return reminders
    .filter((r) => (r.kind === "trip" || r.kind === "item") && r.dueAt > cutoff)
    .sort((a, b) => a.dueAt - b.dueAt);
}

type Toast = { msg: string; undo?: () => void };

function useToast() {
  const [toast, setToast] = useState<Toast | null>(null);
  const timer = useRef<number>(0);
  const show = useCallback((msg: string, undo?: () => void) => {
    setToast({ msg, undo });
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setToast(null), undo ? 6000 : 2200);
  }, []);
  const clear = useCallback(() => {
    window.clearTimeout(timer.current);
    setToast(null);
  }, []);
  return { toast, show, clear };
}

export function App() {
  const [lang, setLangState] = useState<Lang>(() => detectLang());
  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    localStorage.setItem("basket-lang", next);
    document.documentElement.lang = next === "ja" ? "ja" : "en";
  }, []);
  useEffect(() => {
    document.documentElement.lang = lang === "ja" ? "ja" : "en";
  }, [lang]);

  const [theme, setTheme] = useState<Theme>(() => {
    const saved = localStorage.getItem("basket-theme");
    return (THEMES as readonly string[]).includes(saved ?? "") ? (saved as Theme) : "system";
  });
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<PublicUser | null>(null);
  const [household, setHousehold] = useState<Household | null>(null);
  const [lists, setLists] = useState<List[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [activeListId, setActiveListId] = useState<string | null>(null);
  const [online, setOnline] = useState<string[]>([]);
  const { toast, show, clear } = useToast();
  const seenReminders = useRef<Set<string>>(loadSeenReminders());

  useEffect(() => {
    applyTheme(theme);
    localStorage.setItem("basket-theme", theme);
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme(theme);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  const load = useCallback(async () => {
    try {
      const data = await api.bootstrap();
      applyState(data);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setUser(null);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  function applyState(data: Bootstrap) {
    setUser(data.user);
    setHousehold(data.household);
    setLists(data.lists);
    setItems(data.items);
    setSections(data.sections ?? []);
    setReminders(data.reminders ?? []);
    setNotes(data.notes ?? []);
    setActiveListId((current) => {
      if (current && data.lists.some((l) => l.id === current)) return current;
      return data.lists[0]?.id ?? null;
    });
    setOnline(data.household.members.filter((m) => m.online).map((m) => m.id));
  }

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!user) return;
    const tick = () => {
      if (document.visibilityState === "visible") load();
    };
    const id = window.setInterval(tick, 2500);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [user, load]);

  useEffect(() => {
    if (!user) return;
    const next = reminders
      .filter((r) => (r.kind === "trip" || r.kind === "item") && r.dueAt > Date.now())
      .sort((a, b) => a.dueAt - b.dueAt)[0];
    if (!next) return;
    const delay = Math.min(Math.max(next.dueAt - Date.now() + 80, 0), 2_147_000_000);
    const id = window.setTimeout(() => {
      void load();
    }, delay);
    return () => window.clearTimeout(id);
  }, [reminders, user, load]);

  useEffect(() => {
    if (!user) return;
    const seen = seenReminders.current;
    const now = Date.now();
    for (const reminder of reminders) {
      if (seen.has(reminder.id)) continue;
      const list = lists.find((l) => l.id === reminder.listId);
      const listLabel = list ? `${list.emoji} ${list.name}` : reminder.title;
      const count = items.filter((i) => (!reminder.listId || i.listId === reminder.listId) && !i.checked).length;
      if (reminder.kind === "nudge") {
        if (reminder.createdBy.id === user.id) {
          seen.add(reminder.id);
          markReminderSeen(reminder.id);
          continue;
        }
        if (now - reminder.createdAt > 15 * 60_000) continue;
        seen.add(reminder.id);
        markReminderSeen(reminder.id);
        const body =
          count > 0
            ? t(lang, "nudgeBody", { name: reminder.createdBy.displayName, list: listLabel, count })
            : t(lang, "nudgeBodyEmpty", { name: reminder.createdBy.displayName, list: listLabel });
        void showAppNotification("Basket", body, reminder.id);
        show(body);
        continue;
      }
      if (now < reminder.dueAt) continue;
      seen.add(reminder.id);
      markReminderSeen(reminder.id);
      const title = reminder.kind === "item" ? reminder.title : t(lang, "tripNotifyTitle");
      const body =
        reminder.kind === "item"
          ? t(lang, "itemNotifyBody", { title: reminder.title, list: listLabel })
          : t(lang, "tripNotifyBody", { list: listLabel, count });
      void showAppNotification(title, body, reminder.id);
      show(body);
    }
  }, [reminders, user, items, lists, lang, show]);
  const inner = (() => {
  if (loading) {
    return (
      <div className="phone">
        <div className="splash">
          <img className="brand-mark" src="/icon-192.png" alt="" />
          <div className="wordmark">Basket</div>
        </div>
      </div>
    );
  }

  if (!user || !household) {
    return (
      <div className="phone">
        <AuthScreen onAuthed={load} />
      </div>
    );
  }

  const activeList = lists.find((l) => l.id === activeListId) ?? lists[0];

  return (
    <div className="phone authed">
      <Home
        user={user}
        household={household}
        lists={lists}
        items={items}
        sections={sections}
        reminders={reminders}
        notes={notes}
        online={online}
        activeList={activeList}
        theme={theme}
        setTheme={setTheme}
        onSelectList={(id) => setActiveListId(id)}
        onToast={show}
        onPatchItems={setItems}
        onLogout={async () => {
          await api.logout();
          setUser(null);
          setHousehold(null);
          setReminders([]);
          setNotes([]);
        }}
        onHousehold={(h) => setHousehold(h)}
        onRefresh={load}
      />
      {toast && (
        <div className="toast">
          <span>{toast.msg}</span>
          {toast.undo && (
            <button
              type="button"
              className="toast-undo"
              onClick={() => {
                const run = toast.undo;
                clear();
                run?.();
              }}
            >
              {t(lang, "undo")}
            </button>
          )}
        </div>
      )}
    </div>
  );
  })();

  return <I18n.Provider value={{ lang, setLang }}>{inner}</I18n.Provider>;
}

function AuthScreen({ onAuthed }: { onAuthed: () => Promise<void> }) {
  const { t, err, setLang, lang } = useT();
  const [tab, setTab] = useState<AuthTab>("create");
  const [error, setError] = useState<string | null>(() => {
    const code = new URLSearchParams(window.location.search).get("oauth_error");
    if (!code) return null;
    window.history.replaceState(null, "", window.location.pathname);
    return code;
  });
  const [busy, setBusy] = useState(false);
  const [resetMode, setResetMode] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [freshCodes, setFreshCodes] = useState<string[] | null>(null);
  const [providers, setProviders] = useState<{ google: boolean; apple: boolean } | null>(null);

  useEffect(() => {
    api.oauthProviders().then(setProviders).catch(() => setProviders(null));
  }, []);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const data = new FormData(e.currentTarget);
    try {
      if (resetMode) {
        const res = await api.recover({
          username: String(data.get("username") ?? ""),
          code: String(data.get("recoveryCode") ?? ""),
          password: String(data.get("password") ?? ""),
        });
        setFreshCodes(res.recoveryCodes);
        setResetMode(false);
        return;
      }
      if (tab === "login") {
        await api.login({
          username: String(data.get("username") ?? ""),
          password: String(data.get("password") ?? ""),
        });
      } else if (tab === "create") {
        const res = await api.register({
          householdName: String(data.get("householdName") ?? ""),
          displayName: String(data.get("displayName") ?? ""),
          username: String(data.get("username") ?? ""),
          password: String(data.get("password") ?? ""),
        });
        if (res.recoveryCodes.length) {
          setFreshCodes(res.recoveryCodes);
          return;
        }
      } else {
        const res = await api.join({
          inviteCode: String(data.get("inviteCode") ?? ""),
          displayName: String(data.get("displayName") ?? ""),
          username: String(data.get("username") ?? ""),
          password: String(data.get("password") ?? ""),
        });
        if (res.recoveryCodes.length) {
          setFreshCodes(res.recoveryCodes);
          return;
        }
      }
      await onAuthed();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("continueError"));
    } finally {
      setBusy(false);
    }
  }

  async function startOAuth(provider: "google" | "apple", form: HTMLFormElement | null) {
    const data = new FormData(form ?? undefined);
    setError(null);
    setBusy(true);
    try {
      const res = await api.oauthStart({
        provider,
        mode: tab === "login" ? "login" : tab === "create" ? "create" : "join",
        householdName: String(data.get("householdName") ?? ""),
        displayName: String(data.get("displayName") ?? ""),
        inviteCode: String(data.get("inviteCode") ?? ""),
      });
      window.location.href = res.url;
    } catch (e) {
      setError(e instanceof Error ? e.message : t("continueError"));
      setBusy(false);
    }
  }

  async function copyCodes(codes: string[]) {
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
      setNotice(t("codesCopied"));
    } catch {
      setError(t("copyFailed"));
    }
  }

  if (freshCodes) {
    return (
      <div className="auth">
        <img className="brand-mark" src="/icon-192.png" alt="" />
        <h1 className="wordmark">Basket</h1>
        <p className="lede">{t("lede")}</p>
        <div className="auth-card">
          <h2>{t("recoveryCodesTitle")}</h2>
          <p className="muted">{t("recoveryCodesIntro")}</p>
          <ul className="codes">
            {freshCodes.map((code) => (
              <li key={code}>
                <code>{code}</code>
              </li>
            ))}
          </ul>
          {notice && <div className="muted">{notice}</div>}
          {error && <div className="error">{err(error)}</div>}
          <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
            <button type="button" className="btn ghost block" onClick={() => copyCodes(freshCodes)}>
              {t("copyAll")}
            </button>
            <button type="button" className="btn block" onClick={() => onAuthed()}>
              {t("codesSavedContinue")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="auth">
      <img className="brand-mark" src="/icon-192.png" alt="" />
      <h1 className="wordmark">Basket</h1>
      <p className="lede">{t("lede")}</p>
      <form className="auth-card" onSubmit={submit}>
        <div className="tabs">
          {(["create", "join", "login"] as AuthTab[]).map((id) => (
            <button
              key={id}
              type="button"
              className={tab === id ? "active" : ""}
              onClick={() => {
                setTab(id);
                setError(null);
              }}
            >
              {id === "create" ? t("start") : id === "join" ? t("join") : t("signIn")}
            </button>
          ))}
        </div>
        {tab === "create" && (
          <label>
            {t("householdName")}
            <input name="householdName" autoComplete="organization" placeholder={t("householdNamePh")} required />
          </label>
        )}
        {tab === "join" && (
          <label>
            {t("inviteCode")}
            <input name="inviteCode" placeholder="K7M2-QP9R" autoCapitalize="characters" required />
          </label>
        )}
        {tab !== "login" && (
          <label>
            {t("yourName")}
            <input name="displayName" autoComplete="name" placeholder="Alex" required />
          </label>
        )}
        <div className="row-2">
          <label>
            {t("username")}
            <input name="username" autoComplete="username" placeholder="alex" required />
          </label>
          <label>
            {resetMode ? t("newPassword") : t("password")}
            <input name="password" type="password" autoComplete={tab === "login" && !resetMode ? "current-password" : "new-password"} required />
          </label>
        </div>
        {tab === "login" && !resetMode && (
          <button
            type="button"
            className="btn small ghost"
            style={{ marginTop: 8 }}
            onClick={() => {
              setResetMode(true);
              setError(null);
              setNotice(null);
            }}
          >
            {t("forgotPassword")}
          </button>
        )}
        {resetMode && (
          <>
            <label>
              {t("recoveryCode")}
              <input name="recoveryCode" autoComplete="off" required />
            </label>
            <p className="muted">{t("recoveryHint")}</p>
            <button
              type="button"
              className="btn small ghost"
              style={{ marginTop: 8 }}
              onClick={() => {
                setResetMode(false);
                setError(null);
              }}
            >
              {t("backToSignIn")}
            </button>
          </>
        )}
        {notice && <div className="muted">{notice}</div>}
        {error && <div className="error">{err(error)}</div>}
        <button className="btn block" disabled={busy}>
          {busy ? t("oneMoment") : resetMode ? t("resetPassword") : tab === "login" ? t("signIn") : tab === "join" ? t("joinHousehold") : t("createHousehold")}
        </button>
        {!resetMode && providers && (providers.google || providers.apple) && (
          <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
            {providers.google && (
              <button
                type="button"
                className="btn ghost block"
                disabled={busy}
                onClick={(e) => startOAuth("google", e.currentTarget.form)}
              >
                {t("oauthGoogle")}
              </button>
            )}
            {providers.apple && (
              <button
                type="button"
                className="btn ghost block"
                disabled={busy}
                onClick={(e) => startOAuth("apple", e.currentTarget.form)}
              >
                {t("oauthApple")}
              </button>
            )}
          </div>
        )}
        <div className="lang-row" style={{ marginTop: 12, marginBottom: 0 }}>
          <button type="button" className={`btn small ${lang === "en" ? "" : "ghost"}`} onClick={() => setLang("en")}>
            {t("english")}
          </button>
          <button type="button" className={`btn small ${lang === "ja" ? "" : "ghost"}`} onClick={() => setLang("ja")}>
            {t("japanese")}
          </button>
        </div>
      </form>
    </div>
  );
}

function Home({
  user,
  household,
  lists,
  items,
  sections,
  reminders,
  notes,
  online,
  activeList,
  theme,
  setTheme,
  onSelectList,
  onToast,
  onPatchItems,
  onLogout,
  onHousehold,
  onRefresh,
}: {
  user: PublicUser;
  household: Household;
  lists: List[];
  items: Item[];
  sections: Section[];
  reminders: Reminder[];
  notes: Note[];
  online: string[];
  activeList?: List;
  theme: Theme;
  setTheme: (t: Theme) => void;
  onSelectList: (id: string) => void;
  onToast: (s: string, undo?: () => void) => void;
  onPatchItems: (fn: (items: Item[]) => Item[]) => void;
  onLogout: () => Promise<void>;
  onHousehold: (h: Household) => void;
  onRefresh: () => Promise<void>;
}) {
  const { t, err, lang } = useT();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [remindOpen, setRemindOpen] = useState(false);
  const [newListOpen, setNewListOpen] = useState(false);
  const [editing, setEditing] = useState<Item | null>(null);
  const [section, setSection] = useState<"shop" | "notes" | "vault" | "calendar" | "storage">("shop");
  const [activeNoteId, setActiveNoteId] = useState<string | null>(notes[0]?.id ?? null);
  const listItems = items.filter((i) => activeList && i.listId === activeList.id);
  const listSections = sections.filter((s) => activeList && s.listId === activeList.id);
  const members = household.members.map((m) => ({ ...m, online: online.includes(m.id) }));
  const trips = upcomingTrips(reminders);
  const nextTrip = trips[0];
  const remindBadge =
    trips.some((r) => r.dueAt > Date.now() - 30 * 60_000) ||
    reminders.some((r) => r.kind === "nudge" && Date.now() - r.createdAt < 15 * 60_000 && r.createdBy.id !== user.id);

  async function removeList(list: List) {
    if (!confirm(t("deleteListConfirm", { name: list.name }))) return;
    try {
      await api.deleteList(list.id);
      await onRefresh();
      onToast(t("listDeleted"));
      setSettingsOpen(false);
    } catch (error) {
      onToast(error instanceof Error ? err(error.message) : t("cannotUpdate"));
    }
  }

  return (
    <>
      <div className="app-frame">
        <header className="topbar">
          <h1>Basket</h1>
          <div className="presence">
            <div className="avatars">
              {members.map((m) => (
                <span key={m.id} className="avatar" style={{ background: m.color }} title={m.displayName}>
                  {initials(m.displayName)}
                </span>
              ))}
            </div>
            {members.filter((m) => m.online).length > 1 && <span className="online-dot" title={t("bothHere")} />}
          </div>
          <button className="icon-btn" aria-label={t("remind")} onClick={() => setRemindOpen(true)}>
            <Bell />
            {remindBadge && <span className="badge-dot" />}
          </button>
          <button className="icon-btn" aria-label={t("settings")} onClick={() => setSettingsOpen(true)}>
            <Gear />
          </button>
        </header>
        <nav className="main-tabs" aria-label="Sections">
          <button
            type="button"
            className={`main-tab${section === "shop" ? " active" : ""}`}
            onClick={() => setSection("shop")}
          >
            🧺 {t("tabLists")}
          </button>
          <button
            type="button"
            className={`main-tab${section === "notes" ? " active" : ""}`}
            onClick={() => setSection("notes")}
          >
            📝 {t("notesSection")}
          </button>
          <button
            type="button"
            className={`main-tab${section === "vault" ? " active" : ""}`}
            onClick={() => setSection("vault")}
          >
            🔑 {t("vaultSection")}
          </button>
          <button
            type="button"
            className={`main-tab${section === "calendar" ? " active" : ""}`}
            onClick={() => setSection("calendar")}
          >
            📅 {t("calendarSection")}
          </button>
          <button
            type="button"
            className={`main-tab${section === "storage" ? " active" : ""}`}
            onClick={() => setSection("storage")}
          >
            ☁️ {t("storageSection")}
          </button>
        </nav>

        <nav className="list-tabs">
          {lists.map((list) => (
            <button
              key={list.id}
              className={`chip ${section === "shop" && activeList?.id === list.id ? "active" : ""}`}
              onClick={() => {
                setSection("shop");
                onSelectList(list.id);
              }}
            >
              {list.emoji} {list.name}
              {activeList?.id === list.id && (
                <span
                  className="chip-x"
                  role="button"
                  aria-label={t("deleteList")}
                  onClick={(e) => {
                    e.stopPropagation();
                    removeList(list);
                  }}
                >
                  ×
                </span>
              )}
            </button>
          ))}
          <button className="chip add" onClick={() => setNewListOpen(true)}>
            {t("addList")}
          </button>
          <div className="side-notes">
            <div className="group-label">{t("notesSection")}</div>
            {notes.map((note) => (
              <button
                key={note.id}
                type="button"
                className={`chip ${section === "notes" && activeNoteId === note.id ? "active" : ""}`}
                onClick={() => {
                  setSection("notes");
                  setActiveNoteId(note.id);
                }}
              >
                {note.fileMime === "application/pdf" ? "📄" : note.fileMime?.startsWith("image/") ? "🖼️" : "📝"}{" "}
                {note.title || t("untitledNote")}
              </button>
            ))}
            <button
              type="button"
              className="chip add"
              onClick={async () => {
                try {
                  const note = await api.createNote({ title: t("untitledNote"), body: "" });
                  setSection("notes");
                  setActiveNoteId(note.id);
                  await onRefresh();
                } catch (error) {
                  onToast(error instanceof Error ? err(error.message) : t("cannotSave"));
                }
              }}
            >
              {t("addNote")}
            </button>
            <button
              type="button"
              className={`chip ${section === "vault" ? "active" : ""}`}
              onClick={() => setSection("vault")}
            >
              🔑 {t("vaultSection")}
            </button>
          </div>
          {trips.length > 0 && (
            <div className="side-upcoming">
              <div className="group-label">{t("upcoming")}</div>
              {trips.slice(0, 4).map((trip) => (
                <button key={trip.id} type="button" className="upcoming-row" onClick={() => setRemindOpen(true)}>
                  <div>
                    <strong>{trip.title}</strong>
                    <div className="muted">{formatDue(trip.dueAt, lang)}</div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </nav>

        <div className="workspace">
          {section === "notes" ? (
            <NotesSection
              notes={notes}
              activeNoteId={activeNoteId}
              onSelect={setActiveNoteId}
              onToast={onToast}
              onRefresh={onRefresh}
            />
          ) : section === "vault" ? (
            <VaultSection onToast={onToast} />
          ) : section === "calendar" ? (
            <CalendarSection reminders={reminders} />
          ) : section === "storage" ? (
            <StorageSection onToast={onToast} />
          ) : (
            <>
              {nextTrip && (
                <button type="button" className="remind-banner" onClick={() => setRemindOpen(true)}>
                  <span>{nextTrip.title}</span>
                  <span className="muted">{formatDue(nextTrip.dueAt, lang)}</span>
                </button>
              )}
              {activeList ? (
                <ListBody
                  items={listItems}
                  sections={listSections}
                  onToast={onToast}
                  onAddSection={async (name) => {
                    if (!activeList) return;
                    try {
                      await api.createSection(activeList.id, { name });
                      await onRefresh();
                    } catch (error) {
                      onToast(error instanceof Error ? err(error.message) : t("cannotUpdate"));
                    }
                  }}
                  onRenameSection={async (id, name) => {
                    try {
                      await api.updateSection(id, { name });
                      await onRefresh();
                    } catch (error) {
                      onToast(error instanceof Error ? err(error.message) : t("cannotUpdate"));
                    }
                  }}
                  onDeleteSection={async (id) => {
                    try {
                      await api.deleteSection(id);
                      await onRefresh();
                    } catch (error) {
                      onToast(error instanceof Error ? err(error.message) : t("cannotUpdate"));
                    }
                  }}
                  onToggle={async (item) => {
                    const previous = item;
                    const nextChecked = !item.checked;
                    onPatchItems((current) =>
                      current.map((row) =>
                        row.id === item.id
                          ? { ...row, checked: nextChecked, checkedBy: nextChecked ? user : null }
                          : row,
                      ),
                    );
                    try {
                      if (navigator.vibrate) navigator.vibrate(8);
                      const updated = await api.updateItem(item.id, { checked: nextChecked });
                      onPatchItems((current) => current.map((row) => (row.id === updated.id ? updated : row)));
                    } catch (error) {
                      onPatchItems((current) => current.map((row) => (row.id === previous.id ? previous : row)));
                      onToast(error instanceof Error ? err(error.message) : t("cannotUpdate"));
                    }
                  }}
                  onEdit={setEditing}
                  onClear={async () => {
                    if (!activeList) return;
                    const snapshot = listItems.filter((row) => row.checked);
                    if (snapshot.length === 0) return;
                    const listId = activeList.id;
                    onPatchItems((current) => current.filter((row) => row.listId !== listId || !row.checked));
                    try {
                      await api.clearChecked(listId);
                      onToast(t("checkedCleared"), async () => {
                        try {
                          for (const row of snapshot) {
                            const created = await api.addItem(listId, {
                              name: row.name,
                              quantity: row.quantity,
                              category: row.category,
                              notes: row.notes,
                              sectionId: row.sectionId,
                            });
                            if (row.checked) await api.updateItem(created.id, { checked: true });
                          }
                          await onRefresh();
                        } catch (error) {
                          onToast(error instanceof Error ? err(error.message) : t("cannotUpdate"));
                        }
                      });
                    } catch (error) {
                      onPatchItems((current) => [...current, ...snapshot]);
                      onToast(error instanceof Error ? err(error.message) : t("cannotUpdate"));
                    }
                  }}
                />
              ) : (
                <div className="list-body empty">
                  <h2>{t("noLists")}</h2>
                  <p>{t("noListsHint")}</p>
                </div>
              )}

              {activeList && (
                <AddDock
                  listId={activeList.id}
                  onToast={onToast}
                  onAdded={onRefresh}
                />
              )}
            </>
          )}
        </div>
      </div>

      {remindOpen && (
        <RemindSheet
          list={activeList}
          lists={lists}
          items={items}
          reminders={reminders}
          onClose={() => setRemindOpen(false)}
          onToast={onToast}
          onRefresh={onRefresh}
        />
      )}
      {settingsOpen && (
        <SettingsSheet
          household={household}
          members={members}
          user={user}
          lists={lists}
          activeList={activeList}
          theme={theme}
          setTheme={setTheme}
          onClose={() => setSettingsOpen(false)}
          onToast={onToast}
          onLogout={onLogout}
          onHousehold={onHousehold}
          onRefresh={onRefresh}
          onDeleteList={removeList}
        />
      )}
      {newListOpen && (
        <NewListSheet
          onClose={() => setNewListOpen(false)}
          onCreated={async (list) => {
            onSelectList(list.id);
            setNewListOpen(false);
            await onRefresh();
          }}
          onToast={onToast}
        />
      )}
      {editing && (
        <EditItemSheet
          item={editing}
          sections={sections.filter((s) => s.listId === editing.listId)}
          itemReminder={reminders.find((r) => r.kind === "item" && r.itemId === editing.id) ?? null}
          onSetReminder={async (dueAt) => {
            try {
              await api.createReminder({ kind: "item", itemId: editing.id, dueAt });
              onToast(t("reminderSet"));
              await onRefresh();
            } catch (error) {
              onToast(error instanceof Error ? err(error.message) : t("cannotRemind"));
            }
          }}
          onClearReminder={async () => {
            const current = reminders.find((r) => r.kind === "item" && r.itemId === editing.id);
            if (!current) return;
            try {
              await api.deleteReminder(current.id);
              onToast(t("reminderRemoved"));
              await onRefresh();
            } catch (error) {
              onToast(error instanceof Error ? err(error.message) : t("cannotRemind"));
            }
          }}
          onClose={() => setEditing(null)}
          onToast={onToast}
          onRefresh={onRefresh}
        />
      )}
    </>
  );
}

function ItemGroups({
  items,
  onToggle,
  onEdit,
  onToast,
}: {
  items: Item[];
  onToggle: (item: Item) => void;
  onEdit: (item: Item) => void;
  onToast: (s: string) => void;
}) {
  const { tCat } = useT();
  const groups = CATEGORIES.map((cat) => ({
    cat,
    items: items.filter((i) => (CATEGORY_IDS.has(i.category) ? i.category : "other") === cat.id),
  })).filter((g) => g.items.length > 0);
  return (
    <>
      {groups.map((group) => (
        <section key={group.cat.id}>
          <div className="group-label">
            <span>{group.cat.emoji}</span> {tCat(group.cat.id)}
          </div>
          {group.items.map((item, idx) => (
            <ItemRow
              key={item.id}
              item={item}
              start={idx === 0}
              end={idx === group.items.length - 1}
              onToggle={() => onToggle(item)}
              onEdit={() => onEdit(item)}
              onToast={onToast}
            />
          ))}
        </section>
      ))}
    </>
  );
}
function SectionBlock({
  section,
  items,
  onToggle,
  onEdit,
  onToast,
  onRenameSection,
  onDeleteSection,
}: {
  section: Section;
  items: Item[];
  onToggle: (item: Item) => void;
  onEdit: (item: Item) => void;
  onToast: (s: string) => void;
  onRenameSection: (id: string, name: string) => Promise<void>;
  onDeleteSection: (id: string) => Promise<void>;
}) {
  const { t } = useT();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(section.name);
  return (
    <section className="shop-section">
      <div className="group-label section-head">
        {renaming ? (
          <form
            className="section-rename"
            onSubmit={async (e) => {
              e.preventDefault();
              const next = name.trim();
              if (next && next !== section.name) await onRenameSection(section.id, next);
              setRenaming(false);
            }}
          >
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={40}
            />
            <button type="submit" className="btn small">
              {t("save")}
            </button>
          </form>
        ) : (
          <>
            <span>🗂️ {section.name}</span>
            <span className="section-actions">
              <button type="button" className="icon-btn" aria-label={t("rename")} onClick={() => { setName(section.name); setRenaming(true); }}>
                <Pencil />
              </button>
              <button
                type="button"
                className="icon-btn"
                aria-label={t("remove")}
                onClick={() => {
                  if (confirm(t("removeSectionConfirm", { name: section.name }))) void onDeleteSection(section.id);
                }}
              >
                ×
              </button>
            </span>
          </>
        )}
      </div>
      <ItemGroups items={items} onToggle={onToggle} onEdit={onEdit} onToast={onToast} />
    </section>
  );
}

function ListBody({
  items,
  sections,
  onToggle,
  onEdit,
  onToast,
  onClear,
  onAddSection,
  onRenameSection,
  onDeleteSection,
}: {
  items: Item[];
  sections: Section[];
  onToggle: (item: Item) => void;
  onEdit: (item: Item) => void;
  onToast: (s: string) => void;
  onClear: () => void;
  onAddSection: (name: string) => Promise<void>;
  onRenameSection: (id: string, name: string) => Promise<void>;
  onDeleteSection: (id: string) => Promise<void>;
}) {
  const { t, tCat } = useT();
  const [addingSection, setAddingSection] = useState(false);
  const [sectionName, setSectionName] = useState("");
  const unchecked = items.filter((i) => !i.checked);
  const checked = items.filter((i) => i.checked);
  const loose = unchecked.filter((i) => !i.sectionId);
  const blocks = sections.map((s) => ({
    section: s,
    items: unchecked.filter((i) => i.sectionId === s.id),
  }));

  if (items.length === 0 && sections.length === 0) {
    return (
      <div className="list-body">
        <div className="empty">
          <h2>{t("listEmpty")}</h2>
          <p>{t("listEmptyHint")}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="list-body">
      <ItemGroups items={loose} onToggle={onToggle} onEdit={onEdit} onToast={onToast} />
      {blocks.map((block) => (
        <SectionBlock
          key={block.section.id}
          section={block.section}
          items={block.items}
          onToggle={onToggle}
          onEdit={onEdit}
          onToast={onToast}
          onRenameSection={onRenameSection}
          onDeleteSection={onDeleteSection}
        />
      ))}
      {checked.length > 0 && (
        <section>
          <div className="group-label checked-head">
            <span>{t("checked")} · {checked.length}</span>
            <button className="btn ghost small" onClick={onClear}>
              {t("clear")}
            </button>
          </div>
          {checked.map((item, idx) => (
            <ItemRow
              key={item.id}
              item={item}
              start={idx === 0}
              end={idx === checked.length - 1}
              onToggle={() => onToggle(item)}
              onEdit={() => onEdit(item)}
              onToast={onToast}
            />
          ))}
        </section>
      )}
      {addingSection ? (
        <form
          className="section-add"
          onSubmit={async (e) => {
            e.preventDefault();
            const name = sectionName.trim();
            if (!name) return;
            await onAddSection(name);
            setSectionName("");
            setAddingSection(false);
          }}
        >
          <input
            className="input"
            value={sectionName}
            onChange={(e) => setSectionName(e.target.value)}
            placeholder={t("subsectionPh")}
            maxLength={40}
          />
          <button type="submit" className="btn small">
            {t("add")}
          </button>
          <button type="button" className="btn small ghost" onClick={() => setAddingSection(false)}>
            {t("cancel")}
          </button>
        </form>
      ) : (
        <button type="button" className="btn ghost small" onClick={() => setAddingSection(true)}>
          {t("addSubsection")}
        </button>
      )}
    </div>
  );
}

function ItemMenu({
  item,
  x,
  y,
  onClose,
  onToast,
  onRemind,
}: {
  item: Item;
  x: number;
  y: number;
  onClose: () => void;
  onToast: (s: string) => void;
  onRemind: () => void;
}) {
  const { t, err } = useT();
  const [calOpen, setCalOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const style = {
    left: Math.max(8, Math.min(x, window.innerWidth - 230)),
    top: Math.max(8, Math.min(y, window.innerHeight - 230)),
  };
  function saveIcs(preset: DuePreset) {
    const start = presetDue(preset);
    const description = [item.quantity, item.notes].filter(Boolean).join(" · ");
    downloadIcs("basket-item", buildIcs({
      uid: `${item.id}@basket`,
      title: `Buy ${item.name}`,
      description,
      start,
      end: start + 60 * 60 * 1000,
    }));
    onToast(t("icsSaved"));
    onClose();
  }
  function sendEmail() {
    const subject = `Shopping: ${item.name}`;
    const body = [`${item.quantity ? `${item.quantity} × ` : ""}${item.name}`, item.notes]
      .filter(Boolean)
      .join("\n");
    window.location.href = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    onClose();
  }
  async function sendServerEmail() {
    try {
      const res = await api.shareEmail({ itemId: item.id });
      onToast(t("sentToEmail", { to: res.to }));
    } catch (error) {
      onToast(error instanceof Error ? err(error.message) : t("cannotSend"));
    }
    onClose();
  }
  return (
    <>
      <div
        className="menu-backdrop"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <div className="item-menu" style={style} role="menu">
        {!calOpen ? (
          <>
            <button type="button" onClick={() => { onRemind(); onClose(); }}>
              🔔 {t("setReminder")}
            </button>
            <button type="button" onClick={() => setCalOpen(true)}>
              📅 {t("addToCalendar")}
            </button>
            <button type="button" onClick={sendEmail}>
              ✉️ {t("emailItem")}
            </button>
            <button type="button" onClick={() => void sendServerEmail()}>
              📨 {t("sendToMyEmail")}
            </button>
          </>
        ) : (
          <>
            <button type="button" onClick={() => saveIcs("evening")}>
              {t("thisEvening")}
            </button>
            <button type="button" onClick={() => saveIcs("tomorrow")}>
              {t("tomorrowMorning")}
            </button>
            <button type="button" onClick={() => saveIcs("saturday")}>
              {t("saturdayMorning")}
            </button>
          </>
        )}
      </div>
    </>
  );
}

function ItemRow({
  item,
  start,
  end,
  onToggle,
  onEdit,
  onToast,
}: {
  item: Item;
  start: boolean;
  end: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onToast: (s: string) => void;
}) {
  const { t } = useT();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const pressTimer = useRef(0);
  const cls = [
    "item",
    item.checked ? "checked" : "",
    start && end ? "alone" : start ? "group-start" : end ? "group-end" : "",
  ]
    .filter(Boolean)
    .join(" ");
  function cancelPress() {
    window.clearTimeout(pressTimer.current);
  }
  return (
    <div
      className={cls}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
      onTouchStart={(e) => {
        cancelPress();
        const touch = e.touches[0];
        pressTimer.current = window.setTimeout(() => {
          if (navigator.vibrate) navigator.vibrate(8);
          setMenu({ x: touch.clientX, y: touch.clientY });
        }, 550);
      }}
      onTouchEnd={cancelPress}
      onTouchMove={cancelPress}
    >
      <button type="button" className="icon-btn" onClick={onToggle} aria-label={item.checked ? t("uncheck") : t("check")}>
        <span className="check">{item.checked ? "✓" : ""}</span>
      </button>
      <button
        type="button"
        onClick={onToggle}
        style={{ background: "none", border: 0, textAlign: "left", padding: 0 }}
      >
        <div className="name">{item.name}</div>
        <div className="meta">
          {item.notes && <span>{item.notes}</span>}
          <span className="avatar sm" style={{ background: item.addedBy.color }}>
            {initials(item.addedBy.displayName)}
          </span>
          {item.checked && item.checkedBy && <span>{t("gotBy", { name: item.checkedBy.displayName })}</span>}
        </div>
      </button>
      <button type="button" className="icon-btn qty-edit" onClick={onEdit} aria-label={t("edit")}>
        {item.quantity ? <span className="qty">{item.quantity}</span> : <Pencil />}
      </button>
      {menu && (
        <ItemMenu item={item} x={menu.x} y={menu.y} onClose={() => setMenu(null)} onToast={onToast} onRemind={() => onEdit()} />
      )}
    </div>
  );
}

function AddDock({
  listId,
  onToast,
  onAdded,
}: {
  listId: string;
  onToast: (s: string) => void;
  onAdded: () => Promise<void>;
}) {
  const { t, err, tCat } = useT();
  const [name, setName] = useState("");
  const [qty, setQty] = useState("");
  const [hints, setHints] = useState<Suggestion[]>([]);
  const [cat, setCat] = useState<string>("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const q = name.trim();
    const timer = window.setTimeout(() => {
      api.suggestions(q).then(setHints).catch(() => setHints([]));
    }, 120);
    return () => window.clearTimeout(timer);
  }, [name]);

  async function add(rawName = name, rawQty = qty, rawCat = cat) {
    const parsed = parseQuickAdd(rawName);
    const itemName = parsed.name;
    if (!itemName) return;
    const quantity = rawQty || parsed.quantity;
    const category = rawCat || guessCategory(itemName);
    try {
      await api.addItem(listId, { name: itemName, quantity, category });
      setName("");
      setQty("");
      setCat("");
      await onAdded();
      inputRef.current?.focus();
    } catch (error) {
      onToast(error instanceof Error ? err(error.message) : t("cannotAdd"));
    }
  }

  return (
    <form
      className="add-dock"
      onSubmit={(e) => {
        e.preventDefault();
        add();
      }}
    >
      {hints.length > 0 && (name.trim() || true) && (
        <div className="suggest">
          {hints.slice(0, 8).map((h) => (
            <button
              type="button"
              key={h.name}
              onClick={() => add(h.name, h.quantity || qty, h.category)}
            >
              {h.name}
            </button>
          ))}
        </div>
      )}
      <div className="add-box">
        <div className="add-row">
          <input
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            placeholder={t("qty")}
            aria-label={t("quantity")}
            enterKeyHint="next"
          />
          <input
            ref={inputRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("addItem")}
            aria-label={t("addItem")}
            autoComplete="off"
            enterKeyHint="send"
          />
          <button className="btn" type="submit" disabled={!name.trim()}>
            {t("add")}
          </button>
        </div>
        {name.trim() && (
          <div className="suggest">
            {CATEGORIES.slice(0, 8).map((c) => (
              <button
                type="button"
                key={c.id}
                className={cat === c.id ? "active" : ""}
                onClick={() => setCat(c.id)}
              >
                {c.emoji} {tCat(c.id)}
              </button>
            ))}
          </div>
        )}
      </div>
    </form>
  );
}

function SettingsSheet({
  household,
  members,
  user,
  lists,
  activeList,
  theme,
  setTheme,
  onClose,
  onToast,
  onLogout,
  onHousehold,
  onRefresh,
  onDeleteList,
}: {
  household: Household;
  members: PublicUser[];
  user: PublicUser;
  lists: List[];
  activeList?: List;
  theme: Theme;
  setTheme: (t: Theme) => void;
  onClose: () => void;
  onToast: (s: string) => void;
  onLogout: () => Promise<void>;
  onHousehold: (h: Household) => void;
  onRefresh: () => Promise<void>;
  onDeleteList: (list: List) => Promise<void>;
}) {
  const { t, err, setLang, lang } = useT();
  const [name, setName] = useState(household.name);
  const [listName, setListName] = useState(activeList?.name ?? "");
  const [links, setLinks] = useState<Array<{ provider: string; email: string }>>([]);
  const [providers, setProviders] = useState<{ google: boolean; apple: boolean } | null>(null);
  const [email, setEmail] = useState(user.email ?? "");
  const emailDirty = useRef(false);

  useEffect(() => {
    // The background refresh replaces the user object every few seconds;
    // never clobber an in-progress edit.
    if (!emailDirty.current) setEmail(user.email ?? "");
  }, [user.email]);

  useEffect(() => {
    api.oauthLinks().then(setLinks).catch(() => undefined);
    api.oauthProviders().then(setProviders).catch(() => setProviders(null));
  }, []);

  async function linkLogin(provider: "google" | "apple") {
    try {
      const res = await api.oauthStart({ provider, mode: "link" });
      window.location.href = res.url;
    } catch (error) {
      onToast(error instanceof Error ? err(error.message) : t("cannotUpdate"));
    }
  }

  async function saveEmail() {
    const next = email.trim();
    emailDirty.current = false;
    if (next === (user.email ?? "")) return;
    try {
      await api.updateAccount({ email: next });
      onToast(t("emailSaved"));
      await onRefresh();
    } catch (error) {
      onToast(error instanceof Error ? err(error.message) : t("cannotUpdate"));
      setEmail(user.email ?? "");
    }
  }

  async function sendTestEmail() {
    try {
      await api.testEmail();
      onToast(t("testEmailSent"));
    } catch (error) {
      onToast(error instanceof Error ? err(error.message) : t("cannotSend"));
    }
  }
  async function unlinkLogin(provider: string) {
    try {
      await api.oauthUnlink(provider);
      setLinks((cur) => cur.filter((l) => l.provider !== provider));
    } catch (error) {
      onToast(error instanceof Error ? err(error.message) : t("cannotUpdate"));
    }
  }
  const [newCodes, setNewCodes] = useState<string[] | null>(null);

  async function regenerateCodes() {
    try {
      const res = await api.regenerateRecoveryCodes();
      setNewCodes(res.codes);
    } catch (error) {
      onToast(error instanceof Error ? err(error.message) : t("cannotUpdate"));
    }
  }

  async function copyNewCodes() {
    if (!newCodes) return;
    try {
      await navigator.clipboard.writeText(newCodes.join("\n"));
      onToast(t("codesCopied"));
    } catch {
      onToast(t("copyFailed"));
    }
  }

  useEffect(() => {
    setName(household.name);
  }, [household.name]);
  useEffect(() => {
    setListName(activeList?.name ?? "");
  }, [activeList?.id, activeList?.name]);

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="handle" />
        <h2>{t("household")}</h2>
        <label>
          {t("name")}
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={async () => {
              if (name.trim() && name.trim() !== household.name) {
                try {
                  const h = await api.renameHousehold(name.trim());
                  onHousehold({ ...household, ...h });
                } catch {
                  onToast(t("cannotUpdate"));
                }
              }
            }}
          />
        </label>
        <p className="muted" style={{ marginTop: 14 }}>
          {t("inviteHint")}
        </p>
        <div className="invite">
          <span>{household.inviteCode}</span>
          <button
            className="btn small"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(household.inviteCode);
                onToast(t("copied"));
              } catch {
                onToast(t("copyFailed"));
              }
            }}
          >
            {t("copy")}
          </button>
        </div>
        <div className="sheet-actions">
          <button
            className="btn ghost"
            onClick={async () => {
              if (!confirm(t("newCodeConfirm"))) return;
              try {
                const res = await api.rotateInvite();
                onHousehold({ ...household, inviteCode: res.inviteCode });
                onToast(t("newCodeReady"));
              } catch {
                onToast(t("cannotUpdate"));
              }
            }}
          >
            {t("newCode")}
          </button>
        </div>
        <div className="group-label">{t("people")}</div>
        <div className="members">
          {members.map((m) => (
            <div className="member" key={m.id}>
              <span className="avatar" style={{ background: m.color }}>
                {initials(m.displayName)}
              </span>
              <div>
                <strong>
                  {m.displayName}
                  {m.id === user.id ? t("you") : ""}
                </strong>
                <div className="muted">@{m.username}</div>
              </div>
            </div>
          ))}
        </div>
        <div className="group-label">{t("accountEmail")}</div>
        <label>
          <input
            value={email}
            onChange={(e) => {
              emailDirty.current = true;
              setEmail(e.target.value);
            }}
            placeholder={t("accountEmailPh")}
            onBlur={() => void saveEmail()}
            inputMode="email"
            maxLength={254}
          />
        </label>
        <div className="sheet-actions">
          <button type="button" className="btn ghost block" onClick={sendTestEmail}>
            {t("sendTestEmail")}
          </button>
        </div>
        {activeList && (
          <>
            <div className="group-label">{t("thisList")}</div>
            <label>
              {t("rename")}
              <input
                value={listName}
                onChange={(e) => setListName(e.target.value)}
              onBlur={async () => {
                if (listName.trim() && listName.trim() !== activeList.name) {
                  try {
                    await api.updateList(activeList.id, { name: listName.trim() });
                    await onRefresh();
                  } catch {
                    onToast(t("cannotUpdate"));
                  }
                }
              }}
              />
            </label>
            <button className="btn danger block" onClick={() => onDeleteList(activeList)}>
              {t("deleteList")}
            </button>
          </>
        )}
        {providers && (providers.google || providers.apple) && (
          <>
            <div className="group-label">{t("logins")}</div>
            <div className="members">
              {links.map((l) => (
                <div className="member" key={l.provider}>
                  <div>
                    <strong>{l.provider === "google" ? "Google" : "Apple"}</strong>
                    {l.email && <div className="muted">{l.email}</div>}
                  </div>
                  <button className="btn small ghost" onClick={() => unlinkLogin(l.provider)}>
                    {t("unlink")}
                  </button>
                </div>
              ))}
              {providers.google && !links.some((l) => l.provider === "google") && (
                <button className="btn ghost block" onClick={() => linkLogin("google")}>
                  {t("oauthGoogle")}
                </button>
              )}
              {providers.apple && !links.some((l) => l.provider === "apple") && (
                <button className="btn ghost block" onClick={() => linkLogin("apple")}>
                  {t("oauthApple")}
                </button>
              )}
            </div>
          </>
        )}
        <div className="group-label">{t("recoveryCodesTitle")}</div>
        <p className="muted">{t("recoveryCodesIntro")}</p>
        {newCodes ? (
          <>
            <ul className="codes">
              {newCodes.map((code) => (
                <li key={code}>
                  <code>{code}</code>
                </li>
              ))}
            </ul>
            <button className="btn ghost block" onClick={copyNewCodes}>
              {t("copyAll")}
            </button>
          </>
        ) : (
          <button className="btn ghost block" onClick={regenerateCodes}>
            {t("regenerateCodes")}
          </button>
        )}
        <div className="group-label">{t("language")}</div>
        <div className="lang-row">
          <button type="button" className={`btn ${lang === "en" ? "" : "ghost"}`} onClick={() => setLang("en")}>
            {t("english")}
          </button>
          <button type="button" className={`btn ${lang === "ja" ? "" : "ghost"}`} onClick={() => setLang("ja")}>
            {t("japanese")}
          </button>
        </div>
        <div className="group-label">{t("theme")}</div>
        <div className="theme-row">
          {THEMES.map((mode) => (
            <button key={mode} className={`btn ${theme === mode ? "" : "ghost"}`} onClick={() => setTheme(mode)}>
              {t(mode)}
            </button>
          ))}
        </div>
        <button className="btn ghost block" onClick={onLogout}>
          {t("signOut")}
        </button>
      </div>
    </div>
  );
}

function NewListSheet({
  onClose,
  onCreated,
  onToast,
}: {
  onClose: () => void;
  onCreated: (list: List) => void;
  onToast: (s: string) => void;
}) {
  const { t, err } = useT();
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState("🛒");
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="handle" />
        <h2>{t("newList")}</h2>
        <div className="emoji-grid">
          {LIST_EMOJIS.map((e) => (
            <button key={e} className={emoji === e ? "active" : ""} onClick={() => setEmoji(e)}>
              {e}
            </button>
          ))}
        </div>
        <label>
          {t("name")}
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("pharmacy")} autoFocus />
        </label>
        <div className="sheet-actions">
          <button className="btn ghost" onClick={onClose}>
            {t("cancel")}
          </button>
          <button
            className="btn"
            onClick={async () => {
              if (!name.trim()) return;
              try {
                const list = await api.createList({ name: name.trim(), emoji });
                onCreated(list);
              } catch (error) {
                onToast(error instanceof Error ? err(error.message) : t("cannotCreateList"));
              }
            }}
          >
            {t("create")}
          </button>
        </div>
      </div>
    </div>
  );
}

function EditItemSheet({
  item,
  sections,
  itemReminder,
  onSetReminder,
  onClearReminder,
  onClose,
  onToast,
  onRefresh,
}: {
  item: Item;
  sections: Section[];
  itemReminder: Reminder | null;
  onSetReminder: (dueAt: number) => Promise<void>;
  onClearReminder: () => Promise<void>;
  onClose: () => void;
  onToast: (s: string) => void;
  onRefresh: () => Promise<void>;
}) {
  const { t, err, tCat, lang } = useT();
  const [name, setName] = useState(item.name);
  const [quantity, setQuantity] = useState(item.quantity);
  const [notes, setNotes] = useState(item.notes);
  const [category, setCategory] = useState(item.category);
  const [sectionId, setSectionId] = useState(item.sectionId ?? "");
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="handle" />
        <h2>{t("editItem")}</h2>
        <label>
          {t("name")}
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          {t("quantity")}
          <input value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder={t("qtyPh")} />
        </label>
        <label>
          {t("notes")}
          <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={t("notesPh")} />
        </label>
        <div className="group-label">{t("aisle")}</div>
        <div className="cat-grid">
          {CATEGORIES.map((c) => (
            <button
              key={c.id}
              className={category === c.id ? "active" : ""}
              onClick={() => setCategory(c.id)}
            >
              {c.emoji} {tCat(c.id)}
            </button>
          ))}
        </div>
        {sections.length > 0 && (
          <label>
            {t("subsection")}
            <select value={sectionId} onChange={(e) => setSectionId(e.target.value)}>
              <option value="">{t("sectionNone")}</option>
              {sections.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="group-label">{t("setReminder")}</div>
        {itemReminder ? (
          <div className="reminder-row">
            <span>{formatDue(itemReminder.dueAt, lang)}</span>
            <button type="button" className="btn small ghost" onClick={() => void onClearReminder()}>
              {t("deleteReminder")}
            </button>
          </div>
        ) : (
          <div className="preset-row">
            {(
              [
                ["1h", t("inOneHour")],
                ["evening", t("thisEvening")],
                ["tomorrow", t("tomorrowMorning")],
                ["saturday", t("saturdayMorning")],
              ] as Array<[DuePreset, string]>
            ).map(([preset, label]) => (
              <button
                key={preset}
                type="button"
                className="btn small ghost"
                onClick={() => void onSetReminder(presetDue(preset))}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        <div className="sheet-actions">
          <button
            className="btn danger"
            onClick={async () => {
              if (!confirm(t("removeItemConfirm", { name: item.name }))) return;
              try {
                await api.deleteItem(item.id);
                await onRefresh();
                onClose();
              } catch (error) {
                onToast(error instanceof Error ? err(error.message) : t("cannotSave"));
              }
            }}
          >
            {t("remove")}
          </button>
          <button
            className="btn"
            onClick={async () => {
              try {
                await api.updateItem(item.id, { name, quantity, notes, category, sectionId: sectionId || null });
                await onRefresh();
                onClose();
              } catch (error) {
                onToast(error instanceof Error ? err(error.message) : t("cannotSave"));
              }
            }}
          >
            {t("save")}
          </button>
        </div>
      </div>
    </div>
  );
}

function RemindSheet({
  list,
  lists,
  items,
  reminders,
  onClose,
  onToast,
  onRefresh,
}: {
  list?: List;
  lists: List[];
  items: Item[];
  reminders: Reminder[];
  onClose: () => void;
  onToast: (s: string) => void;
  onRefresh: () => Promise<void>;
}) {
  const { t, err, lang } = useT();
  const [dueLocal, setDueLocal] = useState(() => toLocalInputValue(presetDue("1h")));
  const [duration, setDuration] = useState(60);
  const [preset, setPreset] = useState<DuePreset | "custom">("1h");
  const [notifyState, setNotifyState] = useState<NotificationPermission | "unsupported">(() =>
    typeof Notification === "undefined" ? "unsupported" : Notification.permission,
  );
  const [busy, setBusy] = useState(false);

  const listLabel = list ? `${list.emoji} ${list.name}` : "Basket";
  const plannerItems = list ? items.filter((i) => i.listId === list.id) : items;
  const trips = upcomingTrips(reminders);
  const start = fromLocalInputValue(dueLocal);
  const shopTitle = t("shopFor", { list: listLabel });
  const calEvent = Number.isFinite(start)
    ? {
        uid: `${start}@basket`,
        title: shopTitle,
        description: eventDescription(listLabel, plannerItems),
        start,
        end: start + duration * 60_000,
      }
    : null;

  async function ensurePerm() {
    const perm = await requestNotifyPermission();
    setNotifyState(perm);
    return perm;
  }

  const presetLabel: Record<DuePreset, MsgKey> = {
    "1h": "inOneHour",
    evening: "thisEvening",
    tomorrow: "tomorrowMorning",
    saturday: "saturdayMorning",
  };

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="handle" />
        <h2>{t("remind")}</h2>
        {notifyState === "default" && (
          <button className="btn ghost block" type="button" onClick={() => void ensurePerm()}>
            {t("allowNotifications")}
          </button>
        )}
        {notifyState === "granted" && <p className="muted">{t("notificationsOn")}</p>}
        {notifyState === "denied" && <p className="muted">{t("notificationsBlocked")}</p>}
        {notifyState === "unsupported" && <p className="muted">{t("notificationsNeeded")}</p>}

        <div className="group-label">{t("nudgeHousehold")}</div>
        <p className="muted">{t("nudgeHint")}</p>
        <button
          className="btn block"
          type="button"
          data-action="nudge"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await ensurePerm();
              await api.createReminder({
                kind: "nudge",
                listId: list?.id,
                title: t("nudgeFor", { list: listLabel }),
              });
              await onRefresh();
              onToast(t("nudgeSent"));
            } catch (error) {
              onToast(error instanceof Error ? err(error.message) : t("cannotNudge"));
            } finally {
              setBusy(false);
            }
          }}
        >
          {t("notifyNow")}
        </button>

        <div className="group-label">{t("planShop")}</div>
        <div className="preset-row">
          {(["1h", "evening", "tomorrow", "saturday"] as DuePreset[]).map((id) => (
            <button
              key={id}
              type="button"
              className={`btn small ${preset === id ? "" : "ghost"}`}
              onClick={() => {
                setPreset(id);
                setDueLocal(toLocalInputValue(presetDue(id)));
              }}
            >
              {t(presetLabel[id])}
            </button>
          ))}
        </div>
        <label>
          {t("customTime")}
          <input
            type="datetime-local"
            value={dueLocal}
            onChange={(e) => {
              setPreset("custom");
              setDueLocal(e.target.value);
            }}
          />
        </label>
        <div className="group-label">{t("duration")}</div>
        <div className="theme-row">
          {[30, 60, 90].map((mins) => (
            <button
              key={mins}
              type="button"
              className={`btn small ${duration === mins ? "" : "ghost"}`}
              onClick={() => setDuration(mins)}
            >
              {mins === 30 ? t("min30") : mins === 60 ? t("min60") : t("min90")}
            </button>
          ))}
        </div>
        <div className="sheet-actions">
          <button
            className="btn"
            type="button"
            data-action="set-reminder"
            disabled={busy}
            onClick={async () => {
              if (!Number.isFinite(start) || start < Date.now() - 60_000) {
                onToast(t("duePast"));
                return;
              }
              setBusy(true);
              try {
                await ensurePerm();
                await api.createReminder({
                  kind: "trip",
                  listId: list?.id,
                  dueAt: start,
                  durationMin: duration,
                  title: shopTitle,
                });
                await onRefresh();
                onToast(t("reminderSet"));
              } catch (error) {
                onToast(error instanceof Error ? err(error.message) : t("cannotRemind"));
              } finally {
                setBusy(false);
              }
            }}
          >
            {t("setReminder")}
          </button>
        </div>
        <div className="group-label">{t("addToCalendar")}</div>
        <div className="cal-row">
          <a
            className="btn ghost small"
            href={calEvent ? googleCalendarUrl(calEvent) : "#"}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => {
              if (!calEvent) e.preventDefault();
            }}
          >
            {t("googleCalendar")}
          </a>
          <a
            className="btn ghost small"
            href={calEvent ? outlookCalendarUrl(calEvent) : "#"}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => {
              if (!calEvent) e.preventDefault();
            }}
          >
            {t("outlookCalendar")}
          </a>
          <button
            className="btn ghost small"
            type="button"
            onClick={() => {
              if (!calEvent) {
                onToast(t("duePast"));
                return;
              }
              downloadIcs("basket-shop", buildIcs(calEvent));
              onToast(t("icsSaved"));
            }}
          >
            {t("downloadIcs")}
          </button>
        </div>

        <div className="group-label">{t("upcoming")}</div>
        {trips.length === 0 && <p className="muted">{t("noReminders")}</p>}
        <div className="upcoming-list">
          {trips.map((trip) => (
            <div className="upcoming-row" key={trip.id}>
              <div>
                <strong>{trip.title}</strong>
                <div className="muted">{formatDue(trip.dueAt, lang)}</div>
              </div>
              <button
                type="button"
                className="icon-btn"
                aria-label={t("downloadIcs")}
                onClick={() => {
                  const tripList = lists.find((l) => l.id === trip.listId);
                  const tripLabel = tripList ? `${tripList.emoji} ${tripList.name}` : trip.title;
                  const tripItems = trip.listId ? items.filter((i) => i.listId === trip.listId) : items;
                  downloadIcs(
                    "basket-shop",
                    buildIcs({
                      uid: `${trip.id}@basket`,
                      title: trip.title,
                      description: eventDescription(tripLabel, tripItems),
                      start: trip.dueAt,
                      end: trip.dueAt + (trip.durationMin || 60) * 60_000,
                    }),
                  );
                  onToast(t("icsSaved"));
                }}
              >
                <CalIcon />
              </button>
              <button
                type="button"
                className="icon-btn"
                aria-label={t("deleteReminder")}
                onClick={async () => {
                  try {
                    await api.deleteReminder(trip.id);
                    await onRefresh();
                    onToast(t("reminderRemoved"));
                  } catch (error) {
                    onToast(error instanceof Error ? err(error.message) : t("cannotUpdate"));
                  }
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Pencil() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z" />
    </svg>
  );
}

function Bell() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M18 8a6 6 0 1 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  );
}

function CalIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M8 3v4M16 3v4M3 10h18" />
    </svg>
  );
}

function Gear() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9c.3.7.9 1.2 1.6 1.4H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
    </svg>
  );
}
