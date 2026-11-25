import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

const assetRoute = /^\/(?:[\w-]+\/)?static\/out\/vs\/code\/browser\/workbench\/(.+)$/u;

function representation(header, variants) {
  const qualities = new Map();
  for (const value of (header ?? '').split(',')) {
    const match = /^\s*(br|gzip|identity|\*)\s*(?:;\s*q\s*=\s*(0(?:\.\d{0,3})?|1(?:\.0{0,3})?))?\s*$/iu.exec(value);
    if (match) qualities.set(match[1].toLowerCase(), Number(match[2] ?? 1));
  }
  const wildcard = qualities.get('*');
  let encoding, quality = 0;
  for (const candidate of ['br', 'gzip', 'identity']) {
    if (!variants[candidate]) continue;
    const weight = qualities.get(candidate) ?? (candidate === 'identity' ? (wildcard === 0 ? 0 : 1) : wildcard ?? 0);
    if (weight > quality) { encoding = candidate; quality = weight; }
  }
  return encoding;
}

/** Only the launcher-produced allowlist can enter the browser cache; the caller already checked pairing. */
export async function serveClientAsset(req, res, url, assets, track) {
  if (!assets || !['GET', 'HEAD'].includes(req.method)) return false;
  const match = assetRoute.exec(url.pathname);
  const asset = match && assets.get(match[1]);
  if (!asset) return false;
  const encoding = representation(req.headers['accept-encoding'], asset.variants);
  const vary = 'Accept-Encoding, Cookie';
  if (!encoding) {
    res.writeHead(406, { 'Cache-Control': 'no-store', Vary: vary }).end();
    return true;
  }
  const headers = { 'Cache-Control': 'private, max-age=31536000, immutable', Vary: vary, ETag: asset.etag,
    'Content-Type': asset.mime, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
  if (encoding !== 'identity') headers['Content-Encoding'] = encoding;
  const etags = req.headers['if-none-match']?.split(',').map(value => value.trim().replace(/^W\//u, '')) ?? [];
  if (etags.includes('*') || etags.includes(asset.etag.replace(/^W\//u, ''))) {
    res.writeHead(304, headers).end();
    return true;
  }
  const { file, size } = asset.variants[encoding];
  res.writeHead(200, { ...headers, 'Content-Length': size });
  if (req.method === 'HEAD') res.end();
  else {
    const release = track(() => res.destroy());
    try { await pipeline(createReadStream(file), res); }
    catch { res.destroy(); }
    finally { release(); }
  }
  return true;
}
