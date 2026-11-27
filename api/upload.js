// api/upload-simple.js
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Readable } from 'node:stream';

/* Check env vars at module load — DON'T throw, return clear error instead */
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

async function fetchAndUpload(url, key, contentType) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`fetch HTTP ${res.status}`);
  if (!res.body) throw new Error('empty response body');

  const upload = new Upload({
    client: s3,
    params: {
      Bucket:      process.env.B2_BUCKET_NAME,
      Key:         key,
      Body:        Readable.fromWeb(res.body),
      ContentType: contentType,
    },
  });
  await upload.done();
}

function safeName(s) {
  return String(s || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
}

export default async function handler(req, res) {
  /* CORS */
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'POST only' });

  /* Config check — first thing, clear message */
  if (MISSING.length > 0) {
    return res.status(500).json({ error: 'missing env vars: ' + MISSING.join(', ') });
  }

  /* Auth */
  if (req.headers['x-api-key'] !== process.env.API_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  /* Body */
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

  const result = {
    video_key:   videoKey,
    image_key:   null,
    video_url:   null,
    image_url:   null,
    video_error: null,
    image_error: null,
  };

  /* --- Video (required) --- */
  try {
    await fetchAndUpload(video_cdn, videoKey, 'video/mp4');
    result.video_url = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: process.env.B2_BUCKET_NAME, Key: videoKey }),
      { expiresIn: 7 * 24 * 60 * 60 },
    );
  } catch (e) {
    result.video_error = e.message;
  }

  /* --- Image (best-effort) --- */
  if (imageKey) {
    try {
      await fetchAndUpload(image_cdn, imageKey, 'image/jpeg');
      result.image_key = imageKey;
      result.image_url = await getSignedUrl(
        s3,
        new GetObjectCommand({ Bucket: process.env.B2_BUCKET_NAME, Key: imageKey }),
        { expiresIn: 7 * 24 * 60 * 60 },
      );
    } catch (e) {
      result.image_error = e.message;
    }
  }

  return res.status(200).json(result);
}
