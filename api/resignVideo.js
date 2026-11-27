// api/resignVideo.js
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const REQUIRED = ['B2_ENDPOINT', 'B2_KEY_ID', 'B2_APP_KEY', 'B2_BUCKET_NAME', 'API_KEY'];
const MISSING  = REQUIRED.filter(k => !process.env[k]);

const s3 = MISSING.length === 0 ? new S3Client({
  endpoint: process.env.B2_ENDPOINT,
  region:   process.env.B2_REGION || 'us-east-005',
  credentials: {
    accessKeyId:     process.env.B2_KEY_ID,
    secretAccessKey: process.env.B2_APP_KEY,
  },
  forcePathStyle: true,
}) : null;

const BUCKET    = process.env.B2_BUCKET_NAME;
const TTL       = 7 * 24 * 60 * 60;
const MAX_ITEMS = 100;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'POST only' });

  if (MISSING.length > 0) {
    return res.status(500).json({ error: 'missing env vars: ' + MISSING.join(', ') });
  }
  if (req.headers['x-api-key'] !== process.env.API_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  let body = req.body;
  if (Buffer.isBuffer(body)) body = body.toString('utf8');
  if (typeof body === 'string') {
    try { body = JSON.parse(body); }
    catch { return res.status(400).json({ error: 'invalid JSON' }); }
  }
  if (!body || typeof body !== 'object') body = {};

  /* --- request: { items: [{ file_key, user_id, video_key }] } --- */
  const items = Array.isArray(body.items)
    ? body.items
        .map(it => ({
          file_key:  it && typeof it.file_key  === 'string' ? it.file_key.trim()  : null,
          user_id:   it && typeof it.user_id   === 'string' ? it.user_id.trim()   : null,
          video_key: it && typeof it.video_key === 'string' ? it.video_key.trim() : '',
        }))
        .filter(it => it.video_key)
    : [];

  if (items.length === 0)       return res.status(400).json({ error: 'items array required' });
  if (items.length > MAX_ITEMS) return res.status(400).json({ error: `max ${MAX_ITEMS} items per request` });

  /* --- response: { results: [{ file_key, user_id, video_url }] } --- */
  const results = [];
  for (const item of items) {
    try {
      const video_url = await getSignedUrl(
        s3,
        new GetObjectCommand({ Bucket: BUCKET, Key: item.video_key }),
        { expiresIn: TTL },
      );
      results.push({ file_key: item.file_key, user_id: item.user_id, video_url });
    } catch {
      results.push({ file_key: item.file_key, user_id: item.user_id, video_url: null });
    }
  }

  return res.status(200).json({ results });
}
