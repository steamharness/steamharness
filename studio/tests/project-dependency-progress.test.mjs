import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const compiled = await build({ stdin: { contents: `
export { ProjectDependencyProgress } from './extensions/studio-workstation/src/project-dependency-progress';
export { configureLocalization } from './extensions/studio-workstation/src/localization';
`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], write: false });
const zh = JSON.parse(await readFile(new URL('../extensions/studio-workstation/l10n/bundle.l10n.zh-cn.json', import.meta.url), 'utf8'));
const require = createRequire(import.meta.url);

class Emitter {
  listeners = new Set();
  event = listener => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
  fire(value) { for (const listener of this.listeners) listener(value); }
}

function fixture(t, language = 'en') {
  let status;
  const commands = new Map(), panels = [];
  const vscode = {
    env: { language }, StatusBarAlignment: { Left: 1 }, ViewColumn: { Active: -1 },
    commands: { registerCommand: (name, run) => { commands.set(name, run); return { dispose: () => commands.delete(name) }; } },
    window: {
      createStatusBarItem: id => status = { id, show() {}, dispose() {} },
      createWebviewPanel: (type, title, column, options) => {
        const disposed = new Emitter(), state = new Emitter(), received = new Emitter();
        const panel = { type, title, column, options, visible: true, messages: [], reveals: 0, receive: message => received.fire(message),
          onDidDispose: disposed.event, onDidChangeViewState: state.event,
          setVisible(visible) { this.visible = visible; state.fire(); },
          reveal() { this.reveals++; this.setVisible(true); },
          dispose() { this.visible = false; disposed.fire(); this.page?.close(); },
          webview: { onDidReceiveMessage: received.event, postMessage: message => {
            panel.messages.push(message);
            if (panel.page) panel.page.dispatchEvent(new panel.page.MessageEvent('message', { data: message }));
            return Promise.resolve(true);
          } },
        };
        panels.push(panel);
        return panel;
      },
    },
  };
  const module = { exports: {} };
  runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports, require: name => name === 'vscode' ? vscode : require(name),
    AbortController, AbortSignal, Error, crypto: globalThis.crypto, setTimeout, clearTimeout });
  module.exports.configureLocalization(language === 'zh-cn' ? zh : {}, language);
  const progress = new module.exports.ProjectDependencyProgress();
  t.after(() => progress.dispose());
  return { progress, panels, status: () => status, options: { title: 'Install <demo>', directory: '/projects/demo', signal: new AbortController().signal },
    async open() {
      commands.get(status.command)();
      const panel = panels.at(-1);
      if (!panel.page) {
        panel.page = new JSDOM(panel.webview.html, { runScripts: 'dangerously', beforeParse(window) {
          window.acquireVsCodeApi = () => ({ postMessage: message => queueMicrotask(() => panel.receive(message)) });
        } }).window;
      }
      await Promise.resolve();
      return panel;
    },
  };
}

