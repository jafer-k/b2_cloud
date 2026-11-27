import { createClient } from '@libsql/client';

const db = createClient({
  url:       process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

function validateSQL(sql) {
  if (typeof sql !== 'string' || !sql.trim()) return 'sql required';
  const t = sql.trim();
  if (t.split(';').filter(s => s.trim()).length > 1) return 'one statement only';
  const u = t.toUpperCase();
  if (!['INSERT', 'UPDATE', 'SELECT'].some(k => u.startsWith(k)))
    return 'only INSERT / UPDATE / SELECT';
  if (!/\bb2_cloud\b/i.test(t)) return 'only b2_cloud allowed';
  return null;
}

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'POST only' });

  // Auth
  if (req.headers['x-api-key'] !== process.env.API_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const { sql, params } = req.body ?? {};
  const err = validateSQL(sql);
  if (err) return res.status(400).json({ error: err });
  if (!Array.isArray(params))
    return res.status(400).json({ error: 'params must be an array' });

  try {
    const result = await db.execute({ sql: sql.trim(), args: params });
    return res.status(200).json({
      changes:         result.rowsAffected ?? 0,
      lastInsertRowid: result.lastInsertRowid != null
                         ? String(result.lastInsertRowid) : null,
      rows:            result.rows    ?? [],
      columns:         result.columns ?? [],
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
