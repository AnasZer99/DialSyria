import { useState } from "react";
import { api } from "../lib/api";
import { t, TOPICS, type Lang, type Topic } from "../lib/i18n";
import type { PageProps } from "../App";

const SLOT_CHOICES = [7, 12, 18];

export default function Subscribe({ lang, nav }: PageProps) {
  const [email, setEmail] = useState("");
  const [whatsapp, setWhatsapp] = useState("");
  const [topics, setTopics] = useState<Set<Topic>>(new Set(["politics"]));
  const [hour, setHour] = useState<number>(7);
  const [digestLang, setDigestLang] = useState<Lang>(lang);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ manage_url?: string } | null>(null);

  const toggleTopic = (x: Topic) => {
    setTopics((prev) => {
      const next = new Set(prev);
      if (next.has(x)) next.delete(x);
      else if (next.size < 3) next.add(x);
      else return prev;
      return next;
    });
  };

  const submit = async () => {
    setError("");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return setError(t(lang, "errorEmail"));
    if (topics.size < 1 || topics.size > 3) return setError(t(lang, "errorTopics"));
    if (!(hour >= 0 && hour <= 23)) return setError(t(lang, "errorHour"));
    setBusy(true);
    try {
      const r = await api.subscribe({
        email,
        topics: [...topics],
        delivery_hour: hour,
        language: digestLang,
        whatsapp: whatsapp.trim() || undefined,
      });
      setDone({ manage_url: r.manage_url });
    } catch (e) {
      setError(e instanceof Error ? t(lang, "errorGeneric") + " — " + e.message : t(lang, "errorGeneric"));
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className="form">
        <div className="okbox">
          <h2>{t(lang, "successTitle")}</h2>
          <p>{t(lang, "successSub")}</p>
          {done.manage_url && (
            <button
              className="cta"
              style={{ marginTop: 14 }}
              onClick={() => {
                window.location.href = done.manage_url!;
              }}
            >
              {t(lang, "openManage")}
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="form">
      <div className="kicker">{t(lang, "subscribeTitle")}</div>
      <h1 className="hero-title" style={{ fontSize: 26 }}>{t(lang, "subscribeTitle")}</h1>
      <p className="hero-sub">{t(lang, "subscribeSub")}</p>

      <div className="step"><span className="ltr">1</span> {t(lang, "stepEmail")}</div>
      <input className="field" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" />

      <div className="step"><span className="ltr">2</span> {t(lang, "stepWhats")}</div>
      <input className="field ltr" type="tel" value={whatsapp} onChange={(e) => setWhatsapp(e.target.value)} placeholder="+963 9XX XXX XXX" />

      <div className="step"><span className="ltr">3</span> {t(lang, "stepTopics")}</div>
      <div className="chips">
        {TOPICS.map((x) => (
          <button key={x} className={"chip" + (topics.has(x) ? " on" : "")} onClick={() => toggleTopic(x)}>
            {t(lang, "topic_" + x)}
          </button>
        ))}
      </div>
      <div className="counter ltr">{topics.size}/3</div>

      <div className="step"><span className="ltr">4</span> {t(lang, "stepTime")}</div>
      <div className="slots">
        {SLOT_CHOICES.map((h) => (
          <button key={h} className={"slot ltr" + (hour === h ? " on" : "")} onClick={() => setHour(h)}>
            {String(h).padStart(2, "0")}:00
          </button>
        ))}
      </div>
      <select
        className="field ltr"
        style={{ marginTop: 8, maxWidth: 180 }}
        value={hour}
        aria-label={t(lang, "stepTime")}
        onChange={(e) => setHour(Number(e.target.value))}
      >
        {Array.from({ length: 24 }, (_, h) => (
          <option key={h} value={h}>
            {String(h).padStart(2, "0")}:00
          </option>
        ))}
      </select>

      <div className="step"><span className="ltr">5</span> {t(lang, "stepLang")}</div>
      <div className="slots">
        <button className={"slot" + (digestLang === "ar" ? " on" : "")} onClick={() => setDigestLang("ar")}>
          عربية
        </button>
        <button className={"slot" + (digestLang === "en" ? " on" : "")} onClick={() => setDigestLang("en")}>
          English
        </button>
      </div>

      <div className="pricebar">
        <span className="p ltr">{lang === "ar" ? "10$ شهرياً" : "$10/month"}</span>
        <span className="q">{t(lang, "trialNote")}</span>
      </div>
      <button className="cta" style={{ marginTop: 14 }} onClick={submit} disabled={busy}>
        {t(lang, "confirm")}
      </button>
      {error && <div className="err">{error}</div>}
      <div className="note">
        <a
          href="/"
          onClick={(e) => {
            e.preventDefault();
            nav("/");
          }}
        >
          Dial<b>Syria</b>
        </a>
      </div>
    </div>
  );
}