for (const [locale, title, running, completed, logTitle] of [
  ['en', 'Dependency Details', 'Dependencies in progress', 'Dependencies completed', 'Installation Log'],
  ['zh-cn', '依赖处理详情', '正在处理依赖', '依赖处理完成', '安装日志'],
]) test(`${locale}: a closed details tab reopens the same live log and remains available after completion`, async t => {
  const f = fixture(t, locale), exit = Promise.withResolvers();
  let update;
  assert.equal(f.status(), undefined);
  const runningTask = f.progress.run(f.options, async task => { update = task; task.append('installing\n'); return exit.promise; });
  assert.equal(f.panels.length, 0);
  assert.equal(f.status().text, `$(loading~spin) ${running}`);
  const panel = await f.open();
  assert.equal(panel.title, title);
  const doc = panel.page.document;
  assert.equal(doc.documentElement.lang, locale);
  assert.equal(doc.querySelector('#log-title').textContent, logTitle);
  assert.equal(doc.querySelector('#progress').hidden, false);
  assert.equal(doc.querySelector('#log').textContent, 'installing\n');
  assert.equal(doc.querySelector('#title').textContent, f.options.title);
  for (let i = 0; i < 10; i++) update.append('line\n');
  await delay(170);
  assert.equal(panel.messages.length, 2); // One refresh for a burst of log chunks.
  assert.equal(await f.open(), panel);
  assert.equal(panel.reveals, 1);
  panel.dispose();

  const raw = '<img src="fake">\n';
  update.append(raw);
  assert.equal(update.signal.aborted, false);
  const reopened = await f.open();
  assert.notEqual(reopened, panel);
  assert.equal(reopened.messages[0].id, panel.messages[0].id);
  assert.equal(reopened.page.document.querySelector('#log').textContent, `installing\n${'line\n'.repeat(10)}${raw}`);
  assert.equal(reopened.page.document.querySelector('img'), null);
  reopened.setVisible(false);
  const messageCount = reopened.messages.length;
  update.append('finished\n');
  exit.resolve(0);
  assert.equal(await runningTask, 0);
  await delay(170);
  assert.equal(reopened.messages.length, messageCount);
  assert.equal(f.status().text, `$(check) ${completed}`);
  reopened.dispose();
  const final = await f.open();
  assert.equal(final.messages[0].state, completed);
  assert.match(final.messages[0].log, /finished\n$/);
  assert.equal(final.page.document.querySelector('#progress').hidden, true);
});

test('cancel is explicit, remains pending until the task stops, and retry does not keep an obsolete action', async t => {
  const f = fixture(t), stopped = Promise.withResolvers();
  let signal, retryCalled = 0;
  const retry = () => f.progress.run({ ...f.options, retry }, async () => { retryCalled++; });
  const run = f.progress.run({ ...f.options, retry }, async progress => {
    signal = progress.signal;
    await stopped.promise;
    signal.throwIfAborted();
  });
  const panel = await f.open(), firstId = panel.messages[0].id;
  panel.page.document.querySelector('#cancel').click();
  await Promise.resolve();
  assert.equal(signal.aborted, true);
  assert.equal(panel.messages.at(-1).state, 'Cancelling...');
  assert.equal(panel.messages.at(-1).canCancel, false);
  stopped.resolve();
  await assert.rejects(run, { name: 'AbortError' });
  await delay(170);
  assert.equal(panel.messages.at(-1).state, 'Dependency operation cancelled');
  assert.equal(panel.page.document.querySelector('#retry').hidden, false);
  panel.page.document.querySelector('#retry').click();
  await delay(170);
  assert.equal(retryCalled, 1);
  assert.equal(panel.messages.at(-1).state, 'Dependencies completed');
  assert.notEqual(panel.messages.at(-1).id, firstId);
  panel.receive({ type: 'select', id: firstId });
  assert.equal(panel.page.document.querySelector('#retry').hidden, true);
});

test('active operations keep separate output and an error never looks like successful progress', async t => {
  const f = fixture(t), exit = Promise.withResolvers();
  const first = f.progress.run(f.options, async ({ append }) => { append('first project\n'); await exit.promise; });
  const panel = await f.open(), firstId = panel.messages[0].id;
  const second = f.progress.run({ ...f.options, title: 'Update demo', directory: '/projects/other', describeError: error => `Registry: ${error.message}` },
    async ({ append }) => { append(`${'x'.repeat(200_000)}last line\n`); throw new Error('offline'); });
  await assert.rejects(second, /offline/);
  await delay(170);
  const failed = panel.messages.at(-1);
  assert.deepEqual({ state: failed.state, message: failed.message, logSize: failed.log.length, active: failed.active, truncated: failed.truncated },
    { state: 'Dependency operation failed', message: 'Registry: offline', logSize: 200_000, active: false, truncated: true });
  assert.match(failed.log, /last line\n$/);
  assert.equal(f.status().text, '$(loading~spin) Dependencies in progress');
  const select = panel.page.document.querySelector('#operations');
  select.value = String(firstId);
  select.dispatchEvent(new panel.page.Event('change'));
  await Promise.resolve();
  assert.equal(panel.messages.at(-1).log, 'first project\n');
  exit.resolve();
  await first;
});
