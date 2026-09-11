import { useEffect, useState } from "react";
import { api, ApiError } from "./api.ts";
import { useT } from "./i18n.ts";

type StoredFile = { id: string; title: string; mime: string; size: number; updatedAt: number };
type CloudLink = { provider: string; status: string; accountEmail: string };

const PROVIDERS = ["google", "apple", "proton", "dropbox"] as const;

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function providerName(p: string, t: (k: "unknownProvider") => string): string {
  if (p === "google") return "Google Drive";
  if (p === "apple") return "iCloud Drive";
  if (p === "proton") return "Proton Drive";
  if (p === "dropbox") return "Dropbox";
  return t("unknownProvider");
}

export function StorageSection({ onToast }: { onToast: (s: string) => void }) {
  const { t, err } = useT();
  const [usage, setUsage] = useState<{ files: number; bytes: number } | null>(null);
  const [files, setFiles] = useState<StoredFile[]>([]);
  const [links, setLinks] = useState<CloudLink[]>([]);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [emailDraft, setEmailDraft] = useState("");

  async function load() {
    try {
      const [u, f, l] = await Promise.all([api.storageUsage(), api.storageFiles(), api.cloudLinks()]);
      setUsage(u);
      setFiles(f);
      setLinks(l);
    } catch (error) {
      onToast(error instanceof ApiError ? err(error.message) : t("cannotLoad"));
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function connect(provider: string) {
    try {
      await api.cloudConnect(provider, emailDraft.trim());
      setConnecting(null);
      setEmailDraft("");
      await load();
      onToast(t("cloudPending"));
    } catch (error) {
      onToast(error instanceof ApiError ? err(error.message) : t("cannotSave"));
    }
  }

  async function disconnect(provider: string) {
    try {
      await api.cloudDisconnect(provider);
      await load();
    } catch (error) {
      onToast(error instanceof ApiError ? err(error.message) : t("cannotSave"));
    }
  }

  const byProvider = new Map(links.map((l) => [l.provider, l]));

  return (
    <div className="storage-wrap">
      <div className="group-label">{t("basketStorage")}</div>
      <div className="card">
        {usage ? (
          <>
            <div className="row spread">
              <strong>{t("attachments", { n: String(usage.files) })}</strong>
              <span className="muted">{fmtBytes(usage.bytes)}</span>
            </div>
            <div className="meter">
              <span style={{ width: `${Math.min(100, (usage.bytes / (8 * 1024 * 1024)) * 100)}%` }} />
            </div>
            <p className="muted small">{t("storageHint")}</p>
          </>
        ) : (
          <p className="muted">{t("oneMoment")}</p>
        )}
      </div>
      {files.length > 0 && (
        <div className="card file-list">
          {files.map((f) => (
            <div key={f.id} className="row spread file-row">
              <div>
                <strong>{f.title}</strong>
                <div className="muted small">{f.mime} · {fmtBytes(f.size)}</div>
              </div>
              <a className="btn ghost small" href={api.noteFileUrl(f.id, true)} download>
                {t("download")}
              </a>
            </div>
          ))}
        </div>
      )}
      <div className="group-label">{t("cloudProviders")} <span className="pill">{t("beta")}</span></div>
      <p className="muted small">{t("cloudHint")}</p>
      {PROVIDERS.map((p) => {
        const link = byProvider.get(p);
        return (
          <div key={p} className="card">
            <div className="row spread">
              <div>
                <strong>{providerName(p, t)}</strong>
                <div className="muted small">
                  {link
                    ? link.accountEmail || t("cloudPendingShort")
                    : t("notConnected")}
                </div>
              </div>
              {link ? (
                <button type="button" className="btn ghost small" onClick={() => void disconnect(p)}>
                  {t("disconnect")}
                </button>
              ) : connecting === p ? (
                <form
                  className="row"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void connect(p);
                  }}
                >
                  <input
                    className="input"
                    value={emailDraft}
                    onChange={(e) => setEmailDraft(e.target.value)}
                    placeholder={t("accountEmailPh")}
                    inputMode="email"
                  />
                  <button type="submit" className="btn small">{t("connect")}</button>
                </form>
              ) : (
                <button type="button" className="btn small" onClick={() => setConnecting(p)}>
                  {t("connect")}
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
