import { afterEach, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { KanbanPreview } from '../web/kanban-preview';
import { WebAppPreview, parseWebAppBindings } from '../web/web-app-preview';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(microphone = true, login = false, hostNotifications = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'web-app-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'build'));
  await writeFile(path.join(root, 'build/index.html'), '<!doctype html><html><head></head><body><script src="app.js"></script></body></html>');
  await writeFile(path.join(root, 'build/app.js'), 'globalThis.started = true;');
  const requests: Array<{ url?: string; headers: import('node:http').IncomingHttpHeaders; body: string }> = [];
  const upstream = createServer(async (req, res) => {
    const parts: Buffer[] = []; for await (const part of req) parts.push(part);
    requests.push({ url: req.url, headers: req.headers, body: Buffer.concat(parts).toString() });
    if (req.url === '/api/redirect') { res.writeHead(302, { Location: 'https://outside.invalid', 'Set-Cookie': 'private=1' }); res.end(); return; }
    res.writeHead(206, { 'Content-Range': 'bytes 1-2/4', 'Set-Cookie': 'private=1', 'Access-Control-Allow-Origin': '*' }); res.end('ok');
  });
  upstream.on('upgrade', (req, socket) => {
    requests.push({ url: req.url, headers: req.headers, body: '' });
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    socket.write(Buffer.from([0x81, 2, 111, 107]));
    socket.on('error', () => {});
    socket.on('end', () => socket.destroy());
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => { upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); });
  const target = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  const preview = new KanbanPreview(root, { artifactDir: 'build', entry: 'index.html', webApp: { service: 'sample.app', permissions: microphone ? ['microphone'] : [] } }, () => ({ id: 'default', name: 'Default', params: {} }));
  const binding = { service: 'sample.app', apiBaseUrl: target + '/api', bootstrap: login ? null : { token: 'scoped-token', label: '</script><script>bad()</script>' },
    ...(login ? { login: { kind: 'external' as const, serverUrl: 'https://accounts.invalid', environment: 'Online' } } : {}) };
  const clicks: boolean[] = [];
  const app = new WebAppPreview(() => hostNotifications ? { nonce: preview.nonce, artifact: preview.artifact,
    asset: url => preview.asset(url), hostNotifications } : preview, binding, () => { clicks.push(true); });
  await app.start(); cleanup.push(() => app.close());
  const origin = new URL(app.url).origin, api = origin + '/' + preview.nonce + '/api';
  return { app, preview, api, origin, target, requests, clicks };
}

it('serves bundled assets with a scoped bootstrap and explicitly granted microphone policy', async () => {
  const { app, origin } = await fixture();
  const response = await fetch(app.url, { headers: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Dest': 'iframe' } });
  expect(response.status).toBe(200);
  expect(response.headers.get('permissions-policy')).toContain('microphone=(self)');
  const html = await response.text();
  expect(html).toContain('steamHarnessWebApp'); expect(html).toContain('scoped-token');
  expect(html).not.toContain('</script><script>bad()'); expect(html).toContain('\\u003c/script>');
  expect((await fetch(new URL('app.js', app.url))).status).toBe(200);
  expect((await fetch(origin + '/index.html')).status).toBe(404);
  expect((await fetch(app.url, { headers: { Origin: 'https://outside.invalid' } })).status).toBe(403);
  const other = await fixture(false);
  expect(other.origin).not.toBe(origin);
  expect((await fetch(other.app.url)).headers.get('permissions-policy')).toContain('microphone=()');
});

it('proxies only nonce-scoped service API paths, preserving signed queries, uploads and Range', async () => {
  const { api, requests, origin } = await fixture();
  const response = await fetch(api + '/files/blob?signature=a%2Bb&expires=123', { method: 'POST', headers: { Authorization: 'Bearer scoped', Cookie: 'host=secret', Range: 'bytes=1-2', Origin: origin }, body: 'upload-data' });
  expect(response.status).toBe(206); expect(await response.text()).toBe('ok');
  expect(response.headers.get('content-range')).toBe('bytes 1-2/4');
  expect(response.headers.get('set-cookie')).toBeNull(); expect(response.headers.get('access-control-allow-origin')).toBeNull();
  expect(requests[0]).toMatchObject({ url: '/api/files/blob?signature=a%2Bb&expires=123', body: 'upload-data', headers: { authorization: 'Bearer scoped', range: 'bytes=1-2' } });
  expect(requests[0]!.headers.cookie).toBeUndefined(); expect(requests[0]!.headers.origin).toBeUndefined();
  expect((await fetch(api + '/redirect')).status).toBe(502);
  expect((await fetch(api + '/files', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status).toBe(403);
  expect((await fetch(api + '/%2fadmin')).status).toBe(404);
  expect(requests).toHaveLength(2);
});

it('delegates browser notifications only for assets from an opted-in host', async () => {
  for (const hostNotifications of [true, false]) {
    const { app } = await fixture(true, false, hostNotifications);
    const html = await (await fetch(app.url)).text();
    const window: Record<string, any> = {};
    runInNewContext(html.match(/<script nonce="[^"]+">(.*?)<\/script>/s)![1]!, { window, localStorage: { removeItem() {} } });
    expect(window.steamHarnessWebApp.notifications).toBe(hostNotifications ? 'host' : undefined);
  }
});

it('forwards WebSocket upgrades and destroys active sockets and the old origin when closed', async () => {
  const { api, app, origin, requests } = await fixture();
  const ws = new WebSocket(api.replace('http:', 'ws:') + '/im/socket');
  const message = await new Promise<MessageEvent>(resolve => ws.addEventListener('message', resolve, { once: true }));
  expect(message.data).toBe('ok'); expect(requests[0]!.url).toBe('/api/im/socket');
  const closed = new Promise(resolve => ws.addEventListener('close', resolve, { once: true }));
  await app.close(); await closed;
  await expect(fetch(origin)).rejects.toThrow();
});

it('rejects remote HTTP targets, credentials, redirect queries and invalid entry bindings', () => {
  for (const apiBaseUrl of ['http://remote.invalid/api', 'https://user:secret@remote.invalid/api', 'https://remote.invalid/api?target=elsewhere', 'https://remote.invalid/']) {
    expect(() => parseWebAppBindings({ main: { service: 'sample.app', apiBaseUrl } })).toThrow();
  }
  expect(parseWebAppBindings({ main: { service: 'sample.app', apiBaseUrl: 'https://service.invalid/api', bootstrap: { token: 'scoped' } } }).main!.bootstrap).toEqual({ token: 'scoped' });
});

it('a sign-in preview remains offline until a same-origin explicit login action', async () => {
  const { app, preview, origin, api, clicks, requests } = await fixture(true, true);
  const html = await (await fetch(app.url)).text();
  const window: Record<string, any> = {}, invoked: string[] = [];
  runInNewContext(html.match(/<script nonce="[^"]+">(.*?)<\/script>/s)![1]!, {
    window, localStorage: { removeItem() {} }, fetch: async (url: string) => { invoked.push(url); return Response.json({}); },
  });
  expect(window.steamHarnessWebApp.login.kind).toBe('external');
  expect(window.steamHarnessWebApp.session).toBeNull();
  expect(invoked).toHaveLength(0);
  await window.steamHarnessWebApp.requestLogin();
  expect(invoked).toEqual([`/${preview.nonce}/host/login`]);
  expect(clicks).toHaveLength(0);
  expect((await fetch(api + '/im/messages')).status).toBe(503);
  const action = origin + '/' + preview.nonce + '/host/login';
  expect((await fetch(action)).status).toBe(405);
  expect((await fetch(action, { method: 'POST', headers: { 'Content-Type': 'application/json' } })).status).toBe(403);
  expect((await fetch(action, { method: 'POST', headers: { Origin: 'https://other.invalid', 'Content-Type': 'application/json' } })).status).toBe(403);
  const click = () => fetch(action, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}' });
  expect((await click()).status).toBe(202);
  expect((await click()).status).toBe(202);
  expect(clicks, 'Cancellation leaves the host action available').toHaveLength(2);
  expect(requests).toHaveLength(0);
  await app.close();
  await expect(click()).rejects.toThrow();
});

it('sign-in descriptors reject unsafe issuers and cannot coexist with an authenticated bootstrap', () => {
  const base = { service: 'sample.app', apiBaseUrl: 'https://im.invalid/api', bootstrap: null };
  for (const serverUrl of ['http://remote.invalid', 'https://user:secret@accounts.invalid', 'https://accounts.invalid/login', 'https://accounts.invalid?redirect=bad']) {
    expect(() => parseWebAppBindings({ main: { ...base, login: { kind: 'external', serverUrl } } })).toThrow();
  }
  expect(() => parseWebAppBindings({ main: { ...base, bootstrap: { token: 'secret' }, login: { kind: 'studio', serverUrl: 'https://accounts.invalid' } } })).toThrow();
});
