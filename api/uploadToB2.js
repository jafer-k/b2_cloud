// api/uploadToB2.js
import { createClient } from '@libsql/client';
import { S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { Readable } from 'node:stream';
import { Transform } from 'node:stream';

/* ---------- env ---------- */
const REQUIRED = [
  'TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN', 'API_KEY',
  'B2_ENDPOINT', 'B2_KEY_ID', 'B2_APP_KEY', 'B2_BUCKET_NAME',
];
const MISSING = REQUIRED.filter(k => !process.env[k]);

const db = MISSING.length === 0 ? createClient({
  url:       process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
}) : null;

const s3 = MISSING.length === 0 ? new S3Client({
  endpoint: process.env.B2_ENDPOINT,
  region:   process.env.B2_REGION || 'us-east-005',
  credentials: {
    accessKeyId:     process.env.B2_KEY_ID,
    secretAccessKey: process.env.B2_APP_KEY,
  },
  forcePathStyle: true,
}) : null;

const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');

/* ---------- helpers ---------- */
function safeName(s, max = 100) {
  return String(s ?? '').trim().replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, max);
}

async function fetchAndUploadOLD(url, key, contentType) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`fetch HTTP ${res.status}`);
  if (!res.body) throw new Error('empty response body');
  await new Upload({
    client: s3,
    params: {
      Bucket:      process.env.B2_BUCKET_NAME,
      Key:         key,
      Body:        Readable.fromWeb(res.body),
      ContentType: contentType,
    },
  }).done();
}
async function fetchAndUpload(url, key, contentType) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`fetch HTTP ${res.status}`);
  if (!res.body) throw new Error('empty response body');

  let bytes = 0;
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      bytes += chunk.length;
      cb(null, chunk);
    },
  });

  const src = Readable.fromWeb(res.body);
  src.pipe(counter);

  await new Upload({
    client: s3,
    params: {
      Bucket:      process.env.B2_BUCKET_NAME,
      Key:         key,
      Body:        counter,
      ContentType: contentType,
    },
  }).done();

  return bytes;
}

function resolveUrl(key, req) {
  if (!key) return null;
  const base = PUBLIC_BASE_URL || (() => {
    const proto = String(req?.headers?.['x-forwarded-proto'] || 'https').split(',')[0].trim();
    const host  = String(req?.headers?.['x-forwarded-host'] || req?.headers?.host || '').trim();
    return host ? `${proto}://${host}` : '';
  })();
  return base ? `${base}/api/resolve?key=${encodeURIComponent(key)}` : null;
}

/* ---------- handler ---------- */
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
    catch { return res.status(400).json({ error: 'body is not valid JSON' }); }
  }
  if (!body || typeof body !== 'object') body = {};

  const { video_cdn, image_cdn, file_key } = body;
  if (!video_cdn) return res.status(400).json({ error: 'video_cdn required' });
  if (!file_key)  return res.status(400).json({ error: 'file_key required' });

  const baseName = safeName(file_key);
  const videoKey = `videos/${baseName}.mp4`;
  const imageKey = image_cdn ? `images/${baseName}.jpg` : null;

  const videoUrl = resolveUrl(videoKey, req);
  const imageUrl = resolveUrl(imageKey, req);

  /* --- video --- */
  let videoSize = null;
  let videoError = null;
  try {
    videoSize = await fetchAndUpload(video_cdn, videoKey, 'video/mp4');
  } catch (e) {
    videoError = e.message;
  }

  /* --- image (best-effort) --- */
  let imageError = null;
  if (imageKey) {
    try {
      await fetchAndUpload(image_cdn, imageKey, 'image/jpeg');
    } catch (e) {
      imageError = e.message;
    }
  }

  /* --- DB --- */
  const nowMs = Date.now();

  console.log('[336-debug] ABOUT TO UPDATE', JSON.stringify({
    file_key,
    videoKey,
    videoUrl,
    imageKey,
    imageUrl,
    videoSize,
    videoError,
    imageError,
  }));

  try {
    if (videoError) {
      const r = await db.execute({
        sql: `UPDATE "b2_cloud"
                 SET "status"    = 'fail',
                     "image_key" = COALESCE(?, "image_key"),
                     "image_url" = COALESCE(?, "image_url")
               WHERE "file_key"  = ?`,
        args: [imageError ? null : imageKey, imageError ? null : imageUrl, file_key],
      });
      console.log('[336-debug] FAIL-branch rowsAffected=', r.rowsAffected,
                  'file_key=', JSON.stringify(file_key));
    } else {
      const r = await db.execute({
        sql: `UPDATE "b2_cloud"
                 SET "video_key"  = ?,
                     "video_url"  = ?,
                     "image_key"  = COALESCE(?, "image_key"),
                     "image_url"  = COALESCE(?, "image_url"),
                     "file_size"  = ?,
                     "status"     = 'ok',
                     "created_at" = ?
               WHERE "file_key"   = ?`,
        args: [
          videoKey, videoUrl,
          imageError ? null : imageKey,
          imageError ? null : imageUrl,
          videoSize,
          nowMs, fileKey,
        ],
      });
      console.log('[336-debug] OK-branch rowsAffected=', r.rowsAffected,
                  'file_key=', JSON.stringify(file_key));
    }

    const check = await db.execute({
      sql: 'SELECT id, status, video_key, video_url, image_key, image_url, file_size FROM b2_cloud WHERE file_key = ?',
      args: [file_key],
    });
    console.log('[336-debug] POST-UPDATE rows=', JSON.stringify(check.rows));

  } catch (e) {
    console.error('[336-debug] DB FAILED', e.message, 'file_key=', JSON.stringify(file_key));
    return res.status(500).json({
      success: false,
      db_updated: false,
      error: 'DB update failed: ' + e.message,
      video_url: videoError ? null : videoUrl,
      image_url: imageError ? null : imageUrl,
      video_error: videoError,
      image_error: imageError,
    });
  }

  return res.status(videoError ? 502 : 200).json({
    success:     !videoError,
    partial:     !!videoError && !imageError,
    file_key,
    video_key:   videoError ? null : videoKey,
    image_key:   imageError ? null : imageKey,
    video_url:   videoError ? null : videoUrl,
    image_url:   imageError ? null : imageUrl,
    video_error: videoError,
    image_error: imageError,
    status:      videoError ? 'fail' : 'ok',
    db_updated: true,
  });
}
