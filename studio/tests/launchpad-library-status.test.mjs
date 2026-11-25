import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const kernel = new URL('../upstream/vscode/src/vs/workbench/browser/', import.meta.url);
const { outputFiles } = await build({ entryPoints: [fileURLToPath(new URL('studioLaunchpadLibrary.ts', kernel))],
  bundle: true, platform: 'browser', format: 'iife', globalName: 'studio', loader: { '.css': 'empty' }, write: false });

function fixture(t, language = 'en', actions = {}) {
  const { window } = new JSDOM('', { runScripts: 'outside-only' });
  const { LaunchpadLibrary } = window.eval(`${outputFiles[0].text}\nstudio;`);
  const project = (name, extra) => ({ uri: `file:///${name}`, kind: 'folder', path: `/${name}`, name, ...extra });
  let read = async () => [];
  const guide = {};
  const hoverService = {
    setupDelayedHover(target, options) {
      Object.assign(guide, { target, options });
      return { dispose() { guide.disposed = true; } };
    },
    showInstantHover(options, focus) { guide.activation = { options, focus }; },
  };
  const library = new LaunchpadLibrary((en, zh) => language === 'zh-cn' ? zh : en, { hoverService, readActivity: projects => read(projects), ...actions });
  t.after(() => { library.dispose(); window.close(); });
  window.document.body.append(library.element);
  const row = p => library.element.querySelector(`.lp-index-row[data-key="index:${p.uri}"]`);
  const status = p => [...row(p).querySelectorAll('.lp-index-dot')].map(dot => dot.title);
  return { library, guide, project, row, status, window, reader: impl => { read = impl; } };
}

