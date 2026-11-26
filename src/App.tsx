import { useEffect, useState, type ReactNode } from "react";
import { t, setDocLang, type Lang } from "./lib/i18n";
import Home from "./pages/Home";
import Subscribe from "./pages/Subscribe";
import Manage from "./pages/Manage";
import Admin from "./pages/Admin";
import Beta from "./pages/Beta";

export interface PageProps {
  lang: Lang;
  toggleLang: () => void;
  nav: (to: string) => void;
}

export default function App() {
  const [lang, setLang] = useState<Lang>((localStorage.getItem("ds_lang") as Lang) || "ar");
  const [path, setPath] = useState(window.location.pathname);

  useEffect(() => {
    setDocLang(lang);
    localStorage.setItem("ds_lang", lang);
  }, [lang]);

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const toggleLang = () => setLang((l) => (l === "ar" ? "en" : "ar"));
  const nav = (to: string) => {
    window.history.pushState({}, "", to);
    setPath(to.split("?")[0]);
    window.scrollTo(0, 0);
  };

  const props: PageProps = { lang, toggleLang, nav };

  let page: ReactNode;
  if (path === "/subscribe") page = <Subscribe {...props} />;
  else if (path === "/beta") page = <Beta {...props} />;
  else if (path === "/manage") page = new URLSearchParams(window.location.search).has('token') ? <Manage {...props} /> : <Beta {...props} />;
  else if (path === "/admin") page = <Admin {...props} />;
  else page = <Home {...props} />;

  return (
    <div className="app">
      <header className="wrap">
        <div className="head">
          <a
            className="logo"
            href="/"
            onClick={(e) => {
              e.preventDefault();
              nav("/");
            }}
          >
            Dial<b>Syria</b>
          </a>
          <button className="lang" onClick={toggleLang}>
            {t(lang, "langToggle")}
          </button>
        </div>
      </header>
      <main className="wrap">{page}</main>
      <footer className="wrap">{t(lang, "footer")}</footer>
    </div>
  );
}
