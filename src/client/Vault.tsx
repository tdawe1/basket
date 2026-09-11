import { useEffect, useMemo, useState } from "react";
import type { VaultItemDetail, VaultItemSummary } from "../shared/types.ts";
import { api } from "./api.ts";
import { useT } from "./i18n.ts";

function loginFields(fields: Record<string, unknown>): {
  username: string;
  urls: string[];
  password: string;
} {
  const login = (fields.Login ?? fields.login) as Record<string, unknown> | undefined;
  if (!login || typeof login !== "object") return { username: "", urls: [], password: "" };
  const username = String(login.username ?? login.email ?? "");
  const password = String(login.password ?? "");
  const rawUrls = login.urls;
  // Only http(s) targets: vault data is untrusted, javascript: hrefs run in our origin.
  const urls = Array.isArray(rawUrls)
    ? rawUrls.map(String).filter((u) => /^https?:\/\//i.test(u)).slice(0, 5)
    : [];
  return { username, urls, password };
}

export function VaultSection({ onToast }: { onToast: (s: string) => void }) {
  const { t, err } = useT();
  const [items, setItems] = useState<VaultItemSummary[]>([]);
  const [vaultName, setVaultName] = useState("Shared");
  const [configured, setConfigured] = useState(true);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<VaultItemDetail | null>(null);
  const [reveal, setReveal] = useState(false);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      const status = await api.vaultStatus();
      setConfigured(status.configured);
      setVaultName(status.vault);
      if (!status.configured) return;
      const list = await api.vaultItems();
      setItems(list.items);
      setVaultName(list.vault);
    } catch (error) {
      onToast(error instanceof Error ? err(error.message) : t("vaultUnavailable"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setDetail(null);
    setReveal(false);
    if (!selectedId) return;
    let cancelled = false;
    (async () => {
      try {
        const full = await api.vaultItem(selectedId);
        if (!cancelled) setDetail(full);
      } catch (error) {
        if (!cancelled) onToast(error instanceof Error ? err(error.message) : t("vaultUnavailable"));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((item) => item.title.toLowerCase().includes(q));
  }, [items, query]);

  const selected = items.find((item) => item.id === selectedId) ?? null;
  const login = detail ? loginFields(detail.fields) : null;

  async function copyPassword() {
    if (!login?.password) return;
    try {
      await navigator.clipboard.writeText(login.password);
      onToast(t("vaultCopied"));
    } catch {
      onToast(t("copyFailed"));
    }
  }

  if (loading) return <p className="muted">{t("oneMoment")}</p>;
  if (!configured) {
    return (
      <div className="empty">
        <h2>{t("vaultSection")}</h2>
        <p>{t("vaultUnconfigured")}</p>
      </div>
    );
  }

  return (
    <div className="notes-workspace vault-workspace">
      <div className={`notes-index vault-index ${selected ? "has-editor" : ""}`}>
        <div className="notes-index-head">
          <h2>
            🔑 {t("vaultSection")} · {vaultName}
          </h2>
          <button type="button" className="btn small ghost" onClick={() => void load()}>
            {t("refresh")}
          </button>
        </div>
        <input
          className="input"
          placeholder={t("vaultSearch")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {filtered.length === 0 ? (
          <div className="empty">
            <h2>{t("vaultEmpty")}</h2>
            <p>{t("vaultEmptyHint")}</p>
          </div>
        ) : (
          <div className="notes-cards">
            {filtered.map((item) => (
              <button
                type="button"
                key={item.id}
                className={`note-card ${selectedId === item.id ? "active" : ""}`}
                onClick={() => setSelectedId(item.id)}
              >
                <div className="note-card-title">
                  <span>🔑</span>
                  <strong>{item.title}</strong>
                </div>
                <div className="meta">
                  <span className="muted">{item.itemType}</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
      {selected && (
        <div className="note-editor">
          <button type="button" className="btn ghost small vault-back" onClick={() => setSelectedId(null)}>
            ← {t("backToVault")}
          </button>
          <h2>{detail?.title ?? selected.title}</h2>
          {detail ? (
            <>
              {login && (login.username || login.urls.length > 0 || login.password) ? (
                <div style={{ display: "grid", gap: 8 }}>
                  {login.username && (
                    <label>
                      {t("username")}
                      <input className="input" readOnly value={login.username} />
                    </label>
                  )}
                  {login.urls.map((url) => (
                    <a key={url} href={url} target="_blank" rel="noreferrer">
                      {url}
                    </a>
                  ))}
                  {login.password && (
                    <label>
                      {t("password")}
                      <div style={{ display: "flex", gap: 8 }}>
                        <input
                          className="input"
                          readOnly
                          type={reveal ? "text" : "password"}
                          value={login.password}
                        />
                        <button
                          type="button"
                          className="btn small ghost"
                          onClick={() => setReveal((v) => !v)}
                        >
                          {reveal ? t("hide") : t("show")}
                        </button>
                        <button type="button" className="btn small" onClick={() => void copyPassword()}>
                          {t("copy")}
                        </button>
                      </div>
                    </label>
                  )}
                  {detail.note && <p className="muted">{detail.note}</p>}
                </div>
              ) : (
                <>
                  {detail.note && <p>{detail.note}</p>}
                  <p className="muted">{detail.itemType}</p>
                </>
              )}
            </>
          ) : (
            <p className="muted">{t("oneMoment")}</p>
          )}
        </div>
      )}
    </div>
  );
}
