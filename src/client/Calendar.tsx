import { useMemo, useState } from "react";
import type { Reminder } from "../shared/types.ts";
import { useT } from "./i18n.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function fmtDay(ts: number, lang: string): string {
  return new Date(ts).toLocaleDateString(lang === "ja" ? "ja-JP" : "en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

function fmtTime(ts: number, lang: string): string {
  return new Date(ts).toLocaleTimeString(lang === "ja" ? "ja-JP" : "en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

export function CalendarSection({ reminders, trips, onAgenda }: { reminders: Reminder[]; trips: Reminder[]; onAgenda: () => void }) {
  const { t, lang } = useT();
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth());
  const [selected, setSelected] = useState<number>(() => startOfDay(Date.now()));
  const [embedUrl, setEmbedUrl] = useState(() => localStorage.getItem("basket-calendar-url") ?? "");
  const [draft, setDraft] = useState(embedUrl);
  const [showEmbedForm, setShowEmbedForm] = useState(false);

  const byDay = useMemo(() => {
    const map = new Map<string, Reminder[]>();
    for (const r of reminders) {
      if (!Number.isFinite(r.dueAt)) continue;
      const key = dayKey(r.dueAt);
      const list = map.get(key);
      if (list) list.push(r);
      else map.set(key, [r]);
    }
    for (const list of map.values()) list.sort((a, b) => a.dueAt - b.dueAt);
    return map;
  }, [reminders]);

  const cells = useMemo(() => {
    // Monday-first grid.
    const first = new Date(year, month, 1);
    const lead = (first.getDay() + 6) % 7;
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const out: Array<{ ts: number; inMonth: boolean }> = [];
    for (let i = lead - 1; i >= 0; i--) {
      out.push({ ts: startOfDay(new Date(year, month, 1 - (i + 1)).getTime()), inMonth: false });
    }
    for (let d = 1; d <= daysInMonth; d++) {
      out.push({ ts: startOfDay(new Date(year, month, d).getTime()), inMonth: true });
    }
    while (out.length % 7 !== 0) {
      const last = out[out.length - 1].ts;
      out.push({ ts: last + DAY_MS, inMonth: false });
    }
    return out;
  }, [year, month]);

  const monthLabel = new Date(year, month, 1).toLocaleDateString(lang === "ja" ? "ja-JP" : "en-US", {
    year: "numeric",
    month: "long",
  });
  const weekdayLabels = useMemo(() => {
    const base = startOfDay(new Date(2026, 8, 7).getTime()); // a Monday
    return Array.from({ length: 7 }, (_, i) =>
      new Date(base + i * DAY_MS).toLocaleDateString(lang === "ja" ? "ja-JP" : "en-US", { weekday: "short" }),
    );
  }, [lang]);

  const selectedItems = byDay.get(dayKey(selected)) ?? [];
  const todayKey = dayKey(Date.now());

  function saveEmbed(e: React.FormEvent) {
    e.preventDefault();
    const url = draft.trim();
    if (url && !/^https:\/\//i.test(url)) return;
    setEmbedUrl(url);
    localStorage.setItem("basket-calendar-url", url);
    setShowEmbedForm(false);
  }

  return (
    <div className="calendar-wrap">
      {trips.length > 0 && (
        <div className="cal-upcoming">
          <div className="group-label">{t("upcoming")}</div>
          {trips.slice(0, 4).map((trip) => (
            <button key={trip.id} type="button" className="upcoming-row" onClick={onAgenda}>
              <div>
                <strong>{trip.title}</strong>
                <div className="muted">
                  {fmtDay(trip.dueAt, lang)} · {fmtTime(trip.dueAt, lang)}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
      <div className="cal-head">
        <button type="button" className="btn ghost small" onClick={() => {
          const d = new Date(year, month - 1, 1);
          setYear(d.getFullYear());
          setMonth(d.getMonth());
        }} aria-label="‹">‹</button>
        <strong>{monthLabel}</strong>
        <button type="button" className="btn ghost small" onClick={() => {
          const d = new Date(year, month + 1, 1);
          setYear(d.getFullYear());
          setMonth(d.getMonth());
        }} aria-label="›">›</button>
        <button
          type="button"
          className="btn ghost small"
          onClick={() => {
            const d = new Date();
            setYear(d.getFullYear());
            setMonth(d.getMonth());
            setSelected(startOfDay(d.getTime()));
          }}
        >
          {t("today")}
        </button>
      </div>
      <div className="cal-grid">
        {weekdayLabels.map((w) => (
          <div key={w} className="cal-dow">{w}</div>
        ))}
        {cells.map((cell) => {
          const key = dayKey(cell.ts);
          const items = byDay.get(key) ?? [];
          return (
            <button
              key={key}
              type="button"
              className={`cal-day${cell.inMonth ? "" : " out"}${key === todayKey ? " today" : ""}${cell.ts === selected ? " sel" : ""}`}
              onClick={() => setSelected(cell.ts)}
            >
              <span className="cal-num">{new Date(cell.ts).getDate()}</span>
              <span className="cal-dots">
                {items.slice(0, 3).map((r) => (
                  <span key={r.id} className={`cal-dot k-${r.kind}`} />
                ))}
              </span>
            </button>
          );
        })}
      </div>
      <div className="cal-detail">
        <div className="group-label">{fmtDay(selected, lang)}</div>
        {selectedItems.length === 0 ? (
          <p className="muted">{t("noRemindersDay")}</p>
        ) : (
          selectedItems.map((r) => (
            <div key={r.id} className="upcoming-row">
              <span className={`cal-dot k-${r.kind}`} />
              <div>
                <strong>{r.title}</strong>
                <div className="muted">{fmtTime(r.dueAt, lang)}</div>
              </div>
            </div>
          ))
        )}
      </div>
      <div className="cal-embed">
        <div className="group-label">{t("externalCalendar")}</div>
        {embedUrl && !showEmbedForm ? (
          <>
            <iframe src={embedUrl} title={t("externalCalendar")} loading="lazy" />
            <div className="row">
              <button type="button" className="btn ghost small" onClick={() => { setDraft(embedUrl); setShowEmbedForm(true); }}>
                {t("edit")}
              </button>
              <button type="button" className="btn ghost small" onClick={() => {
                setEmbedUrl("");
                setDraft("");
                localStorage.removeItem("basket-calendar-url");
              }}>
                {t("remove")}
              </button>
            </div>
          </>
        ) : (
          <form onSubmit={saveEmbed} className="row">
            <input
              className="input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={t("embedUrlPh")}
              inputMode="url"
            />
            <button type="submit" className="btn small">{t("save")}</button>
            {embedUrl && (
              <button type="button" className="btn ghost small" onClick={() => setShowEmbedForm(false)}>
                {t("cancel")}
              </button>
            )}
          </form>
        )}
      </div>
    </div>
  );
}
