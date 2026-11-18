import { createServer, request, type OutgoingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

// Older CLIs do not understand the host's local-edition flag. Keep their
// process, routes and capability checks; only adapt the entry HTML.
export async function startLegacyLocalFrame(origin: URL): Promise<{ port: number; dispose(): void }> {
  if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || !origin.port) throw new Error('Invalid local CLI address.');
  const server = createServer((incoming, outgoing) => {
    const pathname = incoming.url?.split('?', 1)[0] ?? '';
    const entryPage = incoming.method === 'GET' && /^\/entries\/[a-zA-Z0-9_-]+\/$/u.test(pathname);
    const upstream = request({ hostname: origin.hostname, port: origin.port, path: incoming.url, method: incoming.method,
      headers: { ...incoming.headers, ...(entryPage ? { 'accept-encoding': 'identity' } : {}) } }, response => {
      response.on('error', () => outgoing.destroy());
      if (!entryPage || response.statusCode !== 200 || !response.headers['content-type']?.startsWith('text/html') || response.headers['content-encoding']) {
        outgoing.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(outgoing);
        return;
      }
      let size = 0;
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 256_000) response.destroy(new Error('CLI entry page is too large.'));
        else chunks.push(chunk);
      });
      response.once('end', () => {
        const html = Buffer.concat(chunks).toString('utf8').replace('</head>',
          '<style>#web-account,#account-dialog,#parameter-login{display:none!important}</style></head>');
        const headers: OutgoingHttpHeaders = { ...response.headers, 'content-length': Buffer.byteLength(html) };
        delete headers.etag;
        delete headers['transfer-encoding'];
        outgoing.writeHead(200, headers);
        outgoing.end(html);
      });
    });
    upstream.on('error', () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
    outgoing.once('close', () => upstream.destroy());
    incoming.pipe(upstream);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  return { port: (server.address() as AddressInfo).port, dispose: () => { server.close(); server.closeAllConnections(); } };
}
