import { useEffect, useState } from "react";
import { api, type Interest, type Subscriber, type LiveInterestReport } from "../lib/api";
import { t, TOPICS, type Lang, type Topic } from "../lib/i18n";
import type { PageProps } from "../App";

function readToken(): string | null {
  const p = new URLSearchParams(window.location.search);
  return p.get("token");
}

export default function Manage({ lang }: PageProps) {
  const [token] = useState<string | null>(readToken());
  const [sub, setSub] = useState<Subscriber | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "invalid" | "anon">("loading");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tgBot, setTgBot] = useState<string | null>(null);
  const [tgLinkBusy, setTgLinkBusy] = useState(false);
  const [interests, setInterests] = useState<Interest[]>([]);
  const [interestInput, setInterestInput] = useState("");
  const [interestError, setInterestError] = useState("");
  const [interestBusy, setInterestBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  const [discoveringId, setDiscoveringId] = useState<string | null>(null);
  const [discovery, setDiscovery] = useState<LiveInterestReport | null>(null);
  const [discoveryError, setDiscoveryError] = useState("");

  useEffect(() => {
    api.config().then((c) => setTgBot(c.telegram_bot)).catch(() => setTgBot(null));
  }, []);

  const [emailInput, setEmailInput] = useState("");
  const [topics, setTopics] = useState<Set<Topic>>(new Set());
  const [hour, setHour] = useState(7);
  const [digestLang, setDigestLang] = useState<Lang>("ar");

  useEffect(() => {
    if (!token) {
      setState("anon");
      return;
    }
    api
      .me(token)
      .then((r) => {
        setSub(r.subscriber);
        setTopics(new Set(r.subscriber.topics));
        setHour(r.subscriber.delivery_hour);
        setDigestLang(r.subscriber.language);
        setState("ready");
      })
      .catch(() => setState("invalid"));
  }, [token]);

  const refreshInterests = async () => {
    if (!token) return;
    try {
      const r = await api.interests(token);
      setInterests(r.interests);
    } catch {
      setInterestError(t(lang, "errorGeneric"));
    }
  };

  useEffect(() => {
    if (state === "ready" && token) void refreshInterests();
    // Refresh once the authenticated profile is available.
  }, [state, token]);

  const toggleTopic = (x: Topic) => {
    setTopics((prev) => {
      const next = new Set(prev);
      if (next.has(x)) next.delete(x);
      else if (next.size < 3) next.add(x);
      else return prev;
      return next;
    });
    setSaved(false);
  };

  const sendLink = async () => {
    setError("");
    setBusy(true);
    try {
      const r = await api.login(emailInput);
      if (r.manage_url) {
        window.location.href = r.manage_url;
      } else {
        setError(t(lang, "linkSent"));
      }
    } catch {
      setError(t(lang, "errorGeneric"));
    } finally {
      setBusy(false);
    }
  };

  const openTelegramLink = async () => {
    if (!token || !tgBot || tgLinkBusy) return;
    setError("");
    setTgLinkBusy(true);
    try {
      // Short-lived single-use link token: the management token never leaves this request.
      const r = await api.createTelegramLink(token);
      window.open(`https://t.me/${tgBot}?start=${encodeURIComponent(r.token)}`, "_blank", "noopener");
    } catch {
      setError(t(lang, "errorGeneric"));
    } finally {
      setTgLinkBusy(false);
    }
  };

  const save = async () => {
    if (!token) return;
    setError("");
    if (topics.size < 1 || topics.size > 3) return setError(t(lang, "errorTopics"));
    setBusy(true);
    try {
      await api.updateMe(token, { topics: [...topics], delivery_hour: hour, language: digestLang });
      setSaved(true);
      const r = await api.me(token);
      setSub(r.subscriber);
    } catch {
      setError(t(lang, "errorGeneric"));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!token || !window.confirm(t(lang, "cancelConfirm"))) return;
    setBusy(true);
    try {
      await api.cancelMe(token);
      const r = await api.me(token);
      setSub(r.subscriber);
    } catch {
      setError(t(lang, "errorGeneric"));
    } finally {
      setBusy(false);
    }
  };

  const interestErrorMessage = (e: unknown): string => {
    const msg = e instanceof Error ? e.message : "";
    if (msg === "interest limit reached") return t(lang, "interestLimit");
    if (msg === "interest already exists") return t(lang, "interestDuplicate");
    if (msg === "interest must contain 3 to 300 characters of text") return t(lang, "interestInvalid");
    return t(lang, "errorGeneric");
  };

  const addInterest = async () => {
    if (!token || interestBusy) return;
    const text = interestInput.trim();
    if (text.length < 3 || text.length > 300) { setInterestError(t(lang, "interestInvalid")); return; }
    setInterestError("");
    setInterestBusy(true);
    try {
      await api.addInterest(token, text);
      setInterestInput("");
      await refreshInterests();
    } catch (e) {
      setInterestError(interestErrorMessage(e));
    } finally {
      setInterestBusy(false);
    }
  };

  const startEditInterest = (item: Interest) => {
    setEditingId(item.id);
    setEditingText(item.text);
    setInterestError("");
  };

  const cancelEditInterest = () => {
    setEditingId(null);
    setEditingText("");
  };

  const saveInterest = async () => {
    if (!token || !editingId || interestBusy) return;
    const text = editingText.trim();
    if (text.length < 3 || text.length > 300) { setInterestError(t(lang, "interestInvalid")); return; }
    setInterestError("");
    setInterestBusy(true);
    try {
      await api.updateInterest(token, editingId, text);
      setEditingId(null);
      setEditingText("");
      await refreshInterests();
    } catch (e) {
      setInterestError(interestErrorMessage(e));
    } finally {
      setInterestBusy(false);
    }
  };

  const removeInterest = async (id: string) => {
    if (!token || interestBusy) return;
    setInterestError("");
    setInterestBusy(true);
    try {
      await api.deleteInterest(token, id);
      if (editingId === id) cancelEditInterest();
      await refreshInterests();
    } catch (e) {
      setInterestError(interestErrorMessage(e));
    } finally {
      setInterestBusy(false);
    }
  };

  const testInterest = async (id: string) => {
    if (!token || discoveringId) return;
    setDiscovery(null); setDiscoveryError(""); setDiscoveringId(id);
    try { setDiscovery(await api.discoverInterest(token, id)); }
    catch (e) { setDiscoveryError(t(lang, e instanceof Error && e.message.includes("rate limit") ? "interestDiscoverRate" : "interestDiscoverError")); }
    finally { setDiscoveringId(null); }
  };

  if (state === "loading") return <div className="form note">{t(lang, "loading")}</div>;

  if (state === "anon" || state === "invalid") {
    return (
      <div className="form">
        {state === "invalid" && <div className="err">{t(lang, "invalidToken")}</div>}
        <div className="kicker">{t(lang, "managingTitle")}</div>
        <h1 className="hero-title" style={{ fontSize: 26 }}>{t(lang, "managingTitle")}</h1>
        <p className="hero-sub">{t(lang, "loginPrompt")}</p>
        <input className="field" type="email" value={emailInput} onChange={(e) => setEmailInput(e.target.value)} placeholder="name@example.com" />
        <button className="cta" style={{ marginTop: 14 }} onClick={sendLink} disabled={busy}>
          {t(lang, "sendLink")}
        </button>
        {error && <div className="note">{error}</div>}
      </div>
    );
  }

  const s = sub!;
  const expiry = s.status === "trial" ? s.trial_ends_at : s.expires_at;

  return (
    <div className="form">
      <div className="kicker">{t(lang, "managingTitle")}</div>
      <h1 className="hero-title" style={{ fontSize: 26 }}>{s.email}</h1>
      <div className="pricebar">
        <span className={"badge " + s.status}>{t(lang, "status_" + s.status)}</span>
        {expiry && (
          <span className="q">
            {t(lang, "expiryLabel")}: <span className="ltr">{expiry.slice(0, 10)}</span>
          </span>
        )}
      </div>

      {s.telegram_chat_id ? (
        <div className="note" style={{ color: "var(--deep)", fontWeight: 700, marginTop: 14 }}>
          {t(lang, "tgLinked")}
          <div style={{ fontWeight: 400, fontSize: 12, color: "var(--muted)" }}>{t(lang, "tgLinkedHint")}</div>
        </div>
      ) : tgBot && token ? (
        <button className="cta" style={{ marginTop: 14 }} onClick={() => void openTelegramLink()} disabled={tgLinkBusy}>
          {t(lang, "tgLink")}
        </button>
      ) : null}

      <div className="step"><span className="ltr">1</span> {t(lang, "stepTopics")}</div>
      <div className="chips">
        {TOPICS.map((x) => (
          <button key={x} className={"chip" + (topics.has(x) ? " on" : "")} onClick={() => toggleTopic(x)}>
            {t(lang, "topic_" + x)}
          </button>
        ))}
      </div>
      <div className="counter ltr">{topics.size}/3</div>

      <div className="step"><span className="ltr">2</span> {t(lang, "stepTime")}</div>
      <div className="slots">
        {[7, 12, 18].map((h) => (
          <button key={h} className={"slot ltr" + (hour === h ? " on" : "")} onClick={() => { setHour(h); setSaved(false); }}>
            {String(h).padStart(2, "0")}:00
          </button>
        ))}
      </div>
      <select
        className="field ltr"
        style={{ marginTop: 8, maxWidth: 180 }}
        value={hour}
        aria-label={t(lang, "stepTime")}
        onChange={(e) => { setHour(Number(e.target.value)); setSaved(false); }}
      >
        {Array.from({ length: 24 }, (_, h) => (
          <option key={h} value={h}>
            {String(h).padStart(2, "0")}:00
          </option>
        ))}
      </select>

      <div className="step"><span className="ltr">3</span> {t(lang, "stepLang")}</div>
      <div className="slots">
        <button className={"slot" + (digestLang === "ar" ? " on" : "")} onClick={() => { setDigestLang("ar"); setSaved(false); }}>عربية</button>
        <button className={"slot" + (digestLang === "en" ? " on" : "")} onClick={() => { setDigestLang("en"); setSaved(false); }}>English</button>
      </div>

      <button className="cta" style={{ marginTop: 18 }} onClick={save} disabled={busy}>
        {t(lang, "saveBtn")}
      </button>
      {saved && <div className="note" style={{ color: "var(--deep)", fontWeight: 700 }}>{t(lang, "saved")}</div>}
      {error && <div className="err">{error}</div>}

      <div className="step" style={{ marginTop: 24 }}>{t(lang, "interestsTitle")}</div>
      <div className="note">{t(lang, "interestsHint")}</div>
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <input
          className="field"
          style={{ flex: 1, minWidth: 0 }}
          value={interestInput}
          maxLength={300}
          placeholder={t(lang, "interestPlaceholder")}
          onChange={(e) => { setInterestInput(e.target.value); setInterestError(""); }}
          onKeyDown={(e) => { if (e.key === "Enter") void addInterest(); }}
        />
        <button className="abtn primary" style={{ flex: "none", padding: "0 16px" }} onClick={() => void addInterest()} disabled={interestBusy}>
          {t(lang, "interestAdd")}
        </button>
      </div>
      {interestError && <div className="err" style={{ textAlign: "start" }}>{interestError}</div>}
      <ul className="interest-list">
        {interests.map((item) =>
          editingId === item.id ? (
            <li key={item.id} className="interest-item">
              <input className="field" value={editingText} maxLength={300} onChange={(e) => setEditingText(e.target.value)} />
              <div className="interest-actions">
                <button className="abtn primary" onClick={() => void saveInterest()} disabled={interestBusy}>{t(lang, "saveBtn")}</button>
                <button className="abtn" onClick={cancelEditInterest} disabled={interestBusy}>{t(lang, "interestCancel")}</button>
              </div>
            </li>
          ) : (
            <li key={item.id} className="interest-item">
              <span className="interest-text">{item.text}</span>
              <div className="interest-actions">
                <button className="abtn" onClick={() => void testInterest(item.id)} disabled={!!discoveringId || interestBusy}>{t(lang, "interestDiscover")}</button>
                <button className="abtn" onClick={() => startEditInterest(item)} disabled={interestBusy}>{t(lang, "interestEdit")}</button>
                <button className="abtn danger" onClick={() => void removeInterest(item.id)} disabled={interestBusy}>{t(lang, "interestDelete")}</button>
              </div>
            </li>
          )
        )}
      </ul>
      {interests.length === 0 && <div className="note">{t(lang, "interestEmpty")}</div>}
      <div className="counter ltr">{interests.length}/10</div>

      <div aria-live="polite" aria-busy={!!discoveringId}>
        {discoveringId && <p className="note">{t(lang, "interestDiscovering")}</p>}
        {discoveryError && <p className="err" role="alert">{discoveryError}</p>}
        {discovery && <section className="interest-results">
          <h3>{discovery.interest}</h3>
          <p className="note">{t(lang, "interestDiscoverStats")}: {discovery.diagnostics.found} / {discovery.diagnostics.accepted} / {discovery.diagnostics.directlyVerified}</p>
          {discovery.diagnostics.unverifiedAccepted > 0 && <p className="note">{t(lang, "interestDiscoverUnverified")}: {discovery.diagnostics.unverifiedAccepted}</p>}
          {discovery.diagnostics.unprocessed > 0 && <p className="note">{t(lang, "interestUnprocessed")}: {discovery.diagnostics.unprocessed}</p>}
          {(discovery.diagnostics.incomplete || discovery.diagnostics.errors.length > 0) && <p className="note">{t(lang, "interestDiscoverPartial")}</p>}
          {(discovery.diagnostics.errors.length > 0 || discovery.diagnostics.warnings.length > 0 || discovery.diagnostics.sources.length > 0 || discovery.diagnostics.disabledSources.length > 0) && <details>
            <summary>{t(lang, "interestDiscoverDetails")}</summary>
            {discovery.diagnostics.sources.map(source=><p className="note" key={source.source}>{source.source} — {t(lang, "interestSourceStats")}: {source.accessible ? "✓" : "✗"} / {source.entriesRead} / {source.relevant} / {source.verified}{source.latestPublishedAt ? ` · ${source.latestPublishedAt}` : ""}{Object.entries(source.reasons).map(([reason,count])=>` · ${reason}: ${count}`).join("")}</p>)}
            {discovery.diagnostics.disabledSources.map(source=><p className="note" key={source.source}>{t(lang,"interestSourceDisabled")}: {source.source} — {source.reason}</p>)}
            <ul>{[...discovery.diagnostics.errors, ...discovery.diagnostics.warnings].map((message, index) => <li className="note" key={index}>{message}</li>)}</ul>
          </details>}
          {discovery.results.length === 0 ? <p className="note">{t(lang, "interestDiscoverEmpty")}</p> : <ul>
            {discovery.results.map(item => <li key={item.url}>
              <a href={item.url} target="_blank" rel="noopener noreferrer">{item.title}</a>
              <div className="note">{item.source} · {item.sourceRole === 'institutional_self_declared' ? t(lang,"interestInstitution") : item.sourceRole === 'news_agency' ? t(lang,"interestNewsAgency") : t(lang, "interestDiscoverVerified")} · {item.sourceType === "telegram" ? "Telegram · " : ""}{item.publishedAt ? new Date(item.publishedAt).toLocaleDateString(lang === "ar" ? "ar-SY" : "en-GB") : t(lang, "interestDiscoverDateMissing")}</div>
            </li>)}
          </ul>}
        </section>}
      </div>

      <div className="rule" style={{ marginTop: 24 }}></div>
      <button className="abtn danger" onClick={cancel} disabled={busy}>
        {t(lang, "cancelSub")}
      </button>
    </div>
  );
}
