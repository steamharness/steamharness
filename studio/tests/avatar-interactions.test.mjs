import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { JSDOM } from 'jsdom';
import path from 'node:path';
import { build } from 'esbuild';
import { ROOT, applyPatches } from '../scripts/distribution.mjs';
import { pinnedKernel } from './helpers/pinned-kernel.mjs';

const compiled = await build({ entryPoints: ['extensions/studio-workstation/webview/info.ts'], bundle: true, platform: 'browser', format: 'iife', loader: { '.css': 'empty' }, write: false });

test('project avatar patches apply repeatedly to the pinned kernel without changing the index', async t => {
  const files = ['src/vs/workbench/browser/actions/windowActions.ts', 'src/vs/workbench/browser/parts/editor/studioStart.ts', 'src/vs/workbench/browser/parts/editor/media/studioStart.css'];
  const { root: fixture, upstream: kernel } = await pinnedKernel(t, files);
  const git = args => execFileSync('git', args, { cwd: kernel, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const patches = ['0031-studio-project-avatars.patch', '0032-studio-avatar-actions.patch', '0033-studio-start-recent-avatar-spacing.patch'];
  for (const name of patches) {
    await copyFile(path.join(ROOT, 'patches', name), path.join(fixture, 'patches', name));
  }
  const index = git(['write-tree']);
  await applyPatches(fixture, kernel);
  const first = await Promise.all(files.map(file => readFile(path.join(kernel, file), 'utf8')));
  await applyPatches(fixture, kernel);
  assert.deepEqual(await Promise.all(files.map(file => readFile(path.join(kernel, file), 'utf8'))), first);
  assert.equal(git(['write-tree']), index);
  assert.match(first[1], /const avatar = this\.button\(heading,.*'studio\.openProject'/);
  assert.match(first[1], /avatar\.firstElementChild\?\.replaceWith/);
  assert.match(first[2], /\.studio-start-project-avatar-button/);
});

for (const language of ['en', 'zh-cn']) test(`information avatar opens and closes its local preview in ${language}`, async t => {
  const bundle = JSON.parse(await readFile(new URL(`../extensions/studio-workstation/l10n/bundle.l10n${language === 'en' ? '' : '.zh-cn'}.json`, import.meta.url), 'utf8'));
  const dom = new JSDOM('<main id="info-app"></main><div id="info-announcement"></div><script id="studio-localization" type="application/json"></script>', { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const { window } = dom, document = window.document, posted = [];
  document.querySelector('#studio-localization').textContent = JSON.stringify({ bundle, locale: language });
  window.acquireVsCodeApi = () => ({ getState: () => undefined, setState() {}, postMessage: message => posted.push(message) });
  window.scrollTo = () => {};
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  window.eval(compiled.outputFiles[0].text);
  const project = { uri: 'file:///example', name: 'Example <Project>', avatarUrl: 'data:image/svg+xml,%3Csvg%2F%3E' };
  const publish = () => window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'info-state', generation: 1, project, items: [] } }));
  publish();
  const avatar = document.querySelector('[data-action="avatar"]'), image = avatar.querySelector('img');
  assert.equal(avatar.tagName, 'BUTTON'); assert.equal(avatar.type, 'button');
  assert.equal(avatar.getAttribute('aria-label'), bundle['Project avatar']);
  assert.equal(avatar.getAttribute('aria-haspopup'), 'dialog');
  avatar.click(); const preview = document.querySelector('dialog');
  assert.equal(preview.open, true); assert.equal(preview.getAttribute('aria-label'), project.name);
  assert.equal(preview.querySelector('img').src, project.avatarUrl);
  preview.querySelector('[data-close-avatar]').click(); assert.equal(preview.open, false);
  publish(); assert.equal(document.querySelector('[data-action="avatar"] img'), image);
  assert.deepEqual(posted.map(message => message.type), ['ready']);
  project.avatarUrl = 'https://untrusted.example/image.svg'; publish();
  assert.equal(document.querySelector('[data-action="avatar"]'), null);
});
