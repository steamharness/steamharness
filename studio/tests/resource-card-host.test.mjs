import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const compiled = await build({ entryPoints: ['extensions/studio-workstation/src/workflow-resource-cards.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], write: false });
const result = { type: 'resource-preview', id: '00000000-0000-0000-0000-000000000001', url: '/resource/00000000-0000-0000-0000-000000000001', action: 'open', card: { kind: 'knowledge', target: { source: 'server', projectId: 'database', documentId: 'doc' } } };

function fixture(fetcher) {
  const module = { exports: {} }, opened = [], messages = [];
  runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports, require: name => name === 'vscode' ? {} : require(name),
    URL, URLSearchParams, AbortController, AbortSignal, fetch: fetcher });
  const binding = module.exports.bindWorkflowResourceCards({ postMessage: async message => { messages.push(message); } },
    `http://127.0.0.1:3333/#session=${'a'.repeat(64)}`, async resource => { opened.push(resource); });
  return { binding, opened, messages };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('host re-resolves a saved card before opening it and never trusts client-supplied targets', async () => {
  let requested;
  const { binding, opened } = fixture(async (url, options) => { requested = { url: url.href, ...options }; return new Response(JSON.stringify({ messages: [result] })); });
  assert.equal(binding.receive({ type: 'workflow-resource', version: 1, request: { type: 'resource', action: 'open', cardId: 'card', messageId: 'message',
    target: { projectId: 'private', filePath: '/etc/passwd' } } }), true);
  await tick();
  assert.equal(requested.url, 'http://127.0.0.1:3333/api/message'); assert.equal(requested.headers.Authorization, `Bearer ${'a'.repeat(64)}`);
  assert.deepEqual(JSON.parse(requested.body), { type: 'resource', action: 'open', cardId: 'card', messageId: 'message' });
  assert.equal(opened.length, 1); assert.equal(opened[0].card.target.projectId, 'database'); binding.dispose();
});

test('a denied resource does not open a panel and reports the server error', async () => {
  const { binding, opened, messages } = fixture(async () => new Response(JSON.stringify({ message: 'Access denied' }), { status: 403 }));
  binding.receive({ type: 'workflow-resource', version: 1, request: { type: 'resource', cardId: 'card' } }); await tick();
  assert.equal(opened.length, 0); assert.equal(messages[0].resourceError.message, 'Access denied'); binding.dispose();
});

test('closing or rebinding a conversation cancels a pending resource open', async () => {
  let finish;
  const { binding, opened } = fixture(() => new Promise(resolve => { finish = resolve; }));
  binding.receive({ type: 'workflow-resource', version: 1, request: { type: 'resource', cardId: 'card', action: 'window' } }); binding.dispose();
  finish(new Response(JSON.stringify({ messages: [result] }))); await tick(); assert.equal(opened.length, 0);
});
