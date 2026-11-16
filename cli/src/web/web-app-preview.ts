import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Socket } from 'node:net';
import type { KanbanPreview } from './kanban-preview';

/** Supplied over trusted host stdio, never read from a project declaration. */
export interface WebAppBinding {
  service: string;
  apiBaseUrl: string;
  bootstrap: unknown;
  accountUrl?: string;
}
export function parseWebAppBindings(value: unknown): Record<string, WebAppBinding> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value) || JSON.stringify(value).length > 128_000) throw new Error('Invalid Web application bindings.');
  const result: Record<string, WebAppBinding> = {};
  for (const [id, raw] of Object.entries(value)) {
    const item = raw as WebAppBinding;
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(id) || !item || typeof item !== 'object' || typeof item.service !== 'string' || !/^[a-z][a-z0-9.-]{0,99}$/.test(item.service)) throw new Error('Invalid Web application binding.');
    const target = new URL(item.apiBaseUrl);
    if (!safeServiceUrl(target) || !target.pathname.endsWith('/api')) throw new Error('Invalid Web application API.');
    if (item.accountUrl !== undefined && (!safeServiceUrl(new URL(item.accountUrl)) || new URL(item.accountUrl).origin === 'null')) throw new Error('Invalid Web application account URL.');
    result[id] = { service: item.service, apiBaseUrl: target.href.replace(/\/$/, ''), bootstrap: item.bootstrap ?? null, ...(item.accountUrl ? { accountUrl: item.accountUrl } : {}) };
  }
  return result;
}
function safeServiceUrl(url: URL): boolean {
  return !url.username && !url.password && !url.search && !url.hash && (url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
}
const json = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028|\u2029/g, value => value === '\u2028' ? '\\u2028' : '\\u2029');
const hopHeaders = new Set(['host', 'cookie', 'connection', 'transfer-encoding', 'proxy-authorization', 'proxy-authenticate', 'upgrade', 'origin', 'referer', 'sec-fetch-site']);

