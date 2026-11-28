import type { Topic } from "./i18n";

export interface Article {
  id: string;
  title: string;
  summary: string | null;
  url: string;
  source: string;
  topic: Topic;
  scope: "syria" | "global";
  published_at: string | null;
  fetched_at?: string;
}

export interface NewsQuery {
  scope?: "syria" | "global";
  topic?: Topic;
  page?: number;
  limit?: number;
}

export interface NewsPage {
  articles: Article[];
  page: number;
  limit: number;
  has_more: boolean;
}

export interface Subscriber {
  id: string;
  email: string;
  whatsapp: string | null;
  telegram_chat_id: string | null;
  language: "ar" | "en";
  delivery_hour: number;
  status: "trial" | "pending" | "active" | "expired" | "paused" | "cancelled";
  trial_ends_at: string | null;
  expires_at: string | null;
  created_at: string;
  topics: Topic[];
}

export interface Interest {
  id: string;
  text: string;
  created_at: string;
  updated_at: string;
  monitoring_status?: 'pending' | 'source_linked' | 'no_source' | 'temporary_failure';
  error_code?: string | null;
}

export interface LiveInterestReport {
  interestId: string;
  mode: "live";
  interest: string;
  results: { title: string; source: string; url: string; publishedAt: string | null; interest: string; sourceType: "website" | "telegram"; sourceRole:string; verification: string }[];
  diagnostics: { found: number; accepted: number; rejected: number; unprocessed: number; directlyVerified: number; unverifiedAccepted: number; duplicates: number; requests: number; requestLimit: number; errors: string[]; warnings: string[]; incomplete: boolean;
    sources:{source:string;role:string;accessible:boolean;entriesRead:number;relevant:number;accepted:number;rejected:number;unprocessed:number;verified:number;latestPublishedAt:string|null;reasons:Record<string,number>}[];
    disabledSources:{source:string;reason:string}[] };
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

export interface SubscribeResult {
  ok: boolean;
  status?: "pending" | "existing";
  manage_url?: string;
  telegram?: { code: string; bot: string };
}

export const api = {
  subscribe: (p: { email: string; topics: string[]; delivery_hour: number; language: string }) =>
    req<SubscribeResult>("/api/subscribe", { method: "POST", body: JSON.stringify(p) }),
  login: (email: string) =>
    req<{ ok: boolean; manage_url?: string }>("/api/login", { method: "POST", body: JSON.stringify({ email }) }),
  me: (token: string) => req<{ subscriber: Subscriber }>("/api/me?token=" + encodeURIComponent(token)),
  updateMe: (token: string, p: { topics?: string[]; delivery_hour?: number; language?: string; whatsapp?: string | null }) =>
    req<{ ok: boolean }>("/api/me?token=" + encodeURIComponent(token), { method: "PATCH", body: JSON.stringify(p) }),
  cancelMe: (token: string) =>
    req<{ ok: boolean }>("/api/me?token=" + encodeURIComponent(token), { method: "DELETE" }),
  news: (p: NewsQuery = {}) => {
    const qs = new URLSearchParams();
    if (p.scope) qs.set("scope", p.scope);
    if (p.topic) qs.set("topic", p.topic);
    if (p.page) qs.set("page", String(p.page));
    if (p.limit) qs.set("limit", String(p.limit));
    const suffix = qs.size ? "?" + qs.toString() : "";
    return req<NewsPage>("/api/news" + suffix);
  },
  config: () => req<{ telegram_bot: string | null }>("/api/config"),
  createTelegramLink: (token: string) =>
    req<{ token: string; expires_at: string }>("/api/telegram/link", { method: "POST", headers: { authorization: "Bearer " + token } }),
  interests: (token: string) =>
    req<{ interests: Interest[] }>("/api/interests", { headers: { authorization: "Bearer " + token } }),
  addInterest: (token: string, text: string) =>
    req<{ interest: Interest }>("/api/interests", { method: "POST", headers: { authorization: "Bearer " + token }, body: JSON.stringify({ text }) }),
  updateInterest: (token: string, id: string, text: string) =>
    req<{ ok: boolean }>("/api/interests", { method: "PATCH", headers: { authorization: "Bearer " + token }, body: JSON.stringify({ id, text }) }),
  deleteInterest: (token: string, id: string) =>
    req<{ ok: boolean }>("/api/interests?id=" + encodeURIComponent(id), { method: "DELETE", headers: { authorization: "Bearer " + token } }),
  discoverInterest: (token: string, id: string) =>
    req<LiveInterestReport>("/api/interests/discover", { method: "POST", headers: { authorization: "Bearer " + token }, body: JSON.stringify({ id, mode: "live" }) }),
};

export const adminApi = {
  login: (password: string) =>
    req<{ token: string }>("/api/admin/login", { method: "POST", body: JSON.stringify({ password }) }),
  list: (token: string) =>
    req<{
      subscribers: ((Omit<Subscriber, "topics">) & { topics: Topic[]; telegram_linked: boolean; telegram_paused: boolean })[];
      stats: { total: number; pending: number; trial: number; active: number; expired: number; articles_24h: number };
    }>("/api/admin/subscribers", { headers: { authorization: "Bearer " + token } }),
  action: (token: string, id: string, action: string) =>
    req<{ ok: boolean; expires_at?: string }>("/api/admin/subscribers", {
      method: "POST",
      headers: { authorization: "Bearer " + token },
      body: JSON.stringify({ id, action }),
    }),
};