for (const language of ['en', 'zh-cn']) {
  test(`schedules are a secondary action of each local Workflow entry (${language})`, t => {
    const calls = [], f = fixture(t, language, { openProjectSchedules: (project, entry) => calls.push([project.uri, entry]) });
    const entries = [{ type: 'workflow', entryId: 'build', name: 'Build' }, { type: 'workflow', entryId: 'review', name: 'Review' }, { type: 'bot', entryId: 'chat', name: 'Chat' }];
    const source = f.project('source', { distribution: 'source', projectType: 'aggregate', entries });
    const release = f.project('release', { distribution: 'release', projectType: 'aggregate', entries });
    f.library.update([source, release], [], true, '');
    f.library.show(source.uri);
    const controls = [...f.library.element.querySelectorAll('.lp-detail-secondary button[data-key^="workflow-schedules:"]')];
    const title = language === 'zh-cn' ? 'Workflow 定时计划' : 'Workflow schedules';
    assert.deepEqual(controls.map(button => button.textContent.trim()), [`${title} · Build`, `${title} · Review`]);
    assert.equal(f.library.element.querySelector('.lp-detail-actions button[data-key^="workflow-schedules:"]'), null);
    controls[1].click();
    assert.deepEqual(calls, [[source.uri, 'review']]);
    f.library.show(release.uri);
    assert.equal(f.library.element.querySelector('button[data-key^="workflow-schedules:"]'), null);
  });

  test(`the artifact library is a secondary action for the chosen Bot entry (${language})`, t => {
    const calls = [], f = fixture(t, language, { openBotArtifacts: (p, entry) => calls.push([p.uri, entry]), openBotMemory: (p, entry) => calls.push([p.uri, entry, 'memory']) });
    const bot = f.project('aggregate', { projectType: 'workflow', entries: [
      { type: 'workflow', entryId: 'build', name: 'Build', primary: true },
      { type: 'bot', entryId: 'ops', name: 'Ops' }, { type: 'bot', entryId: 'qa', name: 'QA' },
    ] });
    f.library.update([bot], [], true, '');
    f.library.show(bot.uri);
    const secondary = f.library.element.querySelector('.lp-detail-secondary');
    const controls = [...secondary.querySelectorAll('button[data-key^="bot-artifacts:"]')];
    assert.ok(!secondary.hidden);
    assert.deepEqual(controls.map(button => button.textContent.trim()), language === 'zh-cn' ? ['产物库 · Ops', '产物库 · QA'] : ['Artifact library · Ops', 'Artifact library · QA']);
    assert.equal(f.library.element.querySelector('.lp-detail-actions button[data-key^="bot-artifacts:"]'), null);
    controls[1].click();
    const memory = [...secondary.querySelectorAll('button[data-key^="bot-memory:"]')];
    assert.deepEqual(memory.map(button => button.textContent.trim()), language === 'zh-cn' ? ['记忆管理 · Ops', '记忆管理 · QA'] : ['Memory management · Ops', 'Memory management · QA']);
    assert.equal(f.library.element.querySelector('.lp-detail-actions button[data-key^="bot-memory:"]'), null);
    memory[0].click();
    assert.deepEqual(calls, [[bot.uri, 'qa'], [bot.uri, 'ops', 'memory']]);
  });

  test(`the credential list follows the selected Bot entry and ignores late responses (${language})`, async t => {
    const calls = [], pending = [];
    const f = fixture(t, language, { readBotCredentials: (p, entry) => new Promise(resolve => { calls.push([p.uri, entry]); pending.push(resolve); }) });
    const project = f.project('credential-aggregate', { entries: [
      { type: 'bot', entryId: 'ops', name: 'Ops' }, { type: 'bot', entryId: 'qa', name: 'QA' }, { type: 'workflow', entryId: 'flow', name: 'Flow' },
    ] });
    const other = f.project('credential-other', { projectType: 'workflow' });
    const render = () => new Promise(resolve => setImmediate(resolve));
    f.library.update([project, other], [], true, '');
    f.library.show(project.uri);
    const controls = () => [...f.library.element.querySelectorAll('[data-key^="bot-credentials:"]')];
    const list = () => f.library.element.querySelector('.lp-detail-secondary .lp-bot-credential-list');
    const title = language === 'zh-cn' ? '凭据管理' : 'Credential management';
    assert.deepEqual(controls().map(button => button.textContent.trim()), [`${title} · Ops`, `${title} · QA`]);
    assert.equal(f.library.element.querySelector('.lp-detail-actions [data-key^="bot-credentials:"]'), null);
    assert.deepEqual(calls, []);
    controls()[0].click();
    assert.equal(controls()[0].getAttribute('aria-expanded'), 'true');
    assert.ok(list().querySelector('[role="status"]'));
    await render();
    controls()[1].click();
    await render();
    assert.deepEqual(calls, [[project.uri, 'ops'], [project.uri, 'qa']]);
    pending[1]({ status: 'ok', rows: [{ name: 'fixture-qa', type: 'SSH private key' }] });
    pending[0]({ status: 'ok', rows: [{ name: 'fixture-ops', type: 'Password' }] });
    await render();
    assert.equal(controls()[1].getAttribute('aria-expanded'), 'true');
    assert.deepEqual([...list().querySelectorAll('td')].map(cell => cell.textContent), ['fixture-qa', 'SSH private key']);
    assert.deepEqual([...list().querySelectorAll('th')].map(cell => cell.textContent), language === 'zh-cn' ? ['别名', '类型'] : ['Alias', 'Type']);
    assert.equal(list().querySelectorAll('button,input,textarea').length, 0);
    controls()[1].click();
    assert.equal(list(), null);
    controls()[0].click();
    await render();
    f.library.show(other.uri);
    pending[2]({ status: 'ok', rows: [{ name: 'fixture-stale', type: 'Password' }] });
    await render();
    assert.equal(list(), null);
    assert.equal(controls().length, 0);
    f.library.show(project.uri);
    controls()[0].click();
    await render();
    pending[3]({ status: 'ok', rows: [] });
    await render();
    assert.equal(list().textContent, language === 'zh-cn' ? '暂无已保存的凭据。' : 'No saved credentials.');
  });

  test(`the library heading opens a localized status guide by hover or activation (${language})`, t => {
    const { library, guide } = fixture(t, language);
    const help = library.element.querySelector('.lp-rail-heading > h2 + button');
    const zh = language === 'zh-cn';
    assert.equal(help.getAttribute('aria-label'), zh ? '项目状态说明' : 'Project status guide');
    assert.equal(guide.target, help);
    const items = [...guide.options.content.querySelectorAll('li')];
    assert.deepEqual(items.map(li => [li.firstElementChild.classList[1], li.querySelector('strong').textContent]),
      zh ? [['lp-index-dot-open', '蓝点：项目已打开'], ['lp-index-dot-running', '绿点：任务正在运行'], ['lp-index-dot-linked', '橙点：已加入对话的 Bot']]
        : [['lp-index-dot-open', 'Blue: project is open'], ['lp-index-dot-running', 'Green: a task is running'], ['lp-index-dot-linked', 'Orange: Bot linked to chat']]);
    assert.match(items[1].textContent, zh ? /替代蓝点/u : /replaces the blue dot/iu);
    assert.match(items[2].textContent, zh ? /IM 通讯录.+不代表在线.+本机运行.+关闭 Studio 后会离线/u : /IM contacts.+does not indicate online status.+runs locally.+offline when Studio is closed/u);
    assert.equal(guide.options.persistence.hideOnHover, false);
    help.click();
    assert.equal(guide.activation.options.content, guide.options.content);
    assert.equal(guide.activation.focus, true);
    library.dispose();
    assert.equal(guide.disposed, true);
  });

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
