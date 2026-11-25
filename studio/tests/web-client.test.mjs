import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { prepareWebClient, retargetSocket } from '../scripts/web/client.mjs';

test('the socket override is limited to the configured HTTPS workbench', () => {
  const socket = 'const socket = this._webSocketFactory.create(`${webSocketSchema}://${host}:${port}${path}?${query}&skipWebSocketFrames=false`, debugLabel);';
  const transport = { origin: 'https://studio.example.test', websocketPort: 7302 };
  const patched = retargetSocket(socket, transport);
  assert.equal(retargetSocket(patched, transport), patched);
  assert.throws(() => retargetSocket(patched, { ...transport, websocketPort: 7403 }), /different Workbench relay/);
  assert.throws(() => retargetSocket(socket, { ...transport, origin: 'http://studio.example.test' }));
  const matches = new Function('webSocketSchema', 'mainWindow', 'host', 'port', 'path',
    patched.slice(0, patched.indexOf('const socket')) + 'return studioSocketPort;');
  const host = new URL(transport.origin).hostname;
  const window = { location: { hostname: host } };
  assert.deepEqual([matches('wss', window, host, 443, '/oss-dev'), matches('wss', window, 'other.example.test', 443, '/oss-dev'),
    matches('ws', window, host, 443, '/oss-dev'), matches('wss', window, host, 443, '/other')], [7302, 443, 443, 443]);
});

test('builds a versioned client with precompressed reads and reuses the prepared generation', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'studio-web-client-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const main = 'vs/code/browser/workbench';
  const state = '.build/build-fast/state.json';
  const files = {
    [`src/${main}/workbench-dev.html`]: '<!doctype html><html><head><style>animation: vscode-startup-fallback-reveal 0s linear 10s forwards;</style></head>' +
      '<body><div id="vscode-startup-fallback"><h1>The editor failed to load</h1></div></body>' +
      `<script type="module" src="{{WORKBENCH_WEB_BASE_URL}}/out/${main}/workbench.js"></script></html>`,
    [`out/${main}/workbench.js`]: 'import "./view.css"; globalThis.example = "first";',
    [`out/${main}/view.css`]: '.view{background:url("./image.svg")}',
    [`out/${main}/image.svg`]: '<svg xmlns="http://www.w3.org/2000/svg"/>',
    [state]: '{"head":"first"}',
  };
  const put = async (name, text) => {
    const file = path.join(directory, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
  };
  await Promise.all(Object.entries(files).map(([name, text]) => put(name, text)));
  const cache = path.join(directory, 'profile/client');
  const first = await prepareWebClient(directory, cache);
  assert.deepEqual(await prepareWebClient(directory, cache), first);
  const [js] = [...first.assets].filter(([key]) => key.endsWith('.js'));
  const [css] = [...first.assets].filter(([key]) => key.endsWith('.css'));
  assert.match(js[0], /^workbench\.studio-web-[a-f0-9]{32}\.js$/u);
  assert.match(css[0], /^workbench\.studio-web-[a-f0-9]{32}\.css$/u);
  assert.equal([...first.assets.keys()].filter(name => name.startsWith('studio-web-assets/')).length, 1);
  const html = await readFile(first.template, 'utf8');
  assert.ok(html.includes(`/workbench/${js[0]}`) && html.includes(`/workbench/${css[0]}`));
  assert.match(html, /modulepreload/);
  assert.match(html, /Loading the workbench/);
  assert.doesNotMatch(html, /The editor failed to load|10s forwards/);
  for (const [, asset] of [js, css]) {
    const plain = await readFile(asset.variants.identity.file);
    assert.deepEqual(brotliDecompressSync(await readFile(asset.variants.br.file)), plain);
    assert.deepEqual(gunzipSync(await readFile(asset.variants.gzip.file)), plain);
  }
  await put(`out/${main}/workbench.js`, 'import "./view.css"; globalThis.example = "second";');
  await put(state, '{"head":"second"}');
  const second = await prepareWebClient(directory, cache);
  assert.ok(!second.assets.has(js[0]), 'Changed code must have a new URL');
  assert.ok(second.assets.has(css[0]), 'Unchanged CSS uses the same URL');
});
