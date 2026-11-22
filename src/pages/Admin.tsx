import { useEffect, useMemo, useState } from "react";
import { adminApi } from "../lib/api";
import { t, type Lang } from "../lib/i18n";

type ListRes = Awaited<ReturnType<typeof adminApi.list>>;
type SubRow = ListRes["subscribers"][number];
type AdminAction = "activate" | "renew" | "pause" | "resume" | "delete";

const TOKEN_KEY = "ds_admin_token";

export default function Admin({ lang }: { lang: Lang; toggleLang: () => void }) {
  const [token, setToken] = useState<string>(() => localStorage.getItem(TOKEN_KEY) ?? "");
  const [password, setPassword] = useState("");
  const [subs, setSubs] = useState<SubRow[] | null>(null);
  const [stats, setStats] = useState<ListRes["stats"] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState("newest");

  async function load(tk: string) {
    setBusy(true);
    setError("");
    try {
      const res = await adminApi.list(tk);
      setSubs(res.subscribers);
      setStats(res.stats);
    } catch (e) {
      setError(e instanceof Error ? e.message : t(lang, "errorGeneric"));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    const saved = localStorage.getItem(TOKEN_KEY);
    if (saved) void load(saved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function doLogin() {
    setBusy(true);
    setError("");
    try {
      const res = await adminApi.login(password);
      localStorage.setItem(TOKEN_KEY, res.token);
      setToken(res.token);
      setPassword("");
      await load(res.token);
    } catch {
      setError(t(lang, "wrongPassword"));
    } finally {
      setBusy(false);
    }
  }

  function logout() {
    localStorage.removeItem(TOKEN_KEY);
    setToken("");
    setSubs(null);
    setStats(null);
    setError("");
    setPassword("");
  }

  const list = useMemo(() => {
    const base = subs ?? [];
    const needle = q.trim().toLowerCase();
    const filtered = needle ? base.filter((s) => s.email.toLowerCase().includes(needle)) : base;
    const expiryOf = (s: SubRow) => s.expires_at || s.trial_ends_at || "";
    const arr = [...filtered];
    if (sort === "newest") arr.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    else if (sort === "oldest") arr.sort((a, b) => (a.created_at > b.created_at ? 1 : -1));
    else if (sort === "expiry_asc") arr.sort((a, b) => (expiryOf(a) > expiryOf(b) ? 1 : -1));
    else arr.sort((a, b) => (expiryOf(a) < expiryOf(b) ? 1 : -1));
    return arr;
  }, [subs, q, sort]);

  async function run(id: string, action: AdminAction) {
    if (!token) return;
    setBusy(true);
    setError("");
    try {
      await adminApi.action(token, id, action);
      await load(token);
    } catch (e) {
      setError(e instanceof Error ? e.message : t(lang, "errorGeneric"));
      setBusy(false);
    }
  }

  function askDelete(s: SubRow) {
    if (!window.confirm(t(lang, "confirmDelete"))) return;
    void run(s.id, "delete");
  }

  if (!token) {
    return (
      <div className="wrap">
        <div className="form">
          <div className="kicker">{t(lang, "adminLogin")}</div>
          <input
            className="field"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !busy) void doLogin();
            }}
          />
          <button
            className="cta"
            style={{ marginTop: 12 }}
            disabled={busy}
            onClick={() => void doLogin()}
          >
            {t(lang, "enter")}
          </button>
          {error ? <div className="err">{error}</div> : null}
          {busy ? <div className="note">{t(lang, "loading")}</div> : null}
        </div>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 14 }}>
        <button className="abtn" onClick={logout}>
          {t(lang, "logout")}
        </button>
      </div>

      {stats ? (
        <div className="stats">
          <div className="stat">
            <span className="v ltr">{stats.total}</span>
            <div className="k">{t(lang, "statTotal")}</div>
          </div>
          <div className="stat">
            <span className="v ltr">{stats.pending}</span>
            <div className="k">{t(lang, "statPending")}</div>
          </div>
          <div className="stat">
            <span className="v ltr">{stats.active}</span>
            <div className="k">{t(lang, "statActive")}</div>
          </div>
          <div className="stat">
            <span className="v ltr">{stats.expired}</span>
            <div className="k">{t(lang, "statExpired")}</div>
          </div>
          <div className="stat">
            <span className="v ltr">{stats.articles_24h}</span>
            <div className="k">{t(lang, "statArticles")}</div>
          </div>
        </div>
      ) : null}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "12px 0" }}>
        <input
          className="field"
          style={{ flex: "1 1 220px" }}
          type="search"
          value={q}
          placeholder={t(lang, "searchPh")}
          onChange={(e) => setQ(e.target.value)}
        />
        <select className="field" style={{ flex: "0 0 200px" }} value={sort} onChange={(e) => setSort(e.target.value)}>
          <option value="newest">{t(lang, "sortNewest")}</option>
          <option value="oldest">{t(lang, "sortOldest")}</option>
          <option value="expiry_asc">{t(lang, "sortExpiryNear")}</option>
          <option value="expiry_desc">{t(lang, "sortExpiryFar")}</option>
        </select>
      </div>

      {busy ? <div className="note">{t(lang, "loading")}</div> : null}
      {error ? <div className="err">{error}</div> : null}

      {subs && list.length === 0 ? <div className="note">{t(lang, "noSubs")}</div> : null}

      {subs
        ? list.map((s) => {
            const expiry = s.expires_at || s.trial_ends_at;
            return (
              <div className="trow" key={s.id}>
                <div>
                  <div className="rowemail">
                    <span className="ltr">{s.email}</span>
                  </div>
                  <div className="rowmeta">
                    {s.topics.map((x) => t(lang, "topic_" + x)).join(" · ")}
                    {" — "}
                    <span className="ltr">{String(s.delivery_hour).padStart(2, "0")}:00</span>
                    {expiry ? (
                      <>
                        {" · "}
                        {t(lang, "colExpiry")}:{" "}
                        <span className="ltr">{expiry.slice(0, 10)}</span>
                      </>
                    ) : null}
                  </div>
                </div>
                <div>
                  <span className={"badge " + s.status}>{t(lang, "status_" + s.status)}</span>
                  <div className="actions">
                    {s.status === "trial" ? (
                      <>
                        <button
                          className="abtn primary"
                          disabled={busy}
                          onClick={() => void run(s.id, "activate")}
                        >
                          {t(lang, "actActivate")}
                        </button>
                        <button className="abtn danger" disabled={busy} onClick={() => askDelete(s)}>
                          {t(lang, "actDelete")}
                        </button>
                      </>
                    ) : null}

                    {s.status === "active" ? (
                      <>
                        <button
                          className="abtn primary"
                          disabled={busy}
                          onClick={() => void run(s.id, "renew")}
                        >
                          {t(lang, "actRenew")}
                        </button>
                        <button className="abtn" disabled={busy} onClick={() => void run(s.id, "pause")}>
                          {t(lang, "actPause")}
                        </button>
                        <button className="abtn danger" disabled={busy} onClick={() => askDelete(s)}>
                          {t(lang, "actDelete")}
                        </button>
                      </>
                    ) : null}

                    {s.status === "paused" ? (
                      <>
                        <button
                          className="abtn primary"
                          disabled={busy}
                          onClick={() => void run(s.id, "resume")}
                        >
                          {t(lang, "actResume")}
                        </button>
                        <button className="abtn danger" disabled={busy} onClick={() => askDelete(s)}>
                          {t(lang, "actDelete")}
                        </button>
                      </>
                    ) : null}

                    {s.status === "expired" ? (
                      <>
                        <button
                          className="abtn primary"
                          disabled={busy}
                          onClick={() => void run(s.id, "renew")}
                        >
                          {t(lang, "actRenew")}
                        </button>
                        <button className="abtn danger" disabled={busy} onClick={() => askDelete(s)}>
                          {t(lang, "actDelete")}
                        </button>
                      </>
                    ) : null}

                    {s.status === "pending" ? (
                      <>
                        <button
                          className="abtn primary"
                          disabled={busy}
                          onClick={() => void run(s.id, "activate")}
                        >
                          {t(lang, "actActivate")}
                        </button>
                        <button className="abtn danger" disabled={busy} onClick={() => askDelete(s)}>
                          {t(lang, "actDelete")}
                        </button>
                      </>
                    ) : null}

                    {s.status === "cancelled" ? (
                      <button className="abtn danger" disabled={busy} onClick={() => askDelete(s)}>
                        {t(lang, "actDelete")}
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
            );
          })
        : null}
    </div>
  );
}
