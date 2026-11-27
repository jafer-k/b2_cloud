// api/cdn-to-b2.js
import { createClient } from '@libsql/client';
import { S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { Readable, Transform } from 'node:stream';

// at the TOP of cdn-to-b2.js, near the imports
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 50_000);   // was 60_000
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
 * Definitive expiry check.
 *  - `x-expires` / `expire` are absolute Unix timestamps → we can block on them.
 *  - `l=` (video-my.tiktokv.com) is generation time, NOT expiry → do NOT block.
 *  - Unknown scheme → do NOT block.
 */
function definitiveExpiryMs(url) {
  try {
    const u = new URL(url);
    const x = Number(u.searchParams.get('x-expires') || 0);
    if (x > 0) return x * 1000;
    const e = Number(u.searchParams.get('expire')    || 0);
    if (e > 0) return e * 1000;
    return null;
  } catch {
    return null;
  }
}

/** Update only the image columns (used when video fails but image succeeds). */
async function persistImage(fileKey, imageKey, imageUrl) {
  if (!imageKey) return false;
  try {
    await db.execute({
      sql: `UPDATE "b2_cloud"
               SET "image_blob_key" = COALESCE(?, "image_blob_key"),
                   "image_url"      = COALESCE(?, "image_url")
             WHERE "file_key"       = ?`,
      args: [imageKey, imageUrl, fileKey],
    });
    return true;
  } catch (e) {
    console.error('image persist failed:', e.message);
    return false;
  }
}

/** Update only status (used as a last resort). */
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
  const expMs = definitiveExpiryMs(url);
  if (expMs && expMs < Date.now()) {
    throw new Error(
      'source URL expired at ' + new Date(expMs).toISOString() +
      ' — re-scrape to get a fresh URL'
    );
  }

  const ctl   = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal:   ctl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
          'AppleWebKit/537.36 (KHTML, like Gecko) ' +
          'Chrome/131.0.0.0 Safari/537.36',
        'Accept':          '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer':         'https://www.tiktok.com/',
        'Origin':          'https://www.tiktok.com',
      },
    });

    if (!res.ok) {
      let detail = '';
      try {
        const txt = await res.text();
        detail = txt.replace(/\s+/g, ' ').trim().slice(0, 200);
      } catch {}

      if (res.status === 403) {
        throw new Error(
          'upstream HTTP 403 (TikTok rejected — usually expired URL; ' +
          're-scrape to refresh the source URL)' +
          (detail ? ' · body: ' + detail : '')
        );
      }
      throw new Error(
        `upstream HTTP ${res.status}` + (detail ? ' · body: ' + detail : '')
      );
    }

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
    console.warn('[cdn-to-b2] PUBLIC_BASE_URL not set — falling back to request host.');
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

  const imageCdn = typeof body.image_cdn === 'string' ? body.image_cdn : '';

  const videoKey = `videos/${safeSegment(fileKey)}.mp4`;
  const nowMs    = Date.now();

  /* -------- 1. upload video (errors captured, not thrown) -------- */
  let videoResult = null;
  let videoError  = null;
  try {
    videoResult = await uploadFromUrl({ url, key: videoKey, contentType: 'video/mp4' });
  } catch (e) {
    videoError = e;
  }

  /* -------- 2. upload image (best-effort, ALWAYS attempted) --------
   *  Even when the video failed. Image has its own expiry pre-check
   *  (definitiveExpiryMs) — an expired image URL fails fast.
   */
  const imageKey = await uploadImage(imageCdn, fileKey);
  const imageUrl = resolveUrl(imageKey, req);

  /* -------- 3a. video failed → persist image, mark fail -------- */
  if (videoError) {
    const errMsg = videoError.message || 'unknown error';

    let imagePersisted = false;
    if (imageKey) {
      // Persist the image BEFORE flipping status='fail'.
      imagePersisted = await persistImage(fileKey, imageKey, imageUrl);
    }

    const st = await setStatus(fileKey, 'fail');

    return res.status(502).json({
      success:         false,
      error:           errMsg,
      file_key:        fileKey,
      imageKey,
      imageUrl,
      imagePersisted,
      videoKey:        null,
      videoUrl:        null,
      status:          'fail',
      partial:         !!imageKey,     // true if the image was salvaged
      dbStatusUpdated: st.updated,
    });
  }

  /* -------- 3b. video succeeded → persist everything -------- */
  const videoUrl = resolveUrl(videoKey, req);

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
      return res.status(409).json({
        success: false,
        error:   'file_key not found in b2_cloud',
        file_key: fileKey,
        status:  'unknown',
        dbStatusUpdated: false,
      });
    }

    return res.status(200).json({
      success:  true,
      file_key: fileKey,
      videoKey,
      imageKey,
      videoUrl,
      imageUrl,
      bytes:    videoResult.bytes,
      status:   'ok',
      dbStatusUpdated: true,
      partial:  false,
    });
  } catch (e) {
    console.error('success update failed:', e.message);

    // Video + image already in B2. UPDATE failed (e.g. migration).
    // Salvage the image, then flip to fail.
    let imagePersisted = false;
    if (imageKey) {
      imagePersisted = await persistImage(fileKey, imageKey, imageUrl);
    }
    const st = await setStatus(fileKey, 'fail');

    return res.status(500).json({
      success:         false,
      error:           e.message,
      file_key:        fileKey,
      videoKey,
      imageKey,
      imagePersisted,
      status:          'fail',
      partial:         !!imageKey,
      dbStatusUpdated: st.updated,
    });
  }
}

// at the BOTTOM of cdn-to-b2.js, after the handler export
export const config = {
  maxDuration: 60,   // Hobby max. Bump to 300 on Pro.
};
