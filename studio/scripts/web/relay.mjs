import { request } from 'node:http';

const hopByHop = ['connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'proxy-connection', 'proxy-authenticate', 'proxy-authorization'];
const webWorkerHostFrame = /^(?:\/[\w-]+)?\/static\/out\/vs\/workbench\/services\/extensions\/worker\/webWorkerExtensionHostIframe\.html$/;
function filtered(raw) {
  const headers = { ...raw };
  for (const key of [...hopByHop, ...String(headers.connection ?? '').toLowerCase().split(/\s*,\s*/)]) delete headers[key];
  return headers;
}

export function relayHeaders(req, { host, proof, mount, webviewPort, upgrade = false }) {
  const headers = filtered(req.headers);
  for (const key of Object.keys(headers)) {
    if (/^(forwarded$|x-forwarded-|x-original-|x-steamharness-)/.test(key)) delete headers[key];
  }
  headers.host = host;
  if (proof) headers['x-steamharness-gateway'] = proof;
  delete headers.referer;
  if (mount) {
    // The only preview credential is in its path; never pass browser cookies to a project.
    delete headers.cookie;
    delete headers['sec-fetch-site'];
    if (headers.origin && headers.origin !== 'null') headers.origin = `http://${host}`;
    headers['x-steamharness-preview-mount'] = mount;
  } else {
    if (webviewPort) headers['x-steamharness-webview-port'] = String(webviewPort);
    if (headers.cookie) headers.cookie = headers.cookie.split(';').filter(value => !value.trimStart().startsWith('__Host-steamharness-studio=')).join(';');
  }
  if (upgrade) { headers.connection = 'Upgrade'; headers.upgrade = 'websocket'; }
  return headers;
}

function responseHeaders(res, { mount, ancestor, origin, host, path, webviewPort }) {
  const headers = filtered(res.headers);
  delete headers['clear-site-data'];
  headers['cache-control'] = 'no-store';
  headers['referrer-policy'] = 'no-referrer';
  headers['x-content-type-options'] = 'nosniff';
  if (mount) {
    delete headers['set-cookie'];
    delete headers['service-worker-allowed'];
    if (typeof headers.location === 'string') {
      let location;
      try { location = new URL(headers.location, `http://${host}/`); } catch { /* Invalid upstream redirect. */ }
      headers.location = location?.host === host && location.protocol === 'http:' ? `${mount}${location.pathname}${location.search}${location.hash}` : undefined;
      if (!headers.location) delete headers.location;
    }
    if (String(headers['content-type']).startsWith('text/html')) {
      const directives = String(headers['content-security-policy'] ?? "default-src 'none'").split(';').filter(rule => !/^\s*(?:frame-ancestors|base-uri)\b/i.test(rule)).map(rule => /^\s*connect-src\s.*ws:\/\/127\.0\.0\.1:\d+/.test(rule)
        ? rule.replace(/ws:\/\/127\.0\.0\.1:\d+/, origin.replace(/^http/, 'ws')) : rule);
      const webview = webviewPort ? `http://*.localhost:${webviewPort}` : 'https://*.vscode-cdn.net';
      directives.push(`frame-ancestors 'self' ${ancestor} ${webview}`, "base-uri 'none'");
      headers['content-security-policy'] = directives.join('; ');
      if (!headers['permissions-policy']) headers['permissions-policy'] = 'camera=(), geolocation=()';
    }
  } else {
    const policy = headers['content-security-policy'];
    // Source builds initialize the browser extension host in this same-origin iframe.
    const ancestors = String(headers['content-type']).startsWith('text/html') && webWorkerHostFrame.test(new URL(path, origin).pathname) ? 'self' : 'none';
    headers['content-security-policy'] = `${policy ? `${policy}; ` : ''}frame-ancestors '${ancestors}'`;
    if (origin.startsWith('https:')) headers['strict-transport-security'] = 'max-age=86400';
  }
  return headers;
}

export function relay(req, res, target, track) {
  const upstream = request({ hostname: '127.0.0.1', port: target.port, path: target.path,
    method: req.method, headers: relayHeaders(req, target), agent: target.agent ?? false }, incoming => {
    if (res.destroyed) { incoming.destroy(); return; }
    res.writeHead(incoming.statusCode ?? 502, responseHeaders(incoming, target));
    incoming.on('error', () => res.destroy());
    incoming.pipe(res);
  });
  const release = track(() => { res.destroy(); upstream.destroy(); });
  res.once('finish', release);
  res.once('close', () => {
    if (res.writableFinished) return;
    release();
    upstream.destroy();
  });
  upstream.on('error', () => {
    if (res.headersSent) res.destroy();
    else if (!res.destroyed) { res.writeHead(502, { 'Cache-Control': 'no-store' }); res.end(); }
  });
  req.pipe(upstream);
}

export function relayUpgrade(req, socket, head, target, track) {
  const upstream = request({ hostname: '127.0.0.1', port: target.port, path: target.path,
    method: 'GET', headers: relayHeaders(req, { ...target, upgrade: true }), agent: false });
  const release = track(() => { upstream.destroy(); socket.destroy(); });
  socket.on('error', () => socket.destroy());
  socket.once('close', () => { release(); upstream.destroy(); });
  upstream.once('response', res => { res.destroy(); socket.destroy(); });
  upstream.once('error', () => socket.destroy());
  upstream.once('upgrade', (res, peer, peerHead) => {
    if (socket.destroyed) { peer.destroy(); return; }
    const headers = res.rawHeaders.flatMap((name, i, raw) => i % 2 === 0 && /^(connection|upgrade|sec-websocket-accept|sec-websocket-extensions|sec-websocket-protocol)$/i.test(name) ? [`${name}: ${raw[i + 1]}`] : []);
    socket.write(['HTTP/1.1 101 Switching Protocols', ...headers, '\r\n'].join('\r\n'));
    if (head.length) peer.write(head);
    if (peerHead.length) socket.write(peerHead);
    peer.on('error', () => socket.destroy());
    peer.once('close', () => socket.destroy());
    socket.once('close', () => peer.destroy());
    peer.pipe(socket); socket.pipe(peer);
  });
  upstream.end();
}
