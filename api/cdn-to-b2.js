// api/cdn-to-b2.js
import { createClient } from '@libsql/client';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Readable, Transform } from 'node:stream';

/* ---------- clients ---------- */

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const s3 = new S3Client({
  endpoint: process.env.B2_ENDPOINT,
  region: process.env.B2_REGION || 'us-east-005',
  credentials: {
    accessKeyId: process.env.B2_KEY_ID,
    secretAccessKey: process.env.B2_APP_KEY,
  },
  forcePathStyle: true,
});

const BUCKET = process.env.B2_BUCKET_NAME;
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 60_000);
const MAX_BYTES = Number(process.env.MAX_BYTES || 500 * 1024 * 1024);
const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

// B2 caps presigned URL TTL at 7 days.
const SIGNED_URL_TTL = 7 * 24 * 60 * 60;

/* ---------- helpers ---------- */

const IMAGE_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

function isHostAllowed(hostname) {
  if (ALLOWED_HOSTS.length === 0) return true;
  return ALLOWED_HOSTS.some(h =>
    h.startsWith('.') ? hostname.endsWith(h) : hostname === h
  );
}

function safeSegment(s, max = 100) {
  return String(s ?? '').trim().replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, max);
}

function toNodeStream(webStream) {
  if (!webStream) return null;
  if (typeof webStream.pipe === 'function') return webStream;
  return Readable.fromWeb(webStream);
}

async function signedUrl(key) {
  if (!key) return null;
  return getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: BUCKET, Key: key }),
    { expiresIn: SIGNED_URL_TTL }
  );
}

