import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { webConfig } from '../scripts/web/config.mjs';
import { listen, startGateway } from '../scripts/web/gateway.mjs';
import { openSessions, PAIR_MS, secret, SESSION_SECONDS } from '../scripts/web/sessions.mjs';

const workbenchOrigin = 'https://studio.example.test', previewOrigin = 'https://preview.example.test';
const endpoint = '/_studio/web/';
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
  await assert.rejects(webConfig({ STEAMHARNESS_STUDIO_WEB_PROXY_ORIGIN: workbenchOrigin, STEAMHARNESS_STUDIO_WEB_PROXY_PREVIEW_ORIGIN: workbenchOrigin + ':8443' }), /different hostname/);
  await assert.rejects(webConfig({ STEAMHARNESS_STUDIO_WEB_PROXY_PORT: '3030' }), /local port range/);
});

test('the remote listener gates HTTP, upgrades and previews even with a loopback peer', { timeout: 10_000 }, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sh-web-gateway-'));
  const proof = secret(), record = [];
  const upstream = http.createServer((req, res) => { record.push(req.headers); res.end('workbench'); });
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
    STEAMHARNESS_STUDIO_WEB_PROXY_ORIGIN: workbenchOrigin, STEAMHARNESS_STUDIO_WEB_PROXY_PREVIEW_ORIGIN: previewOrigin });
  const gateway = await startGateway({ config, directory: dir, workbench, proof, stop() {} });
  t.after(async () => {
    await gateway.close();
    for (const s of sockets) s.destroy();
    await Promise.all([close(upstream), close(app)]);
    await rm(dir, { recursive: true, force: true });
  });
  const local = `http://127.0.0.1:${localPort}`, proxy = `http://127.0.0.1:${proxyPort}`;
  const request = (origin, route, headers = {}, body) => new Promise((resolve, reject) => {
    const req = http.request((origin === local ? local : proxy) + route, { method: body ? 'POST' : 'GET', agent: false,
      headers: { Host: new URL(origin).host, ...headers, ...(body ? { 'Content-Type': 'application/json', Origin: origin } : {}) } },
    res => resolve(new Response(Readable.toWeb(res), { status: res.statusCode, headers: res.headers })));
    req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
  const admin = input => request(local, endpoint + 'manage', {}, input);
  async function upgrade(cookie, origin = workbenchOrigin, route = '/socket') {
    const socket = net.connect(proxyPort, '127.0.0.1');
    socket.on('error', () => undefined);
    await once(socket, 'connect');
    const first = once(socket, 'data');
    socket.write(`GET ${route} HTTP/1.1\r\nHost: ${new URL(origin).host}\r\nOrigin: ${origin}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n${cookie ? `Cookie: ${cookie}\r\n` : ''}\r\n`);
    return { socket, response: (await first)[0].toString() };
  }
  assert.equal((await request(workbenchOrigin, '/', { Accept: 'text/html', 'X-Forwarded-Host': new URL(local).host })).headers.get('location'), '/pair');
  assert.equal((await request(workbenchOrigin, '/static/resource')).status, 401);
  const denied = await upgrade(); assert.match(denied.response, /403/); denied.socket.destroy();
  assert.equal(record.length, 0);
  assert.equal((await request(previewOrigin, `/p/${secret()}/`)).status, 404);
  assert.equal((await request(local, '/', { Origin: previewOrigin })).status, 403);
  assert.equal(await (await request(local, '/')).text(), 'workbench');

  const { pair } = await (await admin({ action: 'generate', origin: workbenchOrigin })).json();
  assert.ok(pair.link.endsWith(`/pair#code=${pair.code}`));
  assert.match(pair.qr, /^data:image\/gif;base64,/);
  const failure = await request(workbenchOrigin, endpoint + 'pair', {}, { code: 'bad' });
  assert.equal(failure.status, 401);
  const redeemed = await request(workbenchOrigin, endpoint + 'pair', {}, { code: pair.code });
  assert.equal(redeemed.status, 200);
  const setCookie = redeemed.headers.get('set-cookie');
  assert.match(setCookie, /; Path=\/; HttpOnly; Secure; SameSite=Strict;/);
  const cookie = setCookie.split(';')[0];
  assert.equal(await (await request(workbenchOrigin, '/', { Cookie: cookie, 'X-Steamharness-Gateway': 'client-value' })).text(), 'workbench');
  assert.equal(record.at(-1)['x-steamharness-gateway'], proof);
  assert.equal(record.at(-1).cookie, '');
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
  const { id, controller } = await register();
  assert.equal((await request(workbenchOrigin, endpoint + 'preview', {}, { id })).status, 401);
  const { url } = await (await request(workbenchOrigin, endpoint + 'preview', { Cookie: cookie }, { id })).json();
  const mount = new URL(url).pathname;
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
  const connected = await upgrade(cookie);
  assert.match(connected.response, /101 Switching Protocols/);
  const disconnected = once(connected.socket, 'close');
  const { devices: [device] } = await (await admin({ action: 'status' })).json();
  await admin({ action: 'revoke', id: device.id });
  await disconnected;
  await assert.rejects(events.read());
  assert.equal((await next.registration.read()).done, true);
  assert.equal((await request(previewOrigin, activeMount + '/')).status, 404);
  assert.equal((await request(workbenchOrigin, '/', { Cookie: cookie })).status, 401);
});
