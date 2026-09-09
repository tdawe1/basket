import { useEffect, useRef, useState } from "react";
import type { Note } from "../shared/types.ts";
import { api } from "./api.ts";
import { useT } from "./i18n.ts";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatStamp(ms: number, lang: string): string {
  return new Date(ms).toLocaleString(lang === "ja" ? "ja-JP" : "en-GB", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fileGlyph(mime: string | null): string {
  if (mime === "application/pdf") return "📄";
  if (mime?.startsWith("image/")) return "🖼️";
  return "📝";
}

export function NotesSection({
  notes,
  activeNoteId,
  onSelect,
  onToast,
  onRefresh,
}: {
  notes: Note[];
  activeNoteId: string | null;
  onSelect: (id: string | null) => void;
  onToast: (s: string) => void;
  onRefresh: () => Promise<void>;
}) {
  const { t, err, lang } = useT();
  const selected = notes.find((n) => n.id === activeNoteId) ?? null;

  async function createNote() {
    try {
      const note = await api.createNote({ title: t("untitledNote"), body: "" });
      onSelect(note.id);
      await onRefresh();
    } catch (error) {
      onToast(error instanceof Error ? err(error.message) : t("cannotSave"));
    }
  }

  return (
    <div className="notes-workspace">
      <div className={`notes-index ${selected ? "has-editor" : ""}`}>
          <div className="notes-index-head">
            <h2>{t("notesSection")}</h2>
            <button type="button" className="btn small" onClick={() => void createNote()}>
              {t("addNote")}
            </button>
          </div>
          {notes.length === 0 ? (
            <div className="empty">
              <h2>{t("noNotes")}</h2>
              <p>{t("noNotesHint")}</p>
            </div>
          ) : (
            <div className="notes-cards">
              {notes.map((note) => (
                <button
                  type="button"
                  key={note.id}
                  className={`note-card ${selected?.id === note.id ? "active" : ""}`}
                  onClick={() => onSelect(note.id)}
                >
                  <div className="note-card-title">
                    <span>{fileGlyph(note.fileMime)}</span>
                    <strong>{note.title || t("untitledNote")}</strong>
                  </div>
                  {note.body && <p className="note-card-snippet">{note.body}</p>}
                  <div className="meta">
                    <span className="avatar sm" style={{ background: note.createdBy.color }}>
                      {note.createdBy.displayName.slice(0, 1).toUpperCase()}
                    </span>
                    <span>{formatStamp(note.updatedAt, lang)}</span>
                    {note.fileName && <span>{note.fileName}</span>}
                  </div>
                </button>
              ))}
            </div>
          )}
      </div>
      {selected ? (
        <NoteEditor
          note={selected}
          onBack={() => onSelect(null)}
          onToast={onToast}
          onRefresh={onRefresh}
          onDeleted={() => {
            const next = notes.find((n) => n.id !== selected.id);
            onSelect(next?.id ?? null);
          }}
        />
      ) : (
        <div className="note-editor notes-empty-desktop">
          <div className="empty">
            <h2>{notes.length ? t("notesSection") : t("noNotes")}</h2>
            <p>{notes.length ? t("pickNote") : t("noNotesHint")}</p>
            {notes.length === 0 && (
              <button type="button" className="btn" onClick={() => void createNote()}>
                {t("addNote")}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function NoteEditor({
  note,
  onBack,
  onToast,
  onRefresh,
  onDeleted,
}: {
  note: Note;
  onBack: () => void;
  onToast: (s: string) => void;
  onRefresh: () => Promise<void>;
  onDeleted: () => void;
}) {
  const { t, err } = useT();
  const [title, setTitle] = useState(note.title);
  const [body, setBody] = useState(note.body);
  const [busy, setBusy] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setTitle(note.title);
    setBody(note.body);
  }, [note.id]);

  useEffect(() => {
    if (!note.fileMime) {
      setPreviewUrl(null);
      return;
    }
    let objectUrl = "";
    let cancelled = false;
    fetch(api.noteFileUrl(note.id), { credentials: "include" })
      .then((res) => {
        if (!res.ok) throw new Error("file");
        return res.blob();
      })
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setPreviewUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setPreviewUrl(null);
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [note.id, note.fileMime, note.fileSize]);

  async function save() {
    try {
      await api.updateNote(note.id, { title: title.trim() || t("untitledNote"), body });
      await onRefresh();
      onToast(t("noteSaved"));
    } catch (error) {
      onToast(error instanceof Error ? err(error.message) : t("cannotSave"));
    }
  }

  async function onFile(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    try {
      await api.uploadNoteFile(note.id, file);
      await onRefresh();
      onToast(t("fileAttached"));
    } catch (error) {
      onToast(error instanceof Error ? err(error.message) : t("cannotSave"));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function share() {
    const text = [title.trim() || t("untitledNote"), body.trim()].filter(Boolean).join("\n\n");
    try {
      if (navigator.share) {
        await navigator.share({ title: title.trim() || t("untitledNote"), text });
        return;
      }
      await navigator.clipboard.writeText(text);
      onToast(t("noteCopied"));
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      try {
        await navigator.clipboard.writeText(text);
        onToast(t("noteCopied"));
      } catch {
        onToast(t("cannotSave"));
      }
    }
  }

  return (
    <div className="note-editor">
      <div className="note-editor-bar">
        <button type="button" className="btn ghost small notes-back" onClick={onBack}>
          ← {t("backToNotes")}
        </button>
        <div className="note-editor-actions">
          <button type="button" className="btn ghost small" onClick={() => void share()}>
            {t("shareNote")}
          </button>
          <button type="button" className="btn small" disabled={busy} onClick={() => void save()}>
            {t("save")}
          </button>
        </div>
      </div>
      <label>
        {t("noteTitle")}
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => {
            if (title !== note.title) void save();
          }}
          placeholder={t("untitledNote")}
        />
      </label>
      <label className="note-body-label">
        {t("noteBody")}
        <textarea
          className="note-body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onBlur={() => {
            if (body !== note.body) void save();
          }}
          placeholder={t("noteBodyPh")}
          rows={8}
        />
      </label>
      <div className="note-file">
        <div className="group-label">{t("attachFile")}</div>
        <input
          ref={fileRef}
          type="file"
          accept="application/pdf,image/png,image/jpeg,image/webp,.pdf"
          hidden
          onChange={(e) => void onFile(e.target.files?.[0])}
        />
        {note.fileName && note.fileMime ? (
          <div className="note-file-card">
            <div>
              <strong>
                {fileGlyph(note.fileMime)} {note.fileName}
              </strong>
              <div className="muted">
                {note.fileSize != null ? formatBytes(note.fileSize) : ""}
              </div>
            </div>
            <div className="note-file-actions">
              <a className="btn ghost small" href={api.noteFileUrl(note.id, true)}>
                {t("downloadFile")}
              </a>
              <button type="button" className="btn ghost small" disabled={busy} onClick={() => fileRef.current?.click()}>
                {t("replaceFile")}
              </button>
              <button
                type="button"
                className="btn danger small"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await api.deleteNoteFile(note.id);
                    await onRefresh();
                    onToast(t("fileRemoved"));
                  } catch (error) {
                    onToast(error instanceof Error ? err(error.message) : t("cannotSave"));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {t("removeFile")}
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="btn ghost" disabled={busy} onClick={() => fileRef.current?.click()}>
            {t("uploadPdf")}
          </button>
        )}
        {previewUrl && note.fileMime === "application/pdf" && (
          <iframe className="pdf-frame" title={note.fileName || t("notesSection")} src={previewUrl} />
        )}
        {previewUrl && note.fileMime?.startsWith("image/") && (
          <img className="note-image" src={previewUrl} alt={note.fileName || ""} />
        )}
      </div>
      <button
        type="button"
        className="btn danger block"
        disabled={busy}
        onClick={async () => {
          if (!confirm(t("deleteNoteConfirm", { name: note.title || t("untitledNote") }))) return;
          setBusy(true);
          try {
            await api.deleteNote(note.id);
            onDeleted();
            await onRefresh();
            onToast(t("noteDeleted"));
          } catch (error) {
            onToast(error instanceof Error ? err(error.message) : t("cannotSave"));
          } finally {
            setBusy(false);
          }
        }}
      >
        {t("deleteNote")}
      </button>
    </div>
  );
}
