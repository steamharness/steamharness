import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
import { ROOT, applyPatches } from '../scripts/distribution.mjs';
import { pinnedKernel } from './helpers/pinned-kernel.mjs';

const file = 'src/vs/workbench/browser/parts/editor/studioStart.ts';
const css = 'src/vs/workbench/browser/parts/editor/media/studioStart.css';
const source = await readFile(path.join(ROOT, 'upstream/vscode', file), 'utf8');
const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
const view = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'StudioStartView');
const methods = view.members.filter(node => ts.isMethodDeclaration(node) && ['render', 'list'].includes(node.name.getText(ast)));
const javascript = ts.transpileModule(`class StartView { ${methods.map(node => node.getText(ast)).join('\n')} }`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

for (const language of ['en', 'zh-cn']) test(`native Start distinguishes installation, validation and registration failures in ${language}`, async t => {
  const bundle = JSON.parse(await readFile(path.join(ROOT, `extensions/studio-workstation/l10n/bundle.l10n${language === 'en' ? '' : '.zh-cn'}.json`), 'utf8'));
  const dom = new JSDOM('<main></main>'); t.after(() => dom.window.close());
  const { document } = dom.window;
  const $ = (selector, attributes, text) => {
    const [tag, ...classes] = selector.split('.'), element = document.createElement(tag || 'div');
    element.className = classes.join(' ');
    for (const [name, value] of Object.entries(attributes ?? {})) { element.setAttribute(name, value); }
    if (text !== undefined) { element.textContent = text; }
    return element;
  };
  const module = { exports: {} };
  runInNewContext(`${javascript}\nmodule.exports = StartView;`, { module, $, append: (parent, child) => parent.appendChild(child), clearNode: node => node.replaceChildren() });
  const instance = new module.exports();
  instance.element = document.querySelector('main'); instance.badge = document.createElement('span');
  instance.labels = new Map(); instance.actions = []; instance.error = document.createElement('div');
  instance.stats = new Map([['harness', document.createElement('span')]]);
  instance.lists = new Map(['current', 'recent'].map(key => [key, { element: document.createElement('div'), key: '', disposables: { clear() {} } }]));
  instance.button = (parent, label) => parent.appendChild($('button', undefined, label));
  const labels = Object.fromEntries(Object.entries({ installFailed: 'Dependency installation failed', validationFailed: 'Project validation failed',
    registrationFailed: 'Server registration needs attention', cancelled: 'Project setup cancelled', registering: 'Registering Project', details: 'Details' })
    .map(([key, message]) => [key, bundle[message]]));
  instance.service = { state: { labels, projects: [], recent: [], pending: ['dependencies', 'validation', 'registration'].map(stage => ({ id: stage, name: stage, stage, status: 'failed', error: '<specific error>' })),
    environment: { harness: '0.1.1' }, canCreate: true, busy: false } };
  instance.render();
  const current = instance.lists.get('current').element;
  assert.deepEqual([...current.querySelectorAll('small')].map(node => node.textContent), [labels.installFailed, labels.validationFailed, labels.registrationFailed]);
  assert.equal(instance.stats.get('harness').textContent, '0.1.1');
  const details = current.querySelector('details'); details.open = true;
  assert.equal(details.querySelector('pre').textContent, '<specific error>'); assert.equal(details.querySelector('specific'), null);
  instance.render(); assert.equal(current.querySelector('details'), details); assert.equal(details.open, true);
  instance.service.state.installing = 'registration'; instance.render();
  assert.equal([...current.querySelectorAll('small')].at(-1).textContent, labels.registering);
  assert.equal(current.querySelectorAll('details').length, 2);
});

test('the setup patch replays twice and preserves the index', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'studio-setup-patch-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const kernel = path.join(directory, 'vscode');
  for (const name of [file, css]) {
    await mkdir(path.dirname(path.join(kernel, name)), { recursive: true });
    await copyFile(path.join(ROOT, 'upstream/vscode', name), path.join(kernel, name));
  }
  await mkdir(path.join(directory, 'patches'));
  const patch = path.join(directory, 'patches/0061-studio-project-setup-stages.patch');
  await copyFile(path.join(ROOT, 'patches/0061-studio-project-setup-stages.patch'), patch);
  const git = args => execFileSync('git', args, { cwd: kernel, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init', '-q']); git(['apply', '--reverse', patch]); git(['add', '.']);
  git(['-c', 'user.name=Studio Test', '-c', 'user.email=studio@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture']);
  const index = git(['write-tree']);
  for (let attempt = 0; attempt < 2; attempt++) {
    await applyPatches(directory, kernel);
    for (const name of [file, css]) { assert.equal(await readFile(path.join(kernel, name), 'utf8'), await readFile(path.join(ROOT, 'upstream/vscode', name), 'utf8')); }
    assert.equal(git(['write-tree']), index);
  }
});

test('the complete patch series applies to the pinned kernel and preserves local edits', async t => {
  const files = new Set();
  for (const name of await readdir(path.join(ROOT, 'patches'))) {
    const patch = await readFile(path.join(ROOT, 'patches', name), 'utf8');
    for (const match of patch.matchAll(/^\+\+\+ b\/(.+)$/gm)) { files.add(match[1]); }
  }
  const lock = JSON.parse(await readFile(path.join(ROOT, 'config/upstream.json'), 'utf8'));
  const tracked = execFileSync('git', ['ls-tree', '-r', '--name-only', lock.commit, '--', ...files], { cwd: path.join(ROOT, lock.path), encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  const { upstream } = await pinnedKernel(t, tracked);
  const git = args => execFileSync('git', args, { cwd: upstream, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const index = git(['write-tree']);
  await applyPatches(ROOT, upstream);
  await writeFile(path.join(upstream, 'local-notes.txt'), 'preserve me');
  await applyPatches(ROOT, upstream);
  assert.equal(await readFile(path.join(upstream, 'local-notes.txt'), 'utf8'), 'preserve me');
  assert.equal(await readFile(path.join(upstream, file), 'utf8'), source);
  assert.equal(git(['write-tree']), index);
});
