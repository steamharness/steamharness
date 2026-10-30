import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const ui = (await build({ entryPoints: ['extensions/studio-workstation/webview/resources.ts'], bundle: true, platform: 'browser', format: 'iife', loader: { '.css': 'empty' }, write: false })).outputFiles[0].text;
const firstId = '00000000-0000-4000-8000-000000000001', secondId = '00000000-0000-4000-8000-000000000002';
const database = (databaseId = firstId, name = 'Shared knowledge') => ({ key: databaseId, databaseId, name });
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, bundle = {}, locale = 'en') {
  const dom = new JSDOM('<body data-resource-kind="knowledge"><div id="resources-app"></div><script id="studio-localization" type="application/json"></script></body>', { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const sent = [], doc = dom.window.document;
  doc.querySelector('#studio-localization').textContent = JSON.stringify({ bundle, locale });
  dom.window.acquireVsCodeApi = () => ({ postMessage: message => sent.push(message), getState: () => ({ source: 'local', projectUri: 'old-entry' }), setState() {} });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function (value) { this.returnValue = value; this.open = false; this.dispatchEvent(new dom.window.Event('close')); };
  dom.window.eval(ui);
  const message = data => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data }));
  const state = (extra = {}) => message({ type: 'resources-state', generation: 1, selected: firstId, databases: [database()], source: 'server', authenticated: true, ...extra });
  const requests = () => sent.filter(item => item.type === 'request');
  const reply = async (value, request = requests().at(-1)) => { message({ type: 'resources-result', id: request.id, generation: request.generation, value }); await tick(); };
  return { dom, doc, sent, state, message, requests, reply };
}

for (const locale of ['en', 'zh-cn']) {
  test(`${locale}: resources display the database name and its fixed location without project or host selectors`, async t => {
    const bundle = JSON.parse(await readFile(new URL(`../extensions/studio-workstation/l10n/bundle.l10n${locale === 'en' ? '' : '.zh-cn'}.json`, import.meta.url), 'utf8'));
    const f = fixture(t, bundle, locale); f.state();
    const select = f.doc.querySelector('#resource-database');
    assert.equal(select.getAttribute('aria-label'), locale === 'en' ? 'Database' : '数据库');
    assert.equal(select.options.length, 1); assert.equal(select.options[0].textContent, 'Shared knowledge');
    assert.equal(select.title, firstId); assert.equal(select.disabled, true);
    assert.equal(f.doc.querySelector('#resource-project'), null); assert.equal(f.doc.querySelector('#resource-source'), null);
    assert.equal(f.doc.querySelector('#resource-location').title, locale === 'en' ? 'Server' : '服务器');
    assert.equal(Object.hasOwn(f.requests()[0].input, 'source'), false);
    await f.reply({ items: [], total: 0, source: 'server', hasMore: false });
    assert.equal(f.doc.querySelector('#resources-app').dataset.source, 'server');
    f.state({ generation: 2, selected: undefined, databases: [], source: undefined });
    assert.equal(f.doc.querySelector('#resource-list').textContent, locale === 'en' ? 'No databases linked' : '尚未关联数据库');
    assert.equal(f.doc.querySelector('#resource-location').hidden, true);
  });
}

test('catalog metadata updates preserve the open document and an unsaved draft', async t => {
  const f = fixture(t); f.state();
  await f.reply({ items: [{ id: 'doc', documentId: 'doc', title: 'Guide', preview: '' }], total: 1, source: 'server' });
  f.doc.querySelector('.resource-row').click(); await tick(); await f.reply({ id: 'doc', title: 'Guide', markdown: '# Original' });
  f.doc.querySelector('#detail-edit').click();
  const body = f.doc.querySelector('#detail-body'); body.value = '# Unsaved'; body.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }));
  const requestCount = f.requests().length;
  f.state({ databases: [database(firstId, 'Renamed database'), database(secondId, 'Other database')] });
  assert.equal(f.doc.querySelector('#detail-body'), body); assert.equal(body.value, '# Unsaved');
  assert.equal(f.doc.querySelector('#detail-dirty').hidden, false); assert.equal(f.requests().length, requestCount);
  const select = f.doc.querySelector('#resource-database');
  select.value = secondId; select.dispatchEvent(new f.dom.window.Event('change'));
  const dialog = f.doc.querySelector('#resource-confirm'); assert.equal(dialog.open, true);
  dialog.close('cancel'); await tick(); assert.equal(select.value, firstId);
  assert.equal(f.sent.some(item => item.type === 'select'), false);
  select.value = secondId; select.dispatchEvent(new f.dom.window.Event('change')); dialog.close('discard'); await tick();
  assert.equal(f.sent.at(-1).type, 'select'); assert.equal(f.sent.at(-1).databaseKey, secondId);
});

test('distinct databases with the same name remain identifiable by ID', t => {
  const f = fixture(t); f.state({ databases: [database(), database(secondId)] });
  const options = [...f.doc.querySelector('#resource-database').options];
  assert.ok(options[0].textContent.includes(firstId)); assert.ok(options[1].textContent.includes(secondId));
  assert.notEqual(options[0].value, options[1].value);
});

test('switching databases discards old host state and ignores late data replies', async t => {
  const f = fixture(t); f.state(); const first = f.requests()[0];
  f.state({ generation: 2, selected: secondId, databases: [database(secondId, 'Local database')], source: undefined });
  assert.equal(f.doc.querySelector('#resource-location').hidden, true);
  await f.reply({ items: [{ id: 'stale', title: 'Stale data' }], total: 1, source: 'server' }, first);
  assert.equal(f.doc.querySelector('.resource-row'), null);
  await f.reply({ items: [], total: 0, source: 'local' });
  assert.equal(f.doc.querySelector('#resources-app').dataset.source, 'local');
  assert.equal(f.doc.querySelector('#resource-location').title, 'Local');
});
