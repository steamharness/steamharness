import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Socket } from 'node:net';
import { studioPreviewMount } from './studio-preview-mount';

/** The host resolves public assets; the proxy owns the isolated origin and session bootstrap. */
export interface WebAppAssets {
  nonce: string;
  artifact: { entry: string; webApp?: { permissions?: readonly string[] } };
  hostNotifications?: boolean;
  asset(url: URL): Promise<{ content: Buffer | string; headers: Record<string, string> } | undefined>;
}

/** Supplied over trusted host stdio, never read from a project declaration. */
export interface WebAppBinding {
  service: string;
  apiBaseUrl: string;
  bootstrap: unknown;
  accountUrl?: string;
  login?: { kind: 'studio' | 'external'; serverUrl: string; environment?: string };
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
    let login: WebAppBinding['login'];
    if (item.login !== undefined) {
      const value = item.login, server = new URL(value.serverUrl);
      if (!['studio', 'external'].includes(value.kind) || !safeServiceUrl(server) || server.pathname !== '/' || item.bootstrap != null ||
        value.environment !== undefined && (typeof value.environment !== 'string' || value.environment.length > 256)) throw new Error('Invalid Web application sign-in action.');
      login = { kind: value.kind, serverUrl: server.origin, ...(value.environment === undefined ? {} : { environment: value.environment }) };
    }
    result[id] = { service: item.service, apiBaseUrl: target.href.replace(/\/$/, ''), bootstrap: item.bootstrap ?? null, ...(item.accountUrl ? { accountUrl: item.accountUrl } : {}), ...(login ? { login } : {}) };
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
  private readonly preview: () => WebAppAssets;
  private readonly binding: WebAppBinding | undefined;
  private readonly onLogin?: () => void;
  constructor(preview: () => WebAppAssets, binding: WebAppBinding | undefined, onLogin?: () => void) {
    this.preview = preview;
    this.binding = binding;
    this.onLogin = onLogin;
    this.server.on('connection', socket => { this.sockets.add(socket); socket.on('close', () => this.sockets.delete(socket)); });
    this.server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head));
  }
  handleUpgrade(req: IncomingMessage, socket: NodeJS.ReadWriteStream & { destroy(): void }, head: Buffer, origin = this.origin): void {
      if (!this.authorized(req, origin) || !this.binding || this.binding.login) { socket.destroy(); return; }
      const upstream = this.proxyRequest(req);
      upstream.on('upgrade', (response, peer, upstreamHead) => {
        if (this.closed) { peer.destroy(); socket.destroy(); return; }
        this.sockets.add(peer); peer.on('close', () => this.sockets.delete(peer));
        socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers).filter(([key]) => key !== 'set-cookie').map(([key,value]) => `${key}: ${value}`).join('\r\n')}\r\n\r\n`);
        if (head.length) peer.write(head); if (upstreamHead.length) socket.write(upstreamHead);
        peer.pipe(socket); socket.pipe(peer);
        socket.on('error', () => peer.destroy()); peer.on('error', () => socket.destroy());
        socket.once('close', () => peer.destroy()); peer.once('close', () => socket.destroy());
      });
      upstream.on('response', () => socket.destroy()); upstream.on('error', () => socket.destroy()); upstream.end();
  }
  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => { this.server.once('error', reject); this.server.listen(0, '127.0.0.1', () => { this.server.off('error', reject); resolve(); }); });
    this.origin = `http://127.0.0.1:${(this.server.address() as { port: number }).port}`;
  }
  get url(): string { return `${this.origin}/${this.preview().nonce}/${this.preview().artifact.entry}`; }
  private validOrigin(req: IncomingMessage, origin: string): boolean {
    return req.headers.host === new URL(origin).host && (!req.headers.origin || req.headers.origin === origin);
  }
  private authorized(req: IncomingMessage, origin: string): boolean {
    return !this.closed && this.validOrigin(req, origin) && !!this.apiPath(req.url);
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
  async handle(req: IncomingMessage, res: ServerResponse, origin = this.origin, entryBase = ''): Promise<void> {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Content-Type-Options', 'nosniff');
    if (this.closed || !this.validOrigin(req, origin)) { res.writeHead(403); res.end(); return; }
    const url = new URL(req.url ?? '/', this.origin);
    if (req.headers['sec-fetch-site'] === 'cross-site' && !(req.headers['sec-fetch-dest'] === 'iframe' && url.pathname === `/${this.preview().nonce}/${this.preview().artifact.entry}`)) { res.writeHead(403); res.end(); return; }
    if (url.pathname === `/${this.preview().nonce}/host/login`) {
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
      if (req.headers.origin !== origin || req.headers['content-type'] !== 'application/json') { res.writeHead(403); res.end(); return; }
      if (this.binding && !this.binding.login || !this.onLogin) { res.writeHead(409); res.end(); return; }
      this.onLogin(); res.writeHead(202, { 'Content-Type': 'application/json' }); res.end('{}'); return;
    }
    if (this.apiPath(req.url)) {
      if (!this.authorized(req, origin)) { res.writeHead(401); res.end(); return; }
      if (!this.binding || this.binding.login) { res.writeHead(503); res.end(JSON.stringify({ error: { code: 'HOST_SIGNED_OUT', message: 'Sign in to the host to connect this application.' } })); return; }
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
      const base = studioPreviewMount(req) + entryBase + `/${preview.nonce}`;
      const bootstrap = `<script nonce="${preview.nonce}">localStorage.removeItem('auth-state');Object.defineProperty(window,'steamHarnessWebApp',{value:Object.freeze({...${json({ protocolVersion: 1, managed: true, apiBase: `${base}/api`, session: this.binding?.bootstrap ?? null, accountUrl: this.binding?.accountUrl, login: this.binding?.login, nonce: preview.nonce, notifications: preview.hostNotifications ? 'host' : undefined })},requestLogin:()=>fetch(${json(`${base}/host/login`)},{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).then(response=>{if(!response.ok)throw new Error('Sign-in is unavailable. Refresh the application and retry.');})})});</script>`;
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
