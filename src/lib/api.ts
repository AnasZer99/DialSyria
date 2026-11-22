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

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

export const api = {
  subscribe: (p: { email: string; topics: string[]; delivery_hour: number; language: string; whatsapp?: string }) =>
    req<{ ok: boolean; manage_url?: string }>("/api/subscribe", { method: "POST", body: JSON.stringify(p) }),
  login: (email: string) =>
    req<{ ok: boolean; manage_url?: string }>("/api/login", { method: "POST", body: JSON.stringify({ email }) }),
  me: (token: string) => req<{ subscriber: Subscriber }>("/api/me?token=" + encodeURIComponent(token)),
  updateMe: (token: string, p: { topics?: string[]; delivery_hour?: number; language?: string; whatsapp?: string | null }) =>
    req<{ ok: boolean }>("/api/me?token=" + encodeURIComponent(token), { method: "PATCH", body: JSON.stringify(p) }),
  cancelMe: (token: string) =>
    req<{ ok: boolean }>("/api/me?token=" + encodeURIComponent(token), { method: "DELETE" }),
  news: () => req<{ articles: Article[] }>("/api/news"),
  config: () => req<{ telegram_bot: string | null }>("/api/config"),
};

export const adminApi = {
  login: (password: string) =>
    req<{ token: string }>("/api/admin/login", { method: "POST", body: JSON.stringify({ password }) }),
  list: (token: string) =>
    req<{
      subscribers: (Subscriber & { topics: Topic[] })[];
      stats: { total: number; pending: number; trial: number; active: number; expired: number; articles_24h: number };
    }>("/api/admin/subscribers", { headers: { authorization: "Bearer " + token } }),
  action: (token: string, id: string, action: string) =>
    req<{ ok: boolean; expires_at?: string }>("/api/admin/subscribers", {
      method: "POST",
      headers: { authorization: "Bearer " + token },
      body: JSON.stringify({ id, action }),
    }),
};
