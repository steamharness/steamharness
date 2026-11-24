import http from 'node:http';
import https from 'node:https';
import qrcode from 'qrcode-generator';
import { equalSecret, isSecret, openSessions, secret, SESSION_SECONDS } from './sessions.mjs';
import { pairPage } from './pair-page.mjs';
import { relay, relayUpgrade } from './relay.mjs';

const cookie = '__Host-steamharness-studio';
const route = '/_studio/web/';
const isWrite = req => req.method === 'POST' && req.headers['content-type'] === 'application/json';
const limitWindow = 60_000;

export function json(res, status, value) {
  res.writeHead(status, { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
}

export async function readJson(req) {
  const parts = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4096) throw new Error('Request too large.');
    parts.push(chunk);
  }
  const result = JSON.parse(Buffer.concat(parts).toString('utf8'));
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Expected an object.');
  return result;
}

export function listen(server, host, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host, port, exclusive: true }, () => { server.off('error', reject); resolve(server.address().port); });
  });
}

function requestUrl(req) {
  if (!req.url?.startsWith('/') || req.url.startsWith('//') || /[\\\u0000-\u0020\u007f]/u.test(req.url)) return;
  return new URL(req.url, 'http://studio.invalid');
}

const workbenchOrigin = (req, origin) => {
  if (req.headers.origin !== undefined && req.headers.origin !== origin) return false;
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') {
    return req.method === 'GET' && req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document';
  }
  return true;
};

