import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const compiled = await build({
  entryPoints: ['extensions/studio-workstation/webview/settings.ts'],
  bundle: true, format: 'iife', globalName: 'memorySettingsTest', write: false,
  loader: { '.css': 'empty' },
});
const account = { status: 'authenticated', revision: 1, serverUrl: 'https://server.test',
  user: { userId: 'user', email: 'user@example.test', displayName: 'User' } };
const record = { id: 'one', scope: 'global', content: 'A private memory', origin: 'manual',
  version: 1, updatedAt: '2026-10-29T00:00:00Z', sources: [] };

async function until(read) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (read()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail('Memory settings did not settle');
}

function fixture(t) {
  const dom = new JSDOM('<main id="settings"></main>', { runScripts: 'outside-only', url: 'https://studio.test' });
  t.after(() => dom.window.close());
  const { window } = dom, doc = window.document;
  const f = { calls: [], state: account, records: [record], deferDetail: false, replies: [] };
  window.eval(`${compiled.outputFiles[0].text}\nwindow.memorySettingsTest = memorySettingsTest;`);
  const respond = (request, data, status) => window.dispatchEvent(new window.MessageEvent('message', {
    data: { type: 'settings-memory-result', requestId: request.requestId, data,
      ...(status ? { error: 'Fixture authorization expired', status } : {}) },
  }));
  const view = window.memorySettingsTest.createSettingsView(doc.querySelector('main'), {
    getState: () => ({ section: 'memory' }),
    setState() {},
    postMessage(request) {
      if (request.type !== 'settings-memory') return;
      f.calls.push(request);
      if (request.action === 'get' && f.deferDetail) {
        f.replies.push(() => respond(request, record));
        return;
      }
      queueMicrotask(() => {
        if (!['authenticated', 'checking', 'error'].includes(f.state.status) || !f.state.user) {
          respond(request, undefined, 401); return;
        }
        const data = request.action === 'capabilities'
          ? { connected: true, enabled: true, status: 'ready', automatic: true, readOnly: false }
          : request.action === 'preferences' ? { enabled: true, automatic: true }
            : ['scopes', 'jobs'].includes(request.action) ? []
              : request.action === 'get' ? f.records.find(item => item.id === request.input.id)
                : { items: f.records };
        respond(request, data);
      });
    },
  });
  const setAccount = state => { f.state = state; view.setAccount(state); };
  setAccount(account);
  return Object.assign(f, { doc, setAccount });
}

test('background account revisions and verification preserve memory content, filters and an active draft', async t => {
  const f = fixture(t);
  await until(() => f.doc.querySelector('.am-row'));
  const panel = f.doc.querySelector('.account-memory');
  f.doc.querySelector('.am-row').click();
  await until(() => f.doc.querySelector('.am-content'));
  [...panel.querySelectorAll('button')].find(button => button.textContent === 'Edit').click();
  const draft = panel.querySelector('textarea');
  draft.value = 'Keep this unsaved edit'; draft.focus();
  const search = panel.querySelector('input[type="search"]');
  search.value = 'Keep this filter';
  const count = f.calls.length;
  for (const [index, status] of ['authenticated', 'checking', 'error', 'authenticated'].entries()) {
    f.setAccount({ ...account, status, revision: index + 2, aiConfigured: true });
    assert.equal(f.doc.querySelector('.account-memory'), panel, `${status} must retain the existing panel`);
    assert.equal(panel.querySelector('textarea'), draft);
    assert.equal(draft.value, 'Keep this unsaved edit');
    assert.equal(f.doc.activeElement, draft);
    assert.equal(search.value, 'Keep this filter');
  }
  assert.equal(f.calls.length, count, 'Account polling must not reload the memory data');
});

test('switching account or Server immediately clears memory and ignores earlier detail replies', async t => {
  const f = fixture(t);
  await until(() => f.doc.querySelector('.am-row'));
  f.deferDetail = true;
  f.doc.querySelector('.am-row').click();
  assert.equal(f.replies.length, 1);
  const oldPanel = f.doc.querySelector('.account-memory');
  f.records = [{ ...record, id: 'two', content: 'New account memory' }];
  const other = { ...account, user: { ...account.user, userId: 'other' }, revision: 2 };
  f.setAccount(other);
  assert.equal(oldPanel.textContent, '');
  await until(() => f.doc.querySelector('.am-row')?.textContent.includes('New account memory'));
  f.replies[0]();
  assert.equal(f.doc.body.textContent.includes('A private memory'), false);
  const otherPanel = f.doc.querySelector('.account-memory');
  f.setAccount({ ...other, serverUrl: 'https://other-server.test', revision: 3 });
  assert.equal(otherPanel.textContent, '');
  await until(() => f.doc.querySelector('.am-row'));
  const serverPanel = f.doc.querySelector('.account-memory');
  f.setAccount({ ...other, status: 'expired', revision: 4 });
  assert.equal(serverPanel.textContent, '');
  await until(() => f.doc.querySelector('.am-unavailable'));
  assert.equal(f.doc.body.textContent.includes('New account memory'), false);
});
