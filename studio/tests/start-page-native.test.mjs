import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { ROOT, applyPatches } from '../scripts/distribution.mjs';
import { pinnedKernel } from './helpers/pinned-kernel.mjs';
import { kernelLock } from './helpers/kernel-lock.mjs';

const file = 'src/vs/workbench/browser/parts/editor/studioStart.ts';
const css = 'src/vs/workbench/browser/parts/editor/media/studioStart.css';
const overviewPatch = '0088-studio-project-overview.patch';
const source = await readFile(path.join(ROOT, 'upstream/vscode', file), 'utf8');
const compiled = await build({ entryPoints: [path.join(ROOT, 'upstream/vscode', file)], bundle: true, platform: 'browser', format: 'iife',
  globalName: 'studioStart', loader: { '.css': 'empty' }, write: false });

for (const language of ['en', 'zh-cn']) test(`native overview renders only current projects and opens every available entry in ${language}`, async t => {
  const bundle = JSON.parse(await readFile(path.join(ROOT, `extensions/studio-workstation/l10n/bundle.l10n${language === 'en' ? '' : '.zh-cn'}.json`), 'utf8'));
  const labels = Object.fromEntries(Object.entries({ overview: 'Project Overview', entries: 'Project Entries', defaultEntry: 'Default Entry',
    openEntry: 'Open Entry', source: 'Open Project Source', localVersion: 'Local Version', projectFolder: 'Project Folder',
    noWorkspace: 'No project is open.', noCurrent: 'No SteamHarness projects in this workspace.', retry: 'Retry Project Setup', installationLog: 'Show Installation Log',
    unavailable: 'Unavailable', details: 'Details', installFailed: 'Dependency installation failed', validationFailed: 'Project validation failed',
    registrationFailed: 'Server registration needs attention', registering: 'Registering Project', 'type.aggregate': 'Aggregate Project',
    'type.bot': 'Bot', 'type.workflow': 'Workflow', 'type.kanban': 'Kanban' }).map(([key, message]) => [key, bundle[message]]));
  const dom = new JSDOM('<div id="host"></div>', { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const { window } = dom, { document } = window;
  window.IntersectionObserver = class { observe() {} disconnect() {} };
  const { StudioStartView } = window.eval(`${compiled.outputFiles[0].text}\nstudioStart;`);
  const calls = [], service = { state: undefined, onDidChange: callback => { service.change = callback; return { dispose() {} }; }, setVisible() {} };
  const view = new StudioStartView(document.getElementById('host'), service, { executeCommand: async (...args) => calls.push(JSON.parse(JSON.stringify(args))) });
  const { element } = view;
  assert.equal(element.getAttribute('aria-busy'), 'true');
  assert.equal(element.querySelectorAll('button').length, 0);
  const uri = 'file:///aggregate', avatarUrl = 'data:image/svg+xml,%3Csvg%2F%3E';
  const state = { labels, hasWorkspace: true, pending: [], recent: [{ label: 'Recent record' }], recommendations: { title: 'Store recommendation' },
    projects: [{ uri, name: 'Aggregate', description: '<script>Plain text</script>', folderPath: '/aggregate', projectType: 'aggregate', version: '1.2.3', avatarUrl,
      defaultEntry: 'database', entries: [
        { entryId: 'agent', name: 'Agent', projectType: 'bot', avatarUrl, available: true },
        { entryId: 'database', name: 'Database', projectType: 'workflow', available: true },
        { entryId: 'board', name: 'Board', projectType: 'kanban', avatarUrl: 'https://example.invalid/external.svg', available: false },
      ] }] };
  service.state = state; service.change();
  assert.equal(element.getAttribute('aria-busy'), 'false');
  assert.equal(element.querySelector('h1').textContent, labels.overview);
  assert.equal(element.querySelector('h2').textContent, 'Aggregate');
  assert.equal(element.querySelector('h3').textContent, labels.entries);
  assert.equal(element.querySelector('.studio-start-project-path').textContent, '/aggregate');
  assert.equal(element.querySelector('.studio-start-project-description').textContent, state.projects[0].description);
  assert.equal(element.querySelector('script'), null);
  assert.ok(!element.textContent.includes('Recent record') && !element.textContent.includes('Store recommendation'));
  const rows = [...element.querySelectorAll('.studio-start-entry')];
  assert.deepEqual(rows.map(row => [row.dataset.entryId, row.querySelector('.studio-start-entry-default')?.textContent, !!row.querySelector('button')]),
    [['agent', undefined, true], ['database', labels.defaultEntry, true], ['board', undefined, false]]);
  assert.equal(rows[2].querySelector('img'), null);
  assert.equal(rows[1].querySelector('button').getAttribute('aria-label'), `${labels.openEntry}: Database`);
  for (const button of element.querySelectorAll('button')) { button.click(); }
  assert.deepEqual(calls, [['studio.openProjectSource', { uri, entryId: 'database' }],
    ['studio.openProject', { uri, entryId: 'agent' }], ['studio.openProject', { uri, entryId: 'database' }]]);
  const focused = rows[1].querySelector('button'); focused.focus();
  state.recent = []; state.recommendations = undefined; state.busy = true; service.change();
  assert.equal(document.activeElement, focused, 'Launchpad state must not replace or refocus current entries');
  state.projects = []; service.change();
  assert.equal(element.querySelector('.studio-start-empty p').textContent, labels.noCurrent);
  state.hasWorkspace = false; service.change();
  assert.equal(element.querySelector('.studio-start-empty p').textContent, labels.noWorkspace);
  assert.equal(element.querySelectorAll('button').length, 0);

  state.hasWorkspace = true; state.busy = false;
  state.pending = ['dependencies', 'validation', 'registration'].map(stage => ({ id: stage, name: 'Aggregate', stage, status: 'failed', error: '<specific error>' }));
  service.change();
  const statusLines = () => [...element.querySelectorAll('.studio-start-setup-status')].map(node => node.lastElementChild.textContent);
  assert.deepEqual(statusLines(), [labels.installFailed, labels.validationFailed, labels.registrationFailed].map(label => `Aggregate · ${label}`));
  const details = element.querySelector('details'); details.open = true;
  assert.equal(details.querySelector('pre').textContent, '<specific error>');
  service.change(); assert.equal(element.querySelector('details'), details); assert.equal(details.open, true);
  const log = [...element.querySelectorAll('[data-action="studio.showProjectSetupLog"]')].at(-1); log.click();
  assert.deepEqual(calls.at(-1), ['studio.showProjectSetupLog', 'registration']);
  state.installing = 'registration'; service.change();
  assert.equal(statusLines().at(-1), `Aggregate · ${labels.registering}`);
  assert.equal(element.querySelectorAll('details').length, 2);
  view.dispose();
});

for (const [patchNames, files] of [
  [[overviewPatch], [file, css, 'src/vs/workbench/contrib/studioStart/browser/studioStart.contribution.ts', 'src/vs/workbench/contrib/studioStart/browser/studioProjectCreateDialog.ts']],
  [['0070-studio-start-partial-status.patch'], [file]],
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
  // Replay later refinements too, restricted to this fixture's files.
  const sequence = patchNames.includes(overviewPatch) ? patchNames : patchNames.includes('0067-studio-start-recent-projects.patch')
    ? [...patchNames, '0076-studio-release-startup.patch', '0078-studio-start-recommendations.patch', '0083-studio-explicit-platform-tools.patch', overviewPatch]
    : [...patchNames, '0083-studio-explicit-platform-tools.patch', overviewPatch];
  for (const patchName of sequence) {
    const patch = await readFile(path.join(ROOT, 'patches', patchName), 'utf8');
    const relevant = patch.split(/(?=^diff --git )/m).filter(part => files.some(name => part.startsWith(`diff --git a/${name} b/${name}\n`))).join('');
    if (relevant) await writeFile(path.join(directory, 'patches', patchName), relevant);
  }
  const git = args => execFileSync('git', args, { cwd: kernel, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init', '-q']);
  for (const patchName of (await readdir(path.join(directory, 'patches'))).sort().reverse()) { git(['apply', '--reverse', path.join(directory, 'patches', patchName)]); }
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
  const lock = await kernelLock();
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
