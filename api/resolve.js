// api/resolve.js
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const s3 = new S3Client({
  endpoint: process.env.B2_ENDPOINT,
  region:   process.env.B2_REGION || 'us-east-005',
  credentials: {
    accessKeyId:     process.env.B2_KEY_ID,
    secretAccessKey: process.env.B2_APP_KEY,
  },
  forcePathStyle: true,
});

const BUCKET        = process.env.B2_BUCKET_NAME;
const SIGNED_TTL    = 7 * 24 * 60 * 60;   // 7 days — SigV4 hard cap
const CACHE_TTL     = 3600;               // 1h — safe to cache the redirect
const ALLOWED_PREFIXES = ['videos/', 'images/'];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET')     return res.status(405).json({ error: 'GET only' });

  const key = typeof req.query?.key === 'string' ? req.query.key.trim() : '';
  if (!key) return res.status(400).json({ error: 'key required' });
  if (!ALLOWED_PREFIXES.some(p => key.startsWith(p)))
    return res.status(400).json({ error: 'invalid key prefix' });
  if (!BUCKET) return res.status(500).json({ error: 'B2_BUCKET_NAME not configured' });

  let signed;
  try {
    signed = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: BUCKET, Key: key }),
      { expiresIn: SIGNED_TTL },
    );
  } catch (e) {
    return res.status(500).json({ error: 'signing failed: ' + e.message });
  }

  // JSON mode if explicitly asked for, or if the client wants JSON.
  const wantsJson =
    req.query?.json === '1' ||
    req.query?.redirect === '0' ||
    String(req.headers.accept || '').includes('application/json');

  if (wantsJson) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ key, url: signed, expiresIn: SIGNED_TTL });
  }

  // Default: 307 temporary redirect. Browser / video player / <img> follow it.
  res.setHeader('Cache-Control', `public, max-age=${CACHE_TTL}`);
  res.statusCode = 307;
  res.setHeader('Location', signed);
  return res.end();
}
