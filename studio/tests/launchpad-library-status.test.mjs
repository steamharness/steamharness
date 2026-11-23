import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const kernel = new URL('../upstream/vscode/src/vs/workbench/electron-browser/', import.meta.url);
const { outputFiles } = await build({ entryPoints: [fileURLToPath(new URL('studioLaunchpadLibrary.ts', kernel))],
  bundle: true, platform: 'browser', format: 'iife', globalName: 'studio', loader: { '.css': 'empty' }, write: false });

function fixture(t, language = 'en') {
  const { window } = new JSDOM('', { runScripts: 'outside-only' });
  t.after(() => window.close());
  const { LaunchpadLibrary } = window.eval(`${outputFiles[0].text}\nstudio;`);
  const project = (name, extra) => ({ uri: `file:///${name}`, kind: 'folder', path: `/${name}`, name, ...extra });
  let read = async () => [];
  const library = new LaunchpadLibrary((en, zh) => language === 'zh-cn' ? zh : en, { readActivity: projects => read(projects) });
  window.document.body.append(library.element);
  const row = p => library.element.querySelector(`.lp-index-row[data-key="index:${p.uri}"]`);
  const status = p => [...row(p).querySelectorAll('.lp-index-dot')].map(dot => dot.title);
  return { library, project, row, status, window, reader: impl => { read = impl; } };
}

for (const language of ['en', 'zh-cn']) {
  test(`repository statuses are independent and live updates do not rebuild the rows (${language})`, async t => {
    const f = fixture(t, language);
    const bot = f.project('bot', { windowId: 12, projectId: 'bot-id', projectType: 'bot' });
    const idle = f.project('idle');
    const off = f.project('offline', { managed: true, projectType: 'bot' });
    const zh = language === 'zh-cn';
    const open = zh ? '已打开' : 'Open', linked = zh ? 'Bot 已加入对话' : 'Bot linked to chat', running = zh ? '任务正在运行' : 'Task running';
    const category = { label: 'Bot', emptyLabel: '', projectUris: [bot.uri, off.uri] };
    f.library.update([bot, idle, off], [], true, 'account', category);
    assert.deepEqual(f.status(bot), [open, linked]);
    assert.deepEqual(f.status(off), [linked]);
    assert.deepEqual(f.status(idle), []);
    f.library.show(bot.uri);
    const row = f.row(bot), detail = f.library.element.querySelector('.lp-project-details');
    row.focus();
    f.reader(async projects => {
      assert.deepEqual(Array.from(projects, p => p.uri), [bot.uri, off.uri]);
      return [bot.uri, off.uri];
    });
    await f.library.refreshActivity();
    assert.deepEqual(f.status(bot), [running, linked]);
    assert.deepEqual(f.status(off), [running, linked], 'an IM run is active without a native window');
    assert.equal(row.querySelector('.lp-index-dot-open'), null);
    assert.equal(row.getAttribute('aria-description'), `${running} · ${linked}`);
    assert.equal(f.row(bot), row);
    assert.equal(f.window.document.activeElement, row);
    assert.equal(f.library.element.querySelector('.lp-project-details'), detail);
    f.reader(async () => []);
    await f.library.refreshActivity();
    assert.deepEqual(f.status(bot), [open, linked]);
    assert.deepEqual(f.status(off), [linked]);
    f.library.update([bot, idle, off], [], true, '');
    assert.deepEqual(f.status(bot), [open]);
    assert.deepEqual(f.status(off), []);
  });
}

test('do not show a delayed running snapshot after the project identity changes', async t => {
  const f = fixture(t), bot = f.project('bot', { projectId: 'previous', windowId: 1 });
  f.library.update([bot], [], true, '');
  const pending = Promise.withResolvers();
  let reads = 0;
  f.reader(() => { reads++; return pending.promise; });
  const first = f.library.refreshActivity();
  await f.library.refreshActivity();
  assert.equal(reads, 1, 'status reads cannot overlap');
  f.library.update([{ ...bot, projectId: 'replacement' }], [], true, '');
  pending.resolve([bot.uri]);
  await first;
  assert.deepEqual(f.status(bot), ['Open']);
});
