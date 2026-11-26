// api/health.js
import { createClient } from '@libsql/client';

const db = createClient({
  url:       process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('db timeout after ' + ms + 'ms')), ms)
    ),
  ]);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'X-API-Key');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET')     return res.status(405).json({ ok: false, error: 'GET only' });

  if (req.headers['x-api-key'] !== process.env.API_KEY) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const started = Date.now();

  try {
    const result = await withTimeout(
      db.execute('SELECT COUNT(*) AS n FROM "b2_cloud"'),
      4000
    );

    const rows     = result.rows || [];
    const rowCount = rows.length && rows[0].n != null ? Number(rows[0].n) : null;

    return res.status(200).json({
      ok:        true,
      db:        'connected',
      table:     'b2_cloud',
      rowCount,
      latencyMs: Date.now() - started,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(503).json({
      ok:        false,
      db:        'unreachable',
      error:     err.message || String(err),
      latencyMs: Date.now() - started,
      timestamp: new Date().toISOString(),
    });
  }
}
