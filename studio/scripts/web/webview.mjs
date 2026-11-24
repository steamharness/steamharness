import { readFile } from 'node:fs/promises';
import path from 'node:path';

const prefix = '/_studio/webview/';
const types = new Map([
  ['index.html', 'text/html; charset=utf-8'],
  ['fake.html', 'text/html; charset=utf-8'],
  ['service-worker.js', 'text/javascript; charset=utf-8'],
]);

export function isLocalWebviewHost(req, port) {
  const authority = /^[0-9a-v]{52}\.localhost:([1-9]\d{0,4})$/iu.exec(req.headers.host ?? '');
  return req.headersDistinct?.host?.length === 1 && authority?.[1] === String(port);
}

// Keep the stock webview origin-hash check and service worker. This host must
// never relay Workbench requests or serve files outside the prelude allowlist.
export async function serveLocalWebview(req, res, url, directory, origins) {
  const filename = url.pathname.startsWith(prefix) && url.pathname.slice(prefix.length);
  const type = types.get(filename);
  const parent = url.searchParams.get('parentOrigin');
  const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };
  if (!type) return res.writeHead(404, headers).end();
  if (req.method !== 'GET' && req.method !== 'HEAD') return res.writeHead(405, { ...headers, Allow: 'GET, HEAD' }).end();
  if (filename === 'index.html' && !origins.has(parent)) return res.writeHead(403, headers).end();
  const bytes = await readFile(path.join(directory, filename));
  headers['Content-Type'] = type;
  if (filename === 'index.html') headers['Content-Security-Policy'] = `frame-ancestors ${parent}`;
  if (filename === 'fake.html') headers['Content-Security-Policy'] = `frame-ancestors 'self' ${[...origins.keys()].join(' ')}`;
  res.writeHead(200, headers).end(req.method === 'HEAD' ? undefined : bytes);
}