export async function startGateway({ config, directory, workbench, proof, stop, now = Date.now }) {
  const servers = [], sockets = new Set(), active = new Map(), targets = new Map(), leases = new Map();
  const adminKey = secret(), registryKey = secret();
  const localPreviewOrigins = new Map();
  // The development workbench loads thousands of ES modules. Reuse sockets to its trusted backend only.
  const workbenchAgent = new http.Agent({ keepAlive: true, maxSockets: 32, maxFreeSockets: 8 });
  const remote = [config.proxy, config.lan].filter(Boolean);
  const entryOrigins = remote.map(entry => ({ url: entry.workbench.origin, preview: entry.preview.origin }));
  let localPort, previewPort, closing, adminPort;
  let remainingAttempts = 20, renewAttempts = 0;
  const sessions = await openSessions(directory, id => {
    disconnect(id);
    for (const lease of leases.values()) if (lease.owner === id) retireTarget(lease.targetId);
  }, now);

  function retireTarget(id) {
    const target = targets.get(id);
    if (!target) return;
    targets.delete(id);
    if (target.lease) { leases.delete(target.lease); disconnect(`lease:${target.lease}`); }
    if (!target.registration.destroyed) target.registration.end();
  }

  function track(id, drop) {
    const entries = active.get(id) ?? new Set();
    active.set(id, entries); entries.add(drop);
    return () => { entries.delete(drop); if (!entries.size && active.get(id) === entries) active.delete(id); };
  }
  function disconnect(id) {
    const entries = active.get(id);
    if (!entries) return;
    active.delete(id);
    for (const drop of entries) drop();
  }
  function attach(server) {
    servers.push(server);
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    server.on('upgrade', (_req, socket) => { if (!server.studioUpgrades) socket.destroy(); });
    return server;
  }
  const localUrls = () => [...localPreviewOrigins.keys()];
  const status = mode => ({ mode, running: true, localUrls: localUrls(), remoteUrls: entryOrigins.map(entry => entry.url), devices: sessions.list(), pairExpiresAt: sessions.pairExpiresAt() });

  async function manage(res, input, mode) {
    switch (input.action) {
      case 'status': return json(res, 200, status(mode));
      case 'generate': {
        const endpoint = entryOrigins.find(entry => entry.url === input.origin);
        if (!endpoint) return json(res, 409, { error: 'unconfigured' });
        const pair = sessions.issue(endpoint.url);
        const link = `${endpoint.url}/pair#code=${pair.code}`;
        const qr = qrcode(0, 'M'); qr.addData(link); qr.make();
        return json(res, 200, { ...status(mode), pair: { ...pair, link, qr: qr.createDataURL(4, 16) } });
      }
      case 'revoke':
        if (typeof input.id !== 'string' || !/^[\da-f-]{36}$/i.test(input.id)) return json(res, 400, { error: 'invalid' });
        await sessions.revoke(input.id);
        return json(res, 200, status(mode));
      case 'stop':
        res.once('finish', stop);
        return json(res, 200, { mode, running: false, localUrls: [], remoteUrls: [], devices: [] });
      default: return json(res, 400, { error: 'invalid' });
    }
  }

  function register(res, input) {
    if (input.action === 'unregister' && isSecret(input.id)) {
      retireTarget(input.id);
      return json(res, 200, { ok: true });
    }
    if (input.action !== 'register' || !['project', 'hosted'].includes(input.kind) || !Number.isInteger(input.port) || input.port < 1 || input.port > 65_535 ||
        [workbench, localPort, previewPort, adminPort, config.proxy?.port, ...(config.lan?.ports ?? [])].includes(input.port) || targets.size >= 512) {
      return json(res, 400, { error: 'invalid' });
    }
    const id = secret();
    // A private open response keeps the target owned by the extension host.
    // Losing that process also revokes the target, even without an explicit unregister.
    targets.set(id, { port: input.port, registration: res });
    res.once('close', () => retireTarget(id));
    res.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': 'application/x-ndjson' });
    res.write(`${JSON.stringify({ id })}\n`);
  }

  function mint(res, input, origin, owner, preview) {
    const target = targets.get(input.id);
    if (!target || target.lease || target.registration.destroyed) return json(res, 404, { error: 'preview' });
    const id = secret();
    target.lease = id;
    leases.set(id, { owner, origin, preview, targetId: input.id, target });
    return json(res, 200, { url: `${preview}/p/${id}` });
  }

  function identity(req, origin, local) {
    if (local) return `local:${origin}`;
    const values = req.headers.cookie?.split(';').map(value => value.trim()).filter(value => value.startsWith(`${cookie}=`));
    return values?.length === 1 ? sessions.check(values[0].slice(cookie.length + 1), origin)?.id : undefined;
  }

  function previewTarget(req, entry, url, upgrade) {
    const match = /^\/p\/([\w-]{43})(\/.*)$/.exec(url.pathname);
    if (!match || match[2].startsWith('//')) return;
    const id = match[1], lease = leases.get(id);
    if (!lease || lease.preview !== entry.origin || lease.target.registration.destroyed || !lease.owner.startsWith('local:') && !sessions.has(lease.owner)) return;
    const resource = !upgrade && ['GET', 'HEAD'].includes(req.method) && /^(?:\/entries\/[\w-]+)?\/(?:kanban|resource-assets)\//.test(match[2]);
    if (req.headers.origin !== undefined && req.headers.origin !== entry.origin && !(req.headers.origin === 'null' && resource)) return;
    if (upgrade && req.headers.origin !== entry.origin || !['GET', 'HEAD'].includes(req.method) && req.headers.origin !== entry.origin) return;
    const host = `127.0.0.1:${lease.target.port}`;
    return { id: `lease:${id}`, port: lease.target.port, host, origin: entry.origin, ancestor: lease.origin, mount: `/p/${id}`, path: match[2] + url.search };
  }

  function select(req, entries) {
    if (req.headersDistinct?.host?.length !== 1) return;
    return entries.get(req.headers.host?.toLowerCase());
  }

  function publicServer(entries, tls) {
    const handler = (req, res) => {
      void (async () => {
        const entry = select(req, entries), url = requestUrl(req);
        if (!entry || !url) return json(res, 403, { error: 'origin' });
        if (entry.previewOnly) {
          const target = previewTarget(req, entry, url, false);
          if (!target) return json(res, 404, { error: 'preview' });
          return relay(req, res, target, drop => track(target.id, drop));
        }
        if (!workbenchOrigin(req, entry.origin)) return json(res, 403, { error: 'origin' });
        const owner = identity(req, entry.origin, entry.local);
        if (url.pathname === '/pair' && req.method === 'GET') {
          if (owner) { res.writeHead(303, { Location: '/', 'Cache-Control': 'no-store' }); res.end(); return; }
          return pairPage(req, res);
        }
        if (url.pathname.startsWith(route)) {
          if (!isWrite(req) || req.headers.origin !== entry.origin || req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin') return json(res, 403, { error: 'origin' });
          if (url.pathname === `${route}pair` && !entry.local) {
            if (now() >= renewAttempts) { remainingAttempts = 20; renewAttempts = now() + limitWindow; }
            if (remainingAttempts <= 0) { res.setHeader('Retry-After', '60'); return json(res, 429, { error: 'rate' }); }
            remainingAttempts--;
            const input = await readJson(req);
            const token = await sessions.redeem(input.code, entry.origin, req.headers['user-agent']);
            if (!token) return json(res, 401, { error: 'code' });
            if (owner) await sessions.revoke(owner);
            res.setHeader('Set-Cookie', `${cookie}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_SECONDS}`);
            return json(res, 200, { ok: true });
          }
          if (!owner) return json(res, 401, { error: 'pair' });
          const input = await readJson(req);
          if (url.pathname === `${route}preview`) return mint(res, input, entry.origin, owner, entry.preview);
          if (url.pathname !== `${route}manage`) return json(res, 404, { error: 'invalid' });
          if (entry.local) return manage(res, input, 'local');
          if (input.action === 'status') return json(res, 200, { mode: 'remote', running: true, devices: [], localUrls: [], remoteUrls: [] });
          if (input.action !== 'logout') return json(res, 403, { error: 'local-only' });
          await sessions.revoke(owner);
          res.setHeader('Set-Cookie', `${cookie}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
          return json(res, 200, { mode: 'remote', running: false, devices: [], localUrls: [], remoteUrls: [] });
        }
        if (!owner) {
          if (req.method === 'GET' && (req.headers['sec-fetch-dest'] === 'document' || String(req.headers.accept).includes('text/html'))) {
            res.writeHead(303, { Location: '/pair', 'Cache-Control': 'no-store' }); res.end(); return;
          }
          return json(res, 401, { error: 'pair' });
        }
        relay(req, res, { port: workbench, path: url.pathname + url.search, host: req.headers.host, origin: entry.origin, proof, agent: workbenchAgent }, drop => track(owner, drop));
      })().catch(() => { if (!res.headersSent && !res.destroyed) json(res, 400, { error: 'request' }); else res.destroy(); });
    };
    const options = { requestTimeout: 30_000, headersTimeout: 10_000, ...(tls ?? {}) };
    const server = attach(tls ? https.createServer(options, handler) : http.createServer(options, handler));
    server.studioUpgrades = true;
    server.on('upgrade', (req, socket, head) => {
      const entry = select(req, entries), url = requestUrl(req);
      let target;
      if (entry && url && req.headers.upgrade?.toLowerCase() === 'websocket' && req.headers.origin === entry.origin) {
        if (entry.previewOnly) target = previewTarget(req, entry, url, true);
        else if (!url.pathname.startsWith(route) && url.pathname !== '/pair') {
          const id = identity(req, entry.origin, entry.local);
          if (id) target = { id, port: workbench, path: url.pathname + url.search, host: req.headers.host, origin: entry.origin, proof };
        }
      }
      if (!target) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return; }
      relayUpgrade(req, socket, head, target, drop => track(target.id, drop));
    });
    return server;
  }

  async function close() {
    if (closing) return closing;
    closing = (async () => {
      for (const id of targets.keys()) retireTarget(id);
      for (const id of [...active.keys()]) disconnect(id);
      workbenchAgent.destroy();
      const stopped = servers.filter(server => server.listening).map(server => new Promise(resolve => server.close(resolve)));
      for (const socket of sockets) socket.destroy();
      await Promise.all([...stopped, sessions.close()]);
    })();
    return closing;
  }

  try {
    const localEntries = new Map(), localPreviews = new Map();
    const previewServer = publicServer(localPreviews);
    previewPort = await listen(previewServer, '127.0.0.1');
    for (let port = config.local.first; port <= config.local.last; port++) {
      try { localPort = await listen(publicServer(localEntries), '127.0.0.1', port); break; }
      catch (error) { if (error.code !== 'EADDRINUSE') throw error; }
    }
    if (!localPort) throw new Error('No Studio Web local port is available.');
    for (const host of ['127.0.0.1', 'localhost']) {
      const origin = `http://${host}:${localPort}`, preview = `http://${host}:${previewPort}`;
      localEntries.set(`${host}:${localPort}`, { origin, preview, local: true });
      localPreviews.set(`${host}:${previewPort}`, { origin: preview, previewOnly: true });
      localPreviewOrigins.set(origin, preview);
    }
    // `localhost` may resolve to IPv6 first. Do not expose other interfaces.
    for (const [entries, port] of [[localEntries, localPort], [localPreviews, previewPort]]) {
      try { await listen(publicServer(entries), '::1', port); }
      catch (error) { if (!['EADDRINUSE', 'EADDRNOTAVAIL', 'EAFNOSUPPORT'].includes(error.code)) throw error; }
    }
    for (const entry of remote) {
      const entries = new Map([[entry.workbench.host, { origin: entry.workbench.origin, preview: entry.preview.origin }],
        [entry.preview.host, { origin: entry.preview.origin, previewOnly: true }]]);
      for (const port of entry.ports ?? [entry.port]) {
        const allowed = entry.tls ? new Map([...entries].filter(([host]) => Number(new URL(`https://${host}`).port || 443) === port)) : entries;
        await listen(publicServer(allowed, entry.tls), entry.host, port);
      }
    }
    const admin = attach(http.createServer({ requestTimeout: 10_000 }, (req, res) => {
      void (async () => {
        if (req.headers.host !== `127.0.0.1:${adminPort}` || req.headers.origin !== undefined || !isWrite(req)) return json(res, 403, { error: 'origin' });
        if (req.url === '/manage' && equalSecret(req.headers.authorization, `Bearer ${adminKey}`)) return manage(res, await readJson(req), 'desktop');
        if (req.url === '/targets' && equalSecret(req.headers.authorization, `Bearer ${registryKey}`)) return register(res, await readJson(req));
        return json(res, 403, { error: 'origin' });
      })().catch(() => { if (!res.headersSent && !res.destroyed) json(res, 400, { error: 'request' }); else res.destroy(); });
    }));
    adminPort = await listen(admin, '127.0.0.1');
    return { getStatus: () => status('desktop'), admin: { port: adminPort, key: adminKey }, registry: { port: adminPort, key: registryKey }, close };
  } catch (error) { await close(); throw error; }
}
