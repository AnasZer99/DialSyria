import { useEffect, useState } from "react";
import { api, type Article } from "../lib/api";
import { t, timeAgo, TOPICS } from "../lib/i18n";
import type { PageProps } from "../App";

export default function Home({ lang, nav }: PageProps) {
  const [articles, setArticles] = useState<Article[] | null>(null);

  useEffect(() => {
    api.news().then((r) => setArticles(r.articles)).catch(() => setArticles([]));
  }, []);

  return (
    <div>
      <section className="hero">
        <div className="kicker">{t(lang, "tagline")}</div>
        <h1 className="hero-title">{t(lang, "heroTitle")}</h1>
        <p className="hero-sub">{t(lang, "heroSub")}</p>
        <button className="cta" onClick={() => nav("/beta")}>
          {lang === 'ar' ? 'ابدأ تجربتك' : 'Start your beta'}
        </button>
        <a
          className="sublink"
          href="#news"
          onClick={(e) => {
            e.preventDefault();
            document.getElementById("news")?.scrollIntoView({ behavior: "auto", block: "start" });
          }}
        >
          {t(lang, "browseNews")}
        </a>
      </section>

      <div className="rule"></div>
      <div className="sec" id="news">
        {t(lang, "topStories")} <span className="n ltr">24h</span>
      </div>
      <div>
        {articles === null && <div className="note">{t(lang, "loading")}</div>}
        {articles?.map((a) => (
          <div className="story" key={a.id}>
            <span className={"tag" + (a.scope === "syria" ? "" : " navy")}>
              {t(lang, "scope_" + a.scope)} — {t(lang, "topic_" + a.topic)}
            </span>
            <div className="t">
              <a href={a.url} target="_blank" rel="noreferrer" style={{ color: "inherit", textDecoration: "none" }}>
                {a.title}
              </a>
            </div>
            {a.summary && <div className="meta" style={{ lineHeight: 1.9 }}>{a.summary}</div>}
            <div className="meta">
              {a.source} · {a.published_at ? timeAgo(lang, a.published_at) : ""}
            </div>
          </div>
        ))}
      </div>

      <div className="rule"></div>
      <div className="sec">{t(lang, "topicsTitle")}</div>
      <p className="hero-sub" style={{ marginBottom: 0 }}>{t(lang, "topicsSub")}</p>
      <div className="topics">
        {TOPICS.map((x) => (
          <div className="topic-card" key={x}>
            <h3>{t(lang, "topic_" + x)}</h3>
          </div>
        ))}
      </div>

      <div className="rule"></div>
      <div className="sec">{t(lang, "howTitle")}</div>
      <div className="steps">
        <div className="step-card">
          <div className="step-num ltr">1</div>
          <div>
            <h3>{t(lang, "step1t")}</h3>
            <p>{t(lang, "step1d")}</p>
          </div>
        </div>
        <div className="step-card">
          <div className="step-num ltr">2</div>
          <div>
            <h3>{t(lang, "step2t")}</h3>
            <p>{t(lang, "step2d")}</p>
          </div>
        </div>
        <div className="step-card">
          <div className="step-num ltr">3</div>
          <div>
            <h3>{t(lang, "step3t")}</h3>
            <p>{t(lang, "step3d")}</p>
          </div>
        </div>
        <div className="step-card">
          <div className="step-num ltr">4</div>
          <div>
            <h3>{t(lang, "step4t")}</h3>
            <p>{t(lang, "step4d")}</p>
          </div>
        </div>
      </div>

      <div className="pricing">
        <p>{lang === 'ar' ? 'تجربة مغلقة لعدد محدود؛ تغطية المصادر المحلية محدودة وقيد الاختبار.' : 'A limited closed beta; local source coverage is still being tested.'}</p>
        <button className="cta" onClick={() => nav("/beta")}>{lang === 'ar' ? 'ابدأ تجربتك' : 'Start your beta'}</button>
      </div>
    </div>
  );
}
