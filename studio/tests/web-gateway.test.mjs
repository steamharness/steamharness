import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { brotliCompressSync, brotliDecompressSync, gzipSync, gunzipSync } from 'node:zlib';
import { webConfig } from '../scripts/web/config.mjs';
import { listen, startGateway } from '../scripts/web/gateway.mjs';
import { openSessions, PAIR_MS, secret, SESSION_SECONDS } from '../scripts/web/sessions.mjs';

const workbenchOrigin = 'https://studio.example.test', previewOrigin = 'https://preview.example.test';
const endpoint = '/_studio/web/';
const workerFrame = '/oss-dev/static/out/vs/workbench/services/extensions/worker/webWorkerExtensionHostIframe.html';
const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
async function freePort() {
  const server = http.createServer();
  const port = await listen(server, '127.0.0.1');
  await close(server);
  return port;
}

test('pairing expires, is single-use, is origin-bound and survives restart only as a hashed session', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sh-pair-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ended = [];
  let now = Date.now();
  const store = await openSessions(directory, id => ended.push(id), () => now);
  const initial = store.issue(workbenchOrigin);
  const valid = store.issue(workbenchOrigin);
  assert.equal(await store.redeem(initial.code, workbenchOrigin), undefined);
  assert.equal(await store.redeem(valid.code, previewOrigin), undefined);
  const [token, duplicate] = await Promise.all([store.redeem(valid.code, workbenchOrigin, 'Linux Chrome/5'), store.redeem(valid.code, workbenchOrigin)]);
  assert.ok(token); assert.equal(duplicate, undefined);
  const device = store.check(token, workbenchOrigin);
  assert.equal(device.label, 'Chrome · Linux');
  assert.equal(store.check(token, previewOrigin), undefined);
  const expired = store.issue(workbenchOrigin);
  now += PAIR_MS;
  assert.equal(await store.redeem(expired.code, workbenchOrigin), undefined);
  await store.close();
  const saved = await readFile(path.join(directory, 'paired-devices.json'), 'utf8');
  assert.ok(!saved.includes(token) && !saved.includes(valid.code));
  const restored = await openSessions(directory, id => ended.push(id), () => now);
  assert.equal(restored.check(token, workbenchOrigin)?.id, device.id);
  await restored.revoke(device.id);
  assert.deepEqual(ended, [device.id]);
  assert.equal(restored.check(token, workbenchOrigin), undefined);
  const longLived = await restored.redeem(restored.issue(workbenchOrigin).code, workbenchOrigin);
  now += SESSION_SECONDS * 1000;
  assert.equal(restored.check(longLived, workbenchOrigin), undefined);
  await restored.close();
});

test('configuration fails closed on missing or overlapping remote HTTPS settings', async () => {
  await assert.rejects(webConfig({ STEAMHARNESS_STUDIO_WEB_PROXY_ORIGIN: 'http://studio.example.test' }), /HTTPS/);
  await assert.rejects(webConfig({ STEAMHARNESS_STUDIO_WEB_LAN_ORIGIN: workbenchOrigin }), /LAN_HOST/);
  await assert.rejects(webConfig({ STEAMHARNESS_STUDIO_WEB_PROXY_PREVIEW_ORIGIN: previewOrigin }), /PROXY_ORIGIN/);
  await assert.rejects(webConfig({ STEAMHARNESS_STUDIO_WEB_PROXY_ORIGIN: workbenchOrigin, STEAMHARNESS_STUDIO_WEB_PROXY_PREVIEW_ORIGIN: workbenchOrigin + ':8443' }), /different hostname/);
  await assert.rejects(webConfig({ STEAMHARNESS_STUDIO_WEB_PROXY_PORT: '3030' }), /local port range/);
  await assert.rejects(webConfig({ STEAMHARNESS_STUDIO_WEB_PROXY_ACCEPT_LOOPBACK_HOST: '1' }), /PROXY_ORIGIN/);
  await assert.rejects(webConfig({ STEAMHARNESS_STUDIO_WEB_PROXY_ACCEPT_LOOPBACK_HOST: '*' }), /PROXY_ACCEPT_LOOPBACK_HOST/);
  await assert.rejects(webConfig({ STEAMHARNESS_STUDIO_WEB_PROXY_WEBSOCKET_PORT: '7302' }), /PROXY_ORIGIN/);
  await assert.rejects(webConfig({ STEAMHARNESS_STUDIO_WEB_PROXY_ORIGIN: workbenchOrigin, STEAMHARNESS_STUDIO_WEB_PROXY_WEBSOCKET_PORT: '65536' }), /PROXY_WEBSOCKET_PORT/);
  await assert.rejects(webConfig({ STEAMHARNESS_STUDIO_WEB_PROXY_ORIGIN: workbenchOrigin + ':8443', STEAMHARNESS_STUDIO_WEB_PROXY_WEBSOCKET_PORT: '7302' }), /default HTTPS port/);
});

