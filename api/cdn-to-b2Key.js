// api/cdn-to-b2.js
import { createClient } from '@libsql/client';
import { S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { Readable, Transform } from 'node:stream';

/* ---------- clients ---------- */

const db = createClient({
  url:       process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const s3 = new S3Client({
  endpoint: process.env.B2_ENDPOINT,
  region:   process.env.B2_REGION || 'us-east-005',
  credentials: {
    accessKeyId:     process.env.B2_KEY_ID,
    secretAccessKey: process.env.B2_APP_KEY,
  },
  forcePathStyle: true,
});

const BUCKET           = process.env.B2_BUCKET_NAME;
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 60_000);
const MAX_BYTES        = Number(process.env.MAX_BYTES || 500 * 1024 * 1024);
const ALLOWED_HOSTS    = (process.env.ALLOWED_HOSTS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');

/* ---------- helpers ---------- */

const IMAGE_TYPES = {
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png':  'image/png',
  '.webp': 'image/webp',
  '.gif':  'image/gif',
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

function resolveUrl(key, req) {
  if (!key) return null;
  const base = PUBLIC_BASE_URL || (() => {
    const proto = String(req?.headers?.['x-forwarded-proto'] || 'https').split(',')[0].trim();
    const host  = String(req?.headers?.['x-forwarded-host'] || req?.headers?.host || '').trim();
    return host ? `${proto}://${host}` : '';
  })();
  if (!base) return null;
  return `${base}/api/resolve?key=${encodeURIComponent(key)}`;
}

/**
 * Sets b2_cloud.status for a given file_key.
 * Uses only columns that exist regardless of whether the
 * video_blob_key / image_blob_key migration has been applied.
 * Returns { updated: boolean, changes: number|null }.
 */
async function setStatus(fileKey, value) {
  try {
    const result = await db.execute({
      sql:  `UPDATE "b2_cloud" SET "status" = ? WHERE "file_key" = ?`,
      args: [value, fileKey],
    });
    const changes = typeof result.rowsAffected === 'number'
      ? result.rowsAffected
      : (typeof result.changes === 'number' ? result.changes : null);
    return { updated: (changes ?? 0) > 0, changes };
  } catch (err) {
    console.error(`status=${value} update failed for ${fileKey}:`, err.message);
    return { updated: false, changes: null, error: err.message };
  }
}

async function uploadFromUrl({ url, key, contentType }) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal:   ctl.signal,
      redirect: 'follow',
      headers:  { 'User-Agent': 'Mozilla/5.0', 'Accept': '*/*' },
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

async function uploadImage(imageCdn, fileKey) {
  if (!imageCdn || typeof imageCdn !== 'string') return null;
  try {
    const u = new URL(imageCdn);
    if (!/^https?:$/.test(u.protocol)) return null;
    if (!isHostAllowed(u.hostname)) return null;

    const ext = (u.pathname.match(/\.[a-z0-9]+$/i)?.[0] || '.jpg').toLowerCase();
    const contentType = IMAGE_TYPES[ext] || 'image/jpeg';
    const key = `images/${safeSegment(fileKey)}${ext}`;

    const r = await uploadFromUrl({ url: imageCdn, key, contentType });
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
  if (req.method !== 'POST')    return res.status(405).json({ success: false, error: 'POST only' });

  if (req.headers['x-api-key'] !== process.env.API_KEY) {
    return res.status(401).json({ success: false, error: 'unauthorized' });
  }
  if (!BUCKET) {
    return res.status(500).json({ success: false, error: 'B2_BUCKET_NAME not configured' });
  }
  if (!PUBLIC_BASE_URL) {
    console.warn('[cdn-to-b2] PUBLIC_BASE_URL not set — falling back to request host. Set it in production so stored URLs are stable across deployments and previews.');
  }

  let body = req.body;
  if (Buffer.isBuffer(body)) body = body.toString('utf8');
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  if (!body || typeof body !== 'object') body = {};

  const url = (
    typeof body.video_cdn === 'string' ? body.video_cdn :
    typeof body.url       === 'string' ? body.url       : ''
  ).trim();

  if (!url) return res.status(400).json({ success: false, error: 'video_cdn required' });

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

  // Source image on the TikTok CDN (mirrors the image_cdn column).
  const imageCdn = typeof body.image_cdn === 'string' ? body.image_cdn : '';

  const videoKey = `videos/${safeSegment(fileKey)}.mp4`;
  const nowMs    = Date.now();

  /* -------- 1. upload video -------- */

  let videoResult;
  try {
    videoResult = await uploadFromUrl({ url, key: videoKey, contentType: 'video/mp4' });
  } catch (e) {
    const errMsg = e.message || 'unknown error';

    // best-effort: still upload the image so it can be reused if the user retries
    const imageKey = await uploadImage(imageCdn, fileKey);

    // record status='fail'
    const st = await setStatus(fileKey, 'fail');

    return res.status(502).json({
      success: false,
      error:   errMsg,
      file_key: fileKey,
      imageKey,
      status: 'fail',
      dbStatusUpdated: st.updated,
    });
  }

  /* -------- 2. upload image (best-effort) -------- */

  const imageKey = await uploadImage(imageCdn, fileKey);

  /* -------- 3. build STABLE resolve URLs (never expire) -------- */

  const videoUrl    = resolveUrl(videoKey, req);
  const imageUrlRes = resolveUrl(imageKey, req);

  /* -------- 4. persist keys + resolve URLs + status='ok' -------- */

  try {
    const result = await db.execute({
      sql: `UPDATE "b2_cloud"
               SET "video_blob_key" = ?,
                   "video_url"      = ?,
                   "image_blob_key" = COALESCE(?, "image_blob_key"),
                   "image_url"      = COALESCE(?, "image_url"),
                   "file_size"      = ?,
                   "status"         = 'ok',
                   "created_at"     = ?
             WHERE "file_key"       = ?`,
      args: [
        videoKey,
        videoUrl,
        imageKey,
        imageUrl,
        videoResult.bytes ?? null,
        nowMs,
        fileKey,
      ],
    });

    const changes = typeof result.rowsAffected === 'number'
      ? result.rowsAffected
      : (typeof result.changes === 'number' ? result.changes : undefined);

    if (changes === 0) {
      // Video is in B2, but the row doesn't exist in b2_cloud.
      // Nothing to mark ok — surface it.
      return res.status(409).json({
        success: false,
        error:   'file_key not found in b2_cloud',
        file_key: fileKey,
        status: 'unknown',
        dbStatusUpdated: false,
      });
    }

    return res.status(200).json({
  success: true,
  file_key: fileKey,
  videoKey,
  imageKey,
  videoUrl,
  imageUrl,
  bytes: videoResult.bytes,
  status: 'ok',
  dbStatusUpdated: true,
});
  } catch (e) {
    // The video (+ image) are already in B2. The DB write failed
    // (e.g. migration not run, transient Turso error). Fall back
    // to a minimal status='fail' update that only touches columns
    // guaranteed to exist.
    console.error('success update failed:', e.message);
    const st = await setStatus(fileKey, 'fail');

    return res.status(500).json({
      success: false,
      error:   e.message,
      file_key: fileKey,
      videoKey,
      imageKey,
      status: 'fail',
      dbStatusUpdated: st.updated,
      dbStatusError:   st.error || null,
    });
  }
}
