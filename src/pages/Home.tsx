import { useEffect, useMemo, useState } from "react";
import { api, type Article } from "../lib/api";
import { t, timeAgo, TOPICS, type Topic } from "../lib/i18n";
import type { PageProps } from "../App";

export interface HomeFocus {
  scope?: "syria" | "global";
  topic?: Topic;
}

function ArticleCard({ a, lang }: { a: Article; lang: "ar" | "en" }) {
  return (
    <article className="card">
      <div className="card-tags">
        <span className={"tag" + (a.scope === "syria" ? "" : " navy")}>
          {t(lang, "scope_" + a.scope)}
        </span>
        <span className="tag quiet">{t(lang, "topic_" + a.topic)}</span>
      </div>
      <h3 className="card-title">
        <a href={a.url} target="_blank" rel="noreferrer noopener">
          {a.title}
        </a>
      </h3>
      {a.summary && <p className="card-summary">{a.summary}</p>}
      <div className="card-meta">
        <span>{a.source}</span>
        <span aria-hidden="true">·</span>
        <span>{timeAgo(lang, a.published_at || a.fetched_at || new Date().toISOString())}</span>
      </div>
    </article>
  );
}

function Skeleton() {
  return (
    <div className="news-grid" aria-hidden="true">
      {[0, 1, 2, 3].map((i) => (
        <div className="card skeleton" key={i}>
          <div className="sk-line w40"></div>
          <div className="sk-line w90"></div>
          <div className="sk-line w70"></div>
        </div>
      ))}
    </div>
  );
}

export default function Home({ lang, nav, focus }: PageProps & { focus?: HomeFocus }) {
  const scope = focus?.scope;
  const topic = focus?.topic;
  const [items, setItems] = useState<Article[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState(1);

  const load = async (p: number, replace: boolean) => {
    setBusy(true);
    setError(false);
    try {
      const res = await api.news({ scope, topic, page: p, limit: scope || topic ? 15 : 24 });
      setItems((prev) => (replace || !prev ? res.articles : [...prev, ...res.articles]));
      setHasMore(res.has_more);
      setPage(p);
    } catch {
      setError(true);
      if (replace) setItems([]);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    setItems(null);
    setHasMore(false);
    void load(1, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, topic]);

  const filtered = !!(scope || topic);
  const syria = useMemo(() => (items || []).filter((a) => a.scope === "syria").slice(0, 6), [items]);
  const world = useMemo(() => (items || []).filter((a) => a.scope !== "syria").slice(0, 6), [items]);

  return (
    <div>
      {!filtered && (
        <section className="hero">
          <div className="kicker">{t(lang, "tagline")}</div>
          <h1 className="hero-title">{t(lang, "heroTitle")}</h1>
          <p className="hero-sub">{t(lang, "heroSub")}</p>
          <button className="cta" onClick={() => nav("/subscribe")}>
            {t(lang, "cta")}
          </button>
        </section>
      )}

      <div className="rule"></div>

      <nav className="filters" aria-label={t(lang, "filtersLabel")}>
        <div className="chips-row">
          <button className={"chip" + (!scope && !topic ? " on" : "")} onClick={() => nav("/")}>
            {t(lang, "filterAll")}
          </button>
          <button className={"chip" + (scope === "syria" ? " on" : "")} onClick={() => nav("/syria")}>
            {t(lang, "scope_syria")}
          </button>
          <button className={"chip" + (scope === "global" ? " on" : "")} onClick={() => nav("/global")}>
            {t(lang, "scope_global")}
          </button>
        </div>
        <div className="chips-row topics-row">
          {TOPICS.map((x) => (
            <button
              key={x}
              className={"chip small" + (topic === x ? " on" : "")}
              onClick={() => nav("/topic/" + x)}
            >
              {t(lang, "topic_" + x)}
            </button>
          ))}
        </div>
      </nav>

      {error && (
        <div className="errorbox" role="alert">
          <p>{t(lang, "errorNews")}</p>
          <button className="abtn primary" onClick={() => void load(1, true)}>
            {t(lang, "retry")}
          </button>
        </div>
      )}

      {items === null && !error && <Skeleton />}

      {items !== null && items.length === 0 && !error && (
        <div className="emptybox">
          <h2>{t(lang, "emptyNews")}</h2>
          <p>{t(lang, "emptyNewsHint")}</p>
          <button className="abtn" onClick={() => nav("/")}>
            {t(lang, "filterAll")}
          </button>
        </div>
      )}

      {items !== null && !filtered && items.length > 0 && (
        <>
          <section className="sec">
            {t(lang, "sectionSyria")}
            <button className="seclink" onClick={() => nav("/syria")}>
              {t(lang, "viewAll")} ←
            </button>
          </section>
          <div className="news-grid">
            {syria.map((a) => (
              <ArticleCard a={a} lang={lang} key={a.id} />
            ))}
          </div>

          <div className="rule"></div>
          <section className="sec">
            {t(lang, "sectionWorld")}
            <button className="seclink" onClick={() => nav("/global")}>
              {t(lang, "viewAll")} ←
            </button>
          </section>
          <div className="news-grid">
            {world.map((a) => (
              <ArticleCard a={a} lang={lang} key={a.id} />
            ))}
          </div>
        </>
      )}

      {items !== null && filtered && items.length > 0 && (
        <>
          <section className="sec">
            {topic ? t(lang, "topic_" + topic) : scope === "syria" ? t(lang, "sectionSyria") : t(lang, "sectionWorld")}
            <span className="n">{items.length}</span>
          </section>
          <div className="news-grid">
            {items.map((a) => (
              <ArticleCard a={a} lang={lang} key={a.id} />
            ))}
          </div>
        </>
      )}

      {items !== null && hasMore && !busy && !error && (
        <div className="loadmore">
          <button className="abtn primary" onClick={() => void load(page + 1, false)}>
            {t(lang, "loadMore")}
          </button>
        </div>
      )}
      {busy && items !== null && <div className="note">{t(lang, "loading")}</div>}

      {!filtered && (
        <>
          <div className="rule"></div>
          <section className="sec">{t(lang, "topicsTitle")}</section>
          <p className="hero-sub" style={{ marginBottom: 0 }}>{t(lang, "topicsSub")}</p>
          <div className="topics">
            {TOPICS.map((x) => (
              <button className="topic-card" key={x} onClick={() => nav("/topic/" + x)}>
                <h3>{t(lang, "topic_" + x)}</h3>
                <p>{t(lang, "topicHint")}</p>
              </button>
            ))}
          </div>

          <div className="rule"></div>
          <section className="sec">{t(lang, "howTitle")}</section>
          <div className="steps">
            {["1", "2", "3"].map((n, i) => (
              <div className="step-card" key={n}>
                <div className="step-num ltr">{n}</div>
                <div>
                  <h3>{t(lang, `step${i + 1}t`)}</h3>
                  <p>{t(lang, `step${i + 1}d`)}</p>
                </div>
              </div>
            ))}
          </div>

          <div className="subscribe-banner">
            <div>
              <h3>{t(lang, "subscribeTitle")}</h3>
              <p>{t(lang, "subscribeSub")}</p>
            </div>
            <button className="cta compact" onClick={() => nav("/subscribe")}>
              {t(lang, "cta")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