async function uploadFromUrl({ url, key, contentType }) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': '*/*' },
    });
    if (!res.ok) throw new Error(`upstream HTTP ${res.status}`);

    const headerLen = Number(res.headers.get('content-length')) || 0;
    if (headerLen && headerLen > MAX_BYTES) {
      try { await res.body?.cancel(); } catch {}
      throw new Error('file too large');
    }

    let counted = 0;
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        counted += chunk.length;
        if (counted > MAX_BYTES) return cb(new Error('file too large'));
        cb(null, chunk);
      },
    });

    const source = toNodeStream(res.body);
    if (!source) throw new Error('empty response body');
    source.pipe(counter);

    const upload = new Upload({
      client: s3,
      params: {
        Bucket: BUCKET,
        Key: key,
        Body: counter,
        ContentType: contentType,
      },
    });
    await upload.done();

    return { key, bytes: counted || headerLen || null };
  } finally {
    clearTimeout(timer);
  }
}

async function uploadImage(imageUrl, fileKey) {
  if (!imageUrl || typeof imageUrl !== 'string') return null;
  try {
    const u = new URL(imageUrl);
    if (!/^https?:$/.test(u.protocol)) return null;
    if (!isHostAllowed(u.hostname)) return null;

    const ext = (u.pathname.match(/\.[a-z0-9]+$/i)?.[0] || '.jpg').toLowerCase();
    const contentType = IMAGE_TYPES[ext] || 'image/jpeg';
    const key = `images/${safeSegment(fileKey)}${ext}`;

    const r = await uploadFromUrl({ url: imageUrl, key, contentType });
    return r.key;
  } catch (e) {
    console.error('Image upload failed:', e.message);
    return null;
  }
}

/* ---------- handler ---------- */

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'POST only' });

  if (req.headers['x-api-key'] !== process.env.API_KEY) {
    return res.status(401).json({ success: false, error: 'unauthorized' });
  }

  if (!BUCKET) {
    return res.status(500).json({ success: false, error: 'B2_BUCKET_NAME not configured' });
  }

  let body = req.body;
  if (Buffer.isBuffer(body)) body = body.toString('utf8');
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  if (!body || typeof body !== 'object') body = {};

  const url = typeof body.url === 'string' ? body.url.trim() : '';
  if (!url) return res.status(400).json({ success: false, error: 'url required' });

  let parsed;
  try { parsed = new URL(url); }
  catch { return res.status(400).json({ success: false, error: 'invalid url' }); }
  if (!/^https?:$/.test(parsed.protocol))
    return res.status(400).json({ success: false, error: 'only http(s) URLs' });
  if (!isHostAllowed(parsed.hostname))
    return res.status(400).json({ success: false, error: 'host not allowed: ' + parsed.hostname });

  const fileKey = typeof body.file_key === 'string' ? body.file_key.trim() : '';
  if (!fileKey)
    return res.status(400).json({ success: false, error: 'file_key required' });

  const dateStr  = typeof body.date === 'string' ? body.date : '';
  const imageUrl = typeof body.coverImg === 'string' ? body.coverImg : '';

  const videoKey = `videos/${safeSegment(fileKey)}.mp4`;
  const nowMs    = Date.now();

  /* -------- 1. upload video -------- */
  let videoResult;
  try {
    videoResult = await uploadFromUrl({
      url,
      key: videoKey,
      contentType: 'video/mp4',
    });
  } catch (e) {
    const imageKey = await uploadImage(imageUrl, fileKey);
    const errMsg = e.message || 'unknown error';

    // failure → ONLY status column in b2_cloud
    try {
      await db.execute({
        sql: `UPDATE "b2_cloud" SET "status" = 'fail' WHERE "file_key" = ?`,
        args: [fileKey],
      });
    } catch (dbErr) {
      console.error('status=fail update failed:', dbErr.message);
    }

    let failedId = null;
    try {
      const ins = await db.execute({
        sql: `INSERT INTO failed_uploads
                (video_url, cover_key, user_id, date, likes, error)
              VALUES (?, ?, ?, ?, ?, ?)`,
        args: [url, imageKey, body.userId ?? null, dateStr || null,
               Number.isInteger(body.likes) && body.likes >= 0 ? body.likes : 0,
               errMsg],
      });
      failedId = ins.lastInsertRowid != null ? String(ins.lastInsertRowid) : null;
    } catch (dbErr) {
      console.error('failed_uploads insert failed:', dbErr.message);
    }

    return res.status(502).json({
      success: false,
      error: errMsg,
      file_key: fileKey,
      imageKey,
      failedId,
    });
  }

  /* -------- 2. upload image -------- */
  const imageKey = await uploadImage(imageUrl, fileKey);

  /* -------- 3. sign URLs (7-day TTL) -------- */
  let videoUrl = null, coverUrl = null;
  try {
    videoUrl = await signedUrl(videoKey);
    coverUrl = await signedUrl(imageKey);
  } catch (e) {
    console.error('signing failed:', e.message);
  }

  /* -------- 4. SUCCESS — update only, never insert -------- */
  try {
    const result = await db.execute({
      sql: `UPDATE "b2_cloud"
               SET "video_url"  = ?,
                   "cover_url"  = COALESCE(?, "cover_url"),
                   "file_size"  = ?,
                   "status"     = 'ok',
                   "created_at" = ?
             WHERE "file_key"  = ?`,
      args: [
        videoUrl,
        coverUrl,
        videoResult.bytes ?? null,
        nowMs,
        fileKey,
      ],
    });

    const changes = typeof result.rowsAffected === 'number'
      ? result.rowsAffected
      : (typeof result.changes === 'number' ? result.changes : undefined);

    if (changes === 0) {
      return res.status(409).json({
        success: false,
        error: 'file_key not found in b2_cloud',
        file_key: fileKey,
      });
    }

    return res.status(200).json({
      success: true,
      file_key: fileKey,
      videoKey,
      imageKey,
      videoUrl,
      coverUrl,
      bytes: videoResult.bytes,
      status: 'ok',
    });
  } catch (e) {
    console.error('success update failed:', e);
    return res.status(500).json({ success: false, error: e.message });
  }
}