test('a workbench-only proxy requires pairing and leaves registered previews unavailable remotely', { timeout: 10_000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sh-workbench-only-'));
  const upstream = http.createServer((_req, res) => res.end('workbench'));
  const app = http.createServer((_req, res) => res.end('preview'));
  let gateway;
  t.after(async () => {
    await gateway?.close();
    await Promise.all([close(upstream), close(app)]);
    await rm(directory, { recursive: true, force: true });
  });
  const [workbench, appPort] = await Promise.all([listen(upstream, '127.0.0.1'), listen(app, '127.0.0.1')]);
  const localPort = await freePort(), proxyPort = await freePort();
  const config = await webConfig({ STEAMHARNESS_STUDIO_WEB_PROXY_ORIGIN: workbenchOrigin,
    STEAMHARNESS_STUDIO_WEB_PROXY_PORT: String(proxyPort) }, String(localPort));
  gateway = await startGateway({ config, directory, workbench, proof: secret(), stop() {} });
  const local = `http://127.0.0.1:${localPort}`;
  const request = (route, headers = {}, body) => new Promise((resolve, reject) => {
    const req = http.request(`http://127.0.0.1:${proxyPort}${route}`, { method: body ? 'POST' : 'GET', agent: false,
      headers: { Host: new URL(workbenchOrigin).host, ...(body ? { 'Content-Type': 'application/json', Origin: workbenchOrigin } : {}), ...headers } },
    res => resolve(new Response(Readable.toWeb(res), { status: res.statusCode, headers: res.headers })));
    req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
  const unpaired = await request('/', { Accept: 'text/html' });
  assert.equal(unpaired.status, 303);
  assert.equal(unpaired.headers.get('location'), '/pair');
  assert.equal((await request('/', { Host: `127.0.0.1:${proxyPort}` })).status, 403);
  assert.equal((await request('/', { Host: `localhost:${proxyPort}` })).status, 403);
  assert.equal((await request('/', { Host: 'other.example.test' })).status, 403);
  assert.equal((await request('/', { Origin: 'https://other.example.test' })).status, 403);

  const generated = await fetch(local + endpoint + 'manage', { method: 'POST', headers: { Origin: local, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'generate', origin: workbenchOrigin }) });
  const { pair } = await generated.json();
  const paired = await request(endpoint + 'pair', {}, { code: pair.code });
  assert.equal(paired.status, 200);
  const setCookie = paired.headers.get('set-cookie');
  assert.match(setCookie, /; HttpOnly; Secure; SameSite=Strict;/);
  const cookie = setCookie.split(';')[0];
  assert.equal(await (await request('/', { Cookie: cookie })).text(), 'workbench');

  const registration = await fetch(`http://127.0.0.1:${gateway.registry.port}/targets`, { method: 'POST',
    headers: { Authorization: `Bearer ${gateway.registry.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'register', kind: 'hosted', port: appPort }) });
  const { id } = JSON.parse(Buffer.from((await registration.body.getReader().read()).value).toString());
  const preview = await request(endpoint + 'preview', { Cookie: cookie }, { id });
  assert.equal(preview.status, 404);
  assert.deepEqual(await preview.json(), { error: 'preview' });
});

test('the remote listener gates HTTP, upgrades and previews even with a loopback peer', { timeout: 10_000 }, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sh-web-gateway-'));
  const proof = secret(), record = [];
  const workbenchSockets = new Set();
  const upstream = http.createServer((req, res) => {
    record.push(req.headers);
    workbenchSockets.add(req.socket);
    if (req.url === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: workbench ready\n\n');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'self'" });
    res.end('workbench');
  });
  const sockets = new Set();
  const acceptUpgrade = (req, socket) => {
    record.push(req.headers); sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  };
  upstream.on('upgrade', acceptUpgrade);
  const app = http.createServer((req, res) => {
    record.push(req.headers);
    res.setHeader('Set-Cookie', 'app=1; Path=/');
    res.setHeader('Service-Worker-Allowed', '/');
    if (req.url === '/events') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('data: ready\n\n'); }
    else { res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'" }); res.end('preview'); }
  });
  app.on('upgrade', acceptUpgrade);
  const [workbench, target] = await Promise.all([listen(upstream, '127.0.0.1'), listen(app, '127.0.0.1')]);
  const localPort = await freePort(), proxyPort = await freePort();
  const config = await webConfig({ STEAMHARNESS_STUDIO_WEB_LOCAL_PORT: String(localPort), STEAMHARNESS_STUDIO_WEB_PROXY_PORT: String(proxyPort),
    STEAMHARNESS_STUDIO_WEB_PROXY_ORIGIN: workbenchOrigin, STEAMHARNESS_STUDIO_WEB_PROXY_PREVIEW_ORIGIN: previewOrigin,
    STEAMHARNESS_STUDIO_WEB_PROXY_ACCEPT_LOOPBACK_HOST: '1' });
  const webviewDirectory = path.join(dir, 'webview');
  await mkdir(webviewDirectory);
  await writeFile(path.join(webviewDirectory, 'index.html'), 'webview shell');
  await writeFile(path.join(webviewDirectory, 'fake.html'), 'webview frame');
  await writeFile(path.join(webviewDirectory, 'service-worker.js'), '/* webview worker */');
  const client = 'workbench.studio-web-fixture.js', contents = Buffer.from('globalThis.studio = true;');
  const asset = `/oss-dev/static/out/vs/code/browser/workbench/${client}`;
  const clientEtag = 'W/"fixture"';
  const variants = {};
  for (const [encoding, data] of [['identity', contents], ['br', brotliCompressSync(contents)], ['gzip', gzipSync(contents)]]) {
    const file = path.join(dir, encoding);
    await writeFile(file, data);
    variants[encoding] = { file, size: data.length };
  }
  const clientAssets = new Map([[client, { variants, mime: 'text/javascript', etag: clientEtag }]]);
  const gateway = await startGateway({ config, directory: dir, workbench, webviewDirectory, clientAssets, proof, stop() {} });
  t.after(async () => {
    await gateway.close();
    for (const s of sockets) s.destroy();
    await Promise.all([close(upstream), close(app)]);
    await rm(dir, { recursive: true, force: true });
  });
  const local = `http://127.0.0.1:${localPort}`, proxy = `http://127.0.0.1:${proxyPort}`;
  const proxyHost = new URL(proxy).host;
  const rewritten = { Host: proxyHost };
  const request = (origin, route, headers = {}, body) => new Promise((resolve, reject) => {
    const req = http.request((origin === local ? local : proxy) + route, { method: body ? 'POST' : 'GET', agent: false,
      headers: { Host: new URL(origin).host, ...headers, ...(body ? { 'Content-Type': 'application/json', Origin: origin } : {}) } },
    res => {
      if (res.statusCode === 304) res.resume();
      resolve(new Response(res.statusCode === 304 ? null : Readable.toWeb(res), { status: res.statusCode, headers: res.headers }));
    });
    req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
  const admin = input => request(local, endpoint + 'manage', {}, input);
  async function upgrade(cookie, origin = workbenchOrigin, route = '/socket', host = new URL(origin).host) {
    const socket = net.connect(proxyPort, '127.0.0.1');
    socket.on('error', () => undefined);
    await once(socket, 'connect');
    const first = once(socket, 'data');
    socket.write(`GET ${route} HTTP/1.1\r\nHost: ${host}\r\nOrigin: ${origin}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n${cookie ? `Cookie: ${cookie}\r\n` : ''}\r\n`);
    return { socket, response: (await first)[0].toString() };
  }
  assert.equal((await request(workbenchOrigin, '/', { Accept: 'text/html', 'X-Forwarded-Host': new URL(local).host })).headers.get('location'), '/pair');
  const proxyEntry = await request(workbenchOrigin, '/', { ...rewritten, Accept: 'text/html' });
  assert.equal(proxyEntry.status, 303);
  assert.equal(proxyEntry.headers.get('location'), '/pair');
  assert.equal((await request(workbenchOrigin, '/pair', rewritten)).status, 200);
  assert.equal((await request(workbenchOrigin, '/static/resource', rewritten)).status, 401);
  assert.equal((await request(workbenchOrigin, asset, { ...rewritten, 'If-None-Match': clientEtag })).status, 401);
  assert.equal((await request(previewOrigin, asset)).status, 404);
  assert.equal((await request(workbenchOrigin, '/', { ...rewritten, Origin: previewOrigin })).status, 403);
  assert.equal((await request(workbenchOrigin, '/', { Host: new URL(local).host, 'X-Forwarded-Host': new URL(workbenchOrigin).host })).status, 403);
  const imQuery = '?im=chat&conversation_id=group_a%26b';
  assert.equal((await request(workbenchOrigin, `/${imQuery}&returnTo=//other.example&token=no`, { Accept: 'text/html' })).headers.get('location'), '/pair' + imQuery);
  assert.equal((await request(workbenchOrigin, `/${imQuery}&user_id=another`, { Accept: 'text/html' })).headers.get('location'), '/pair');
  const pairDocument = await (await request(workbenchOrigin, '/pair' + imQuery)).text();
  assert.ok(pairDocument.includes(`location.replace("/${imQuery}")`));
  assert.equal((await request(workbenchOrigin, '/static/resource')).status, 401);
  assert.equal((await request(workbenchOrigin, workerFrame)).status, 401);
  const denied = await upgrade(undefined, workbenchOrigin, '/socket', proxyHost); assert.match(denied.response, /403/); denied.socket.destroy();
  assert.equal(record.length, 0);
  assert.equal((await request(previewOrigin, `/p/${secret()}/`)).status, 404);
  assert.equal((await request(local, '/', { Origin: previewOrigin })).status, 403);
  const localWorkbench = await request(local, '/');
  assert.equal(await localWorkbench.text(), 'workbench');
  assert.equal(localWorkbench.headers.get('content-security-policy'), "default-src 'self'; frame-ancestors 'none'");
  assert.equal(record.at(-1)['x-steamharness-webview-port'], String(localPort));
  const localWorker = await request(local, `${workerFrame}?vscode-coi=3`, { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Dest': 'iframe' });
  assert.equal(localWorker.headers.get('content-security-policy'), "default-src 'self'; frame-ancestors 'self'");
  assert.equal((await request(local, workerFrame, { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Dest': 'iframe' })).status, 403);

  const originHost = { Host: `${'a'.repeat(52)}.localhost:${localPort}` };
  const webviewPath = '/_studio/webview/';
  const shell = `${webviewPath}index.html?parentOrigin=${encodeURIComponent(local)}`;
  const localView = await request(local, shell, originHost);
  assert.equal(await localView.text(), 'webview shell');
  assert.equal(localView.headers.get('content-security-policy'), `frame-ancestors ${local}`);
  const nestedView = await request(local, `${webviewPath}fake.html`, originHost);
  assert.equal(nestedView.headers.get('content-security-policy'), `frame-ancestors 'self' ${local} http://localhost:${localPort}`);
  const worker = await request(local, `${webviewPath}service-worker.js`, originHost);
  assert.equal(await worker.text(), '/* webview worker */');
  assert.equal(worker.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal((await request(local, `${webviewPath}index.html?parentOrigin=${encodeURIComponent(workbenchOrigin)}`, originHost)).status, 403);
  assert.equal((await request(local, shell, originHost, {})).status, 405);
  assert.equal((await request(local, '/', originHost)).status, 404);
  assert.equal((await request(local, `${endpoint}manage`, originHost, { action: 'status' })).status, 404);
  assert.equal((await request(local, `${webviewPath}../web/manage`, originHost)).status, 404);
  assert.equal((await request(workbenchOrigin, shell, originHost)).status, 403);

  const { pair } = await (await admin({ action: 'generate', origin: workbenchOrigin })).json();
  assert.ok(pair.link.endsWith(`/pair#code=${pair.code}`));
  assert.match(pair.qr, /^data:image\/gif;base64,/);
  const failure = await request(workbenchOrigin, endpoint + 'pair', {}, { code: 'bad' });
  assert.equal(failure.status, 401);
  assert.equal((await request(previewOrigin, endpoint + 'pair', rewritten, { code: pair.code })).status, 403);
  const redeemed = await request(workbenchOrigin, endpoint + 'pair', rewritten, { code: pair.code });
  assert.equal(redeemed.status, 200);
  const setCookie = redeemed.headers.get('set-cookie');
  assert.match(setCookie, /; Path=\/; HttpOnly; Secure; SameSite=Strict;/);
  const cookie = setCookie.split(';')[0];
  assert.equal(await (await request(workbenchOrigin, '/', { ...rewritten, Cookie: cookie, 'X-Forwarded-Host': new URL(previewOrigin).host,
    'X-Steamharness-Gateway': 'client-value', 'X-Steamharness-Webview-Port': String(localPort) })).text(), 'workbench');
  assert.equal((await request(workbenchOrigin, '/pair' + imQuery, { Cookie: cookie })).headers.get('location'), '/' + imQuery);
  assert.equal(record.at(-1)['x-steamharness-gateway'], proof);
  assert.equal(record.at(-1).host, new URL(workbenchOrigin).host);
  assert.equal(record.at(-1)['x-forwarded-host'], undefined);
  assert.equal(record.at(-1)['x-steamharness-webview-port'], undefined);
  assert.equal(record.at(-1).cookie, '');
  const brotli = await request(workbenchOrigin, asset, { Cookie: cookie, 'Accept-Encoding': 'gzip, br' });
  assert.equal(brotli.headers.get('content-encoding'), 'br');
  assert.equal(brotli.headers.get('cache-control'), 'private, max-age=31536000, immutable');
  assert.equal(brotli.headers.get('vary'), 'Accept-Encoding, Cookie');
  assert.deepEqual(brotliDecompressSync(Buffer.from(await brotli.arrayBuffer())), contents);
  const zipped = await request(local, asset, { 'Accept-Encoding': 'br;q=0, gzip' });
  assert.equal(zipped.headers.get('content-encoding'), 'gzip');
  assert.deepEqual(gunzipSync(Buffer.from(await zipped.arrayBuffer())), contents);
  const raw = await request(local, asset);
  assert.equal(raw.headers.get('content-encoding'), null);
  assert.deepEqual(Buffer.from(await raw.arrayBuffer()), contents);
  assert.equal((await request(workbenchOrigin, asset, { Cookie: cookie, 'If-None-Match': clientEtag })).status, 304);
  assert.equal((await request(workbenchOrigin, '/', { Cookie: cookie, 'Accept-Encoding': 'br' })).headers.get('cache-control'), 'no-store');
  const socketsBefore = workbenchSockets.size;
  for (let index = 0; index < 20; index++) {
    assert.equal(await (await request(workbenchOrigin, `/static/module-${index}.js`, { Cookie: cookie })).text(), 'workbench');
  }
  assert.ok(workbenchSockets.size <= socketsBefore + 1, 'sequential workbench requests should reuse a backend socket');
  const remoteWorker = await request(workbenchOrigin, workerFrame, { Cookie: cookie });
  assert.equal(remoteWorker.headers.get('content-security-policy'), "default-src 'self'; frame-ancestors 'self'");
  const otherFrame = await request(workbenchOrigin, `/other${workerFrame}`, { Cookie: cookie });
  assert.equal(otherFrame.headers.get('content-security-policy'), "default-src 'self'; frame-ancestors 'none'");
  assert.equal((await request(workbenchOrigin, endpoint + 'manage', { Cookie: cookie }, { action: 'generate' })).status, 403);
  assert.equal((await request(workbenchOrigin, endpoint + 'manage', { Cookie: cookie }, { action: 'stop' })).status, 403);

  const register = async () => {
    const controller = new AbortController();
    const registry = await fetch(`http://127.0.0.1:${gateway.registry.port}/targets`, { method: 'POST', signal: controller.signal,
      headers: { Authorization: `Bearer ${gateway.registry.key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'register', kind: 'hosted', port: target }) });
    const registration = registry.body.getReader();
    const { id } = JSON.parse(Buffer.from((await registration.read()).value).toString());
    return { id, controller, registration };
  };
  const localEntry = await register();
  const { url: localUrl } = await (await request(local, endpoint + 'preview', {}, { id: localEntry.id })).json();
  const localPreview = await fetch(`${localUrl}/`);
  assert.equal(await localPreview.text(), 'preview');
  assert.equal(localPreview.headers.get('content-security-policy'), `default-src 'none'; frame-ancestors 'self' ${local} http://*.localhost:${localPort}; base-uri 'none'`);
  localEntry.controller.abort();
  const { id, controller } = await register();
  assert.equal((await request(workbenchOrigin, endpoint + 'preview', {}, { id })).status, 401);
  const { url } = await (await request(workbenchOrigin, endpoint + 'preview', { Cookie: cookie }, { id })).json();
  const mount = new URL(url).pathname;
  assert.equal((await request(previewOrigin, mount + '/', rewritten)).status, 401);
  const content = await request(previewOrigin, mount + '/', { Cookie: cookie });
  assert.equal(await content.text(), 'preview');
  assert.match(content.headers.get('content-security-policy'), /frame-ancestors 'self' https:\/\/studio\.example\.test/);
  assert.equal(content.headers.get('set-cookie'), null);
  assert.equal(content.headers.get('service-worker-allowed'), null);
  assert.equal(record.at(-1).cookie, undefined);
  assert.equal(record.at(-1)['x-steamharness-preview-mount'], mount);
  const previewSocket = await upgrade(undefined, previewOrigin, mount + '/socket');
  assert.match(previewSocket.response, /101 Switching Protocols/);
  const previewClosed = once(previewSocket.socket, 'close');
  controller.abort();
  await previewClosed;
  assert.equal((await request(previewOrigin, mount + '/')).status, 404);

  const next = await register();
  const nextUrl = await (await request(workbenchOrigin, endpoint + 'preview', { Cookie: cookie }, { id: next.id })).json();
  const activeMount = new URL(nextUrl.url).pathname;
  const events = (await request(previewOrigin, activeMount + '/events')).body.getReader();
  assert.match(Buffer.from((await events.read()).value).toString(), /ready/);
  const workbenchEvents = (await request(workbenchOrigin, '/events', { Cookie: cookie })).body.getReader();
  assert.match(Buffer.from((await workbenchEvents.read()).value).toString(), /workbench ready/);
  const foreignSocket = await upgrade(cookie, previewOrigin, '/socket', proxyHost);
  assert.match(foreignSocket.response, /403/);
  foreignSocket.socket.destroy();
  const connected = await upgrade(cookie, workbenchOrigin, '/socket', proxyHost);
  assert.match(connected.response, /101 Switching Protocols/);
  assert.equal(record.at(-1).host, new URL(workbenchOrigin).host);
  const disconnected = once(connected.socket, 'close');
  const { devices: [device] } = await (await admin({ action: 'status' })).json();
  await admin({ action: 'revoke', id: device.id });
  await disconnected;
  await assert.rejects(events.read());
  await assert.rejects(workbenchEvents.read());
  assert.equal((await next.registration.read()).done, true);
  assert.equal((await request(previewOrigin, activeMount + '/')).status, 404);
  assert.equal((await request(workbenchOrigin, '/', { Cookie: cookie })).status, 401);
  assert.equal((await request(workbenchOrigin, asset, { Cookie: cookie, 'If-None-Match': clientEtag })).status, 401);
});