/** A separate loopback origin contains storage and a fixed-target HTTP/WS proxy. */
export class WebAppPreview {
  private readonly sockets = new Set<Socket>();
  private readonly pending = new Set<ReturnType<typeof httpRequest>>();
  private readonly server = createServer((req, res) => { void this.handle(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); }); });
  private origin = '';
  private closed = false;
  constructor(private readonly preview: () => KanbanPreview, private readonly binding: WebAppBinding | undefined) {
    this.server.on('connection', socket => { this.sockets.add(socket); socket.on('close', () => this.sockets.delete(socket)); });
    this.server.on('upgrade', (req, socket, head) => {
      if (!this.authorized(req) || !this.binding || !this.apiPath(req.url)) { socket.destroy(); return; }
      const upstream = this.proxyRequest(req);
      upstream.on('upgrade', (response, peer, upstreamHead) => {
        if (this.closed) { peer.destroy(); socket.destroy(); return; }
        this.sockets.add(peer); peer.on('close', () => this.sockets.delete(peer));
        socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers).filter(([key]) => key !== 'set-cookie').map(([key,value]) => `${key}: ${value}`).join('\r\n')}\r\n\r\n`);
        if (head.length) peer.write(head); if (upstreamHead.length) socket.write(upstreamHead);
        peer.pipe(socket); socket.pipe(peer);
        socket.on('error', () => peer.destroy()); peer.on('error', () => socket.destroy());
      });
      upstream.on('response', () => socket.destroy()); upstream.on('error', () => socket.destroy()); upstream.end();
    });
  }
  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => { this.server.once('error', reject); this.server.listen(0, '127.0.0.1', () => { this.server.off('error', reject); resolve(); }); });
    this.origin = `http://127.0.0.1:${(this.server.address() as { port: number }).port}`;
  }
  get url(): string { return `${this.origin}/${this.preview().nonce}/${this.preview().artifact.entry}`; }
  private validOrigin(req: IncomingMessage): boolean {
    return req.headers.host === new URL(this.origin).host && (!req.headers.origin || req.headers.origin === this.origin) ;
  }
  private authorized(req: IncomingMessage): boolean {
    return !this.closed && this.validOrigin(req) && !!this.apiPath(req.url);
  }
  private apiPath(url: string | undefined): string | undefined {
    const prefix = `/${this.preview().nonce}`;
    if (!url?.startsWith(prefix + '/api/')) return;
    const pathname = url.split('?')[0]!;
    // Encoded separators or dot segments must never escape the fixed API prefix.
    let decoded: string;
    try { decoded = decodeURIComponent(pathname); } catch { return; }
    if (decoded.includes('\\') || /%2f|%5c/i.test(pathname) || decoded.split('/').some(part => part === '.' || part === '..')) return;
    return url.slice(prefix.length);
  }
  private proxyRequest(req: IncomingMessage) {
    const target = new URL(this.binding!.apiBaseUrl);
    // Preserve signed file queries and Range headers; reject protocol-relative paths.
    target.pathname += this.apiPath(req.url)!.split('?')[0]!.slice(4);
    target.search = new URL(req.url!, this.origin).search;
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([key]) => !hopHeaders.has(key)));
    if (req.headers.upgrade === 'websocket') { headers.connection = 'Upgrade'; headers.upgrade = 'websocket'; }
    const upstream = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target, { method: req.method, headers, timeout: 30_000 });
    this.pending.add(upstream); upstream.on('close', () => this.pending.delete(upstream)); upstream.on('timeout', () => upstream.destroy());
    return upstream;
  }
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Content-Type-Options', 'nosniff');
    if (this.closed || !this.validOrigin(req)) { res.writeHead(403); res.end(); return; }
    const url = new URL(req.url ?? '/', this.origin);
    if (req.headers['sec-fetch-site'] === 'cross-site' && !(req.headers['sec-fetch-dest'] === 'iframe' && url.pathname === `/${this.preview().nonce}/${this.preview().artifact.entry}`)) { res.writeHead(403); res.end(); return; }
    if (this.apiPath(req.url)) {
      if (!this.authorized(req)) { res.writeHead(401); res.end(); return; }
      if (!this.binding) { res.writeHead(503); res.end(JSON.stringify({ error: { code: 'HOST_SIGNED_OUT', message: 'Sign in to the host to connect this application.' } })); return; }
      const upstream = this.proxyRequest(req);
      upstream.on('response', response => {
        // No redirects, cookies or CORS from the service can expand this proxy.
        if ((response.statusCode ?? 500) >= 300 && (response.statusCode ?? 500) < 400) { response.resume(); res.writeHead(502); res.end(); return; }
        const headers = Object.fromEntries(Object.entries(response.headers).filter(([key]) => !['set-cookie', 'location', 'connection', 'transfer-encoding'].includes(key) && !key.startsWith('access-control-')));
        res.writeHead(response.statusCode ?? 502, headers); response.pipe(res);
      });
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      res.on('close', () => upstream.destroy()); req.pipe(upstream); return;
    }
    if (!['GET', 'HEAD'].includes(req.method ?? '')) { res.writeHead(405); res.end(); return; }
    const preview = this.preview(), prefix = `/${preview.nonce}/`;
    const assetPath = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : url.pathname.slice(1);
    if (!assetPath || assetPath === preview.artifact.entry && !url.pathname.startsWith(prefix)) { res.writeHead(404); res.end(); return; }
    const asset = await preview.asset(new URL(`/kanban/${preview.nonce}/${assetPath}`, this.origin));
    if (!asset) { res.writeHead(404); res.end(); return; }
    const microphone = preview.artifact.webApp?.permissions?.includes('microphone') ?? false;
    res.setHeader('Permissions-Policy', `microphone=(${microphone ? 'self' : ''}), camera=(), geolocation=()`);
    const headers = { ...asset.headers, 'Content-Security-Policy': `default-src 'self'; script-src 'self' 'nonce-${preview.nonce}' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; media-src 'self' blob: data:; connect-src 'self' ws://127.0.0.1:${new URL(this.origin).port}; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-src 'none'; form-action 'none'; frame-ancestors http://127.0.0.1:* vscode-webview: vscode-file: https://*.vscode-cdn.net https://*.vscode-webview.net` };
    delete (headers as Record<string, string>)['Access-Control-Allow-Origin'];
    let content = asset.content;
    if (url.pathname === prefix + preview.artifact.entry) {
      const bootstrap = `<script nonce="${preview.nonce}">localStorage.removeItem('auth-state');Object.defineProperty(window,'steamHarnessWebApp',{value:Object.freeze(${json({ protocolVersion: 1, managed: true, apiBase: `/${preview.nonce}/api`, session: this.binding?.bootstrap ?? null, accountUrl: this.binding?.accountUrl, nonce: preview.nonce })})});</script>`;
      const html = String(content);
      content = /<head(?:\s[^>]*)?>/i.test(html) ? html.replace(/<head(?:\s[^>]*)?>/i, match => match + bootstrap) : bootstrap + html;
    }
    res.writeHead(200, headers); res.end(req.method === 'HEAD' ? undefined : content);
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const request of this.pending) request.destroy();
    for (const socket of this.sockets) socket.destroy();
    if (this.server.listening) await new Promise<void>(resolve => this.server.close(() => resolve()));
  }
}
