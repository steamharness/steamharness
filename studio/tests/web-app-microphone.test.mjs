import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { register } from 'tsx/esm/api';
import { pathToFileURL } from 'node:url';
import { ROOT } from '../scripts/distribution.mjs';
import { pinnedKernel } from './helpers/pinned-kernel.mjs';
register();

test('the replayable microphone patch requires consent for a live audio-only application frame', async t => {
  const { upstream } = await pinnedKernel(t, ['src/vs/code/electron-main/app.ts']);
  execFileSync('git', ['apply', path.join(ROOT, 'patches/0080-studio-web-app-microphone.patch')], { cwd: upstream });
  const source = 'src/vs/code/electron-main/studioWebAppMicrophone.ts';
  const { StudioWebAppMicrophone } = await import(pathToFileURL(path.join(upstream, source)).href);
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
  const { upstream } = await pinnedKernel(t, ['src/vs/code/electron-main/app.ts']);
  execFileSync('git', ['apply', path.join(ROOT, 'patches/0080-studio-web-app-microphone.patch')], { cwd: upstream });
  const { StudioWebAppMicrophone } = await import(pathToFileURL(path.join(upstream, 'src/vs/code/electron-main/studioWebAppMicrophone.ts')).href);
  const main = { url: 'vscode-file://vscode-app/index.html', parent: null, framesInSubtree: [] };
  const webview = { url: 'vscode-webview://trusted/index.html', parent: main, framesInSubtree: [] };
  const frame = { url: 'http://127.0.0.1:34567/' + 'a'.repeat(32) + '/index.html', parent: webview, framesInSubtree: [] };
  main.framesInSubtree = [main, webview, frame];
  const policy = new StudioWebAppMicrophone(), details = { requestingUrl: frame.url, mediaTypes: ['audio'] };
  let complete;
  const pending = policy.request({ mainFrame: main, isDestroyed: () => false }, details, () => new Promise(resolve => { complete = resolve; }));
  frame.url = 'about:blank'; complete(true); assert.equal(await pending, false);
});
