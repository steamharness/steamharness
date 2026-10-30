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

for (const language of ['en', 'zh-cn']) test(`native Start preserves entry targets and distinguishes project setup failures in ${language}`, async t => {
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
  runInNewContext(`${javascript}\nmodule.exports = StartView;`, { module, $, studioProjectIcon: type => type,
    append: (parent, child) => parent.appendChild(child), clearNode: node => node.replaceChildren() });
  const instance = new module.exports();
  instance.element = document.querySelector('main'); instance.badge = document.createElement('span');
  instance.labels = new Map(); instance.actions = []; instance.error = document.createElement('div');
  instance.stats = new Map([['harness', document.createElement('span')]]);
  instance.lists = new Map(['current', 'recent'].map(key => [key, { element: document.createElement('div'), key: '', disposables: { clear() {} } }]));
  const calls = [];
  instance.button = (parent, label, _icon, command, target) => {
    const button = parent.appendChild($('button'));
    button.appendChild($('span.studio-start-action-label', undefined, label));
    button.addEventListener('click', () => calls.push([command, target]));
    return button;
  };
  const labels = Object.fromEntries(Object.entries({ installFailed: 'Dependency installation failed', validationFailed: 'Project validation failed',
    registrationFailed: 'Server registration needs attention', cancelled: 'Project setup cancelled', registering: 'Registering Project', details: 'Details', currentProject: 'Current Project' })
    .map(([key, message]) => [key, bundle[message]]));
  instance.service = { state: { labels, projects: [], recent: [], pending: ['dependencies', 'validation', 'registration'].map(stage => ({ id: stage, name: stage, stage, status: 'failed', error: '<specific error>' })),
    environment: { harness: '0.1.1' }, canCreate: true, busy: false } };
  instance.render();
  const current = instance.lists.get('current').element;
  instance.service.state.recent = [true, false].map((current, index) => ({ uri: `file:///project-${index}`, label: 'Same name', kind: 'folder', lastOpened: 1, current }));
  instance.render();
  const recent = instance.lists.get('recent').element;
  const recentRows = () => [...recent.querySelectorAll('.studio-start-project')].map(row => ({
    current: row.firstElementChild.getAttribute('aria-current'), badge: row.querySelector('.studio-start-recent-current')?.textContent }));
  assert.deepEqual(recentRows(), [{ current: 'true', badge: labels.currentProject }, { current: null, badge: undefined }]);
  instance.service.state.recent.forEach(project => { project.current = !project.current; }); instance.render();
  assert.deepEqual(recentRows(), [{ current: null, badge: undefined }, { current: 'true', badge: labels.currentProject }]);
  assert.deepEqual([...current.querySelectorAll('small')].map(node => node.textContent), [labels.installFailed, labels.validationFailed, labels.registrationFailed]);
  assert.equal(instance.stats.get('harness').textContent, '0.1.1');
  const details = current.querySelector('details'); details.open = true;
  assert.equal(details.querySelector('pre').textContent, '<specific error>'); assert.equal(details.querySelector('specific'), null);
  instance.render(); assert.equal(current.querySelector('details'), details); assert.equal(details.open, true);
  instance.service.state.installing = 'registration'; instance.render();
  assert.equal([...current.querySelectorAll('small')].at(-1).textContent, labels.registering);
  assert.equal(current.querySelectorAll('details').length, 2);
  const entries = [['agent', 'conversation'], ['database', 'workflow'], ['map-2d', 'kanban'], ['minimax', 'workflow'], ['tikhub', 'workflow']];
  instance.service.state.projects = entries.map(([entryId, projectType]) => ({ uri: 'file:///aggregate', entryId,
    name: `Aggregate / ${entryId}`, projectType, folderPath: '/aggregate' }));
  instance.service.state.pending = []; instance.render();
  const cards = [...current.querySelectorAll('.studio-start-project-card')];
  assert.deepEqual(cards.map(card => card.querySelector('h3').textContent), entries.map(([entryId]) => `Aggregate / ${entryId}`));
  for (const card of cards) { for (const button of card.querySelectorAll('button')) { button.click(); } }
  assert.deepEqual(calls.filter(([command]) => ['studio.openProject', 'studio.openProjectSource'].includes(command))
    .map(([command, target]) => [command, { ...target }]), entries.flatMap(([entryId]) =>
      ['studio.openProject', 'studio.openProject', 'studio.openProjectSource'].map(command => [command, { uri: 'file:///aggregate', entryId }])));
});

for (const [patchNames, files] of [
  [['0069-studio-editor-group-close.patch'], ['src/vs/workbench/browser/parts/editor/editor.contribution.ts', 'src/vs/workbench/browser/parts/editor/media/editorgroupview.css', 'src/vs/workbench/browser/parts/editor/media/multieditortabscontrol.css']],
  [['0061-studio-project-setup-stages.patch', '0065-studio-start-entry-targets.patch', '0067-studio-start-recent-projects.patch'], [file, css]],
  [['0065-studio-start-entry-targets.patch', '0067-studio-start-recent-projects.patch'], [file, css]],
  [['0067-studio-start-recent-projects.patch'], [file, css]],
]) test(`${patchNames.join(' + ')} replays twice and preserves the index`, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'studio-setup-patch-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const kernel = path.join(directory, 'vscode');
  for (const name of files) {
    await mkdir(path.dirname(path.join(kernel, name)), { recursive: true });
    await copyFile(path.join(ROOT, 'upstream/vscode', name), path.join(kernel, name));
  }
  await mkdir(path.join(directory, 'patches'));
  for (const patchName of patchNames) { await copyFile(path.join(ROOT, 'patches', patchName), path.join(directory, 'patches', patchName)); }
  const git = args => execFileSync('git', args, { cwd: kernel, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init', '-q']);
  for (const patchName of [...patchNames].reverse()) { git(['apply', '--reverse', path.join(directory, 'patches', patchName)]); }
  git(['add', '.']);
  git(['-c', 'user.name=Studio Test', '-c', 'user.email=studio@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture']);
  const index = git(['write-tree']);
  for (let attempt = 0; attempt < 2; attempt++) {
    await applyPatches(directory, kernel);
    for (const name of files) { assert.equal(await readFile(path.join(kernel, name), 'utf8'), await readFile(path.join(ROOT, 'upstream/vscode', name), 'utf8')); }
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
