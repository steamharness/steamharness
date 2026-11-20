import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { copyFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { register } from 'tsx/esm/api';
import { pathToFileURL } from 'node:url';
import { ROOT } from '../scripts/distribution.mjs';
import { pinnedKernel } from './helpers/pinned-kernel.mjs';
register();

const app = 'src/vs/code/electron-main/app.ts';
const policyFile = 'src/vs/code/electron-main/studioWebAppMicrophone.ts';

test('the original microphone patch installs both native permission handlers', async t => {
  const { upstream } = await pinnedKernel(t, [app]);
  // Actual pre-0080 imports and permission handlers from c39858b1b78. A depth-one checkout has no parent blobs.
  await copyFile(path.join(ROOT, 'tests/fixtures/web-app-microphone-app-base.txt'), path.join(upstream, app));
  execFileSync('git', ['apply', path.join(ROOT, 'patches/0080-studio-web-app-microphone.patch')], { cwd: upstream });
  for (const tree of [upstream, path.join(ROOT, 'upstream/vscode')]) {
    const contents = await readFile(path.join(tree, app), 'utf8');
    assert.match(contents, /webAppMicrophone\.request\(webContents, details,/);
    assert.match(contents, /webAppMicrophone\.check\(webContents, details\)/);
  }
});

test('the pinned microphone policy requires consent for a live audio-only application frame', async t => {
  const { upstream } = await pinnedKernel(t, [policyFile]);
  const { StudioWebAppMicrophone } = await import(pathToFileURL(path.join(upstream, policyFile)).href);
  const main = { url: 'vscode-file://vscode-app/index.html', parent: null, framesInSubtree: [] };
  const webview = { url: 'vscode-webview://trusted/index.html', parent: main, framesInSubtree: [] };
  const frame = { url: 'http://127.0.0.1:34567/' + 'a'.repeat(32) + '/index.html', parent: webview, framesInSubtree: [] };
  main.framesInSubtree = [main, webview, frame];
  const contents = { mainFrame: main, isDestroyed: () => false }, policy = new StudioWebAppMicrophone();
  const audio = { requestingUrl: frame.url, mediaTypes: ['audio'], mediaType: 'audio' };
  assert.equal(policy.check(contents, audio), false);
  assert.equal(await policy.request(contents, audio, async () => false), false);
  assert.equal(await policy.request(contents, { ...audio, mediaTypes: ['audio', 'video'] }, async () => { throw Error('camera must not prompt'); }), false);
  assert.equal(await policy.request(contents, audio, async () => true), true);
  assert.equal(policy.check(contents, audio), true);
  assert.equal(policy.check(contents, { ...audio, mediaType: 'video' }), false);
  frame.url = frame.url.replace('a'.repeat(32), 'b'.repeat(32));
  assert.equal(policy.check(contents, { ...audio, requestingUrl: frame.url }), false);
  frame.parent = main;
  assert.equal(await policy.request(contents, { ...audio, requestingUrl: frame.url }, async () => { throw Error('untrusted frame must not prompt'); }), false);
});

test('navigation while consent is pending cannot authorize the next account frame', async t => {
  const { upstream } = await pinnedKernel(t, [policyFile]);
  const { StudioWebAppMicrophone } = await import(pathToFileURL(path.join(upstream, policyFile)).href);
  const main = { url: 'vscode-file://vscode-app/index.html', parent: null, framesInSubtree: [] };
  const webview = { url: 'vscode-webview://trusted/index.html', parent: main, framesInSubtree: [] };
  const frame = { url: 'http://127.0.0.1:34567/' + 'a'.repeat(32) + '/index.html', parent: webview, framesInSubtree: [] };
  main.framesInSubtree = [main, webview, frame];
  const policy = new StudioWebAppMicrophone(), details = { requestingUrl: frame.url, mediaTypes: ['audio'] };
  let complete;
  const pending = policy.request({ mainFrame: main, isDestroyed: () => false }, details, () => new Promise(resolve => { complete = resolve; }));
  frame.url = 'about:blank'; complete(true); assert.equal(await pending, false);
});
