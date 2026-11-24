import { type Handler, fail, json, nowISO, readJson, uuid } from './_lib';

const LIMIT = 10;
type Interest = { id: string; text: string; created_at: string; updated_at: string };

// Accept the existing management token, never a subscriber ID or email as proof of identity.
export async function owner(request: Request, env: Parameters<Handler>[0]['env'], headerOnly = false): Promise<string | null> {
  const authorization = request.headers.get('authorization') || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : headerOnly ? '' : new URL(request.url).searchParams.get('token') || '';
  if (!token) return null;
  const row = await env.DB.prepare('SELECT id, magic_expires FROM subscribers WHERE magic_token=?').bind(token).first<{id:string; magic_expires:string | null}>();
  if (!row || (row.magic_expires && row.magic_expires < nowISO())) return null;
  return row.id;
}

export function normalizeInterest(text: string): string {
  return text.normalize('NFKC').toLowerCase()
    .replace(/[\u064b-\u065f\u0670ـ]/g, '')
    .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}

function validated(value: unknown): {text:string; normalized:string} | null {
  if (typeof value !== 'string' || /[\p{Cc}\p{Cs}]/u.test(value)) return null;
  const text = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  const n = Array.from(text).length;
  const normalized = normalizeInterest(text);
  if (n < 3 || n > 300 || Array.from(normalized.replace(/\s/g, '')).length < 3) return null;
  return {text, normalized};
}

export const onRequestGet: Handler = async ({request, env}) => {
  if (!env.DB) return fail('database not bound', 500);
  const id = await owner(request, env); if (!id) return fail('invalid or expired token', 401);
  const rows = await env.DB.prepare('SELECT id, text, created_at, updated_at FROM subscriber_interests WHERE subscriber_id=? ORDER BY created_at, id').bind(id).all<Interest>();
  return json({interests: rows.results});
};

export const onRequestPost: Handler = async ({request, env}) => {
  if (!env.DB) return fail('database not bound', 500);
  const id = await owner(request, env); if (!id) return fail('invalid or expired token', 401);
  const body = await readJson<{text?:unknown} | null>(request); const value = validated(body?.text);
  if (!value) return fail('interest must contain 3 to 300 characters of text');
  const itemId = uuid(), now = nowISO();
  const result = await env.DB.prepare('INSERT INTO subscriber_interests (id,subscriber_id,text,normalized_text,created_at,updated_at) SELECT ?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM subscriber_interests WHERE subscriber_id=?) < ? ON CONFLICT(subscriber_id,normalized_text) DO NOTHING')
    .bind(itemId,id,value.text,value.normalized,now,now,id,LIMIT).run();
  if (!result.meta.changes) {
    const duplicate = await env.DB.prepare('SELECT id FROM subscriber_interests WHERE subscriber_id=? AND normalized_text=?').bind(id,value.normalized).first<{id:string}>();
    return fail(duplicate ? 'interest already exists' : 'interest limit reached', 409);
  }
  return json({interest:{id:itemId,text:value.text,created_at:now,updated_at:now}}, 201);
};

export const onRequestPatch: Handler = async ({request, env}) => {
  if (!env.DB) return fail('database not bound', 500);
  const ownerId = await owner(request, env); if (!ownerId) return fail('invalid or expired token', 401);
  const body = await readJson<{id?:unknown; text?:unknown} | null>(request); const value = validated(body?.text);
  if (!body || typeof body.id !== 'string' || !body.id || !value) return fail('invalid interest id or text');
  const current = await env.DB.prepare('SELECT id FROM subscriber_interests WHERE id=? AND subscriber_id=?').bind(body.id,ownerId).first<{id:string}>();
  if (!current) return fail('interest not found',404);
  const duplicate = await env.DB.prepare('SELECT id FROM subscriber_interests WHERE subscriber_id=? AND normalized_text=? AND id<>?').bind(ownerId,value.normalized,body.id).first<{id:string}>();
  if (duplicate) return fail('interest already exists',409);
  // Avoid a uniqueness exception if a concurrent request inserts the same interest.
  const result = await env.DB.prepare('UPDATE OR IGNORE subscriber_interests SET text=?, normalized_text=?, updated_at=? WHERE id=? AND subscriber_id=?').bind(value.text,value.normalized,nowISO(),body.id,ownerId).run();
  if (!result.meta.changes) return fail('interest conflict or not found',409);
  return json({ok:true});
};

export const onRequestDelete: Handler = async ({request, env}) => {
  if (!env.DB) return fail('database not bound', 500);
  const ownerId = await owner(request, env); if (!ownerId) return fail('invalid or expired token', 401);
  const id = new URL(request.url).searchParams.get('id') || '';
  if (!id) return fail('missing interest id');
  const result = await env.DB.prepare('DELETE FROM subscriber_interests WHERE id=? AND subscriber_id=?').bind(id,ownerId).run();
  return result.meta.changes ? json({ok:true}) : fail('interest not found',404);
};
