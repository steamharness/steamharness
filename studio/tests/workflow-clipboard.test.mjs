import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';

const compiled = await build({ entryPoints: ['extensions/studio-workstation/src/workflow-clipboard.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], write: false });
const request = (text, requestId = 'copy-1') => ({ type: 'workflow-clipboard', version: 1, command: 'writeText', requestId, text });
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(writeText) {
  const module = { exports: {} }, replies = [];
  runInNewContext(compiled.outputFiles[0].text, {
    module, exports: module.exports, Error,
    require: () => ({ env: { clipboard: { writeText } } }),
  });
  const binding = module.exports.bindProjectClipboard({ postMessage: async message => { replies.push(message); } });
  return { binding, replies };
}

test('copy waits for the native clipboard and reports its success or failure with the request identity', async () => {
  let finish;
  const writes = [], { binding, replies } = fixture(async text => {
    writes.push(text);
    if (text === 'denied') { throw new Error('Native clipboard denied'); }
    await new Promise(resolve => { finish = resolve; });
  });
  assert.equal(binding.receive(request('正文\nconst example = 1;')), true);
  await tick(); assert.equal(replies.length, 0); finish(); await tick();
  assert.equal(replies[0].type, 'workflow-host');
  assert.deepEqual({ ...replies[0].clipboard }, { version: 1, requestId: 'copy-1', ok: true, error: undefined });
  binding.receive(request('denied', 'copy-2')); await tick();
  assert.equal(replies[1].clipboard.ok, false); assert.equal(replies[1].clipboard.error, 'Native clipboard denied');
  assert.equal(replies[1].clipboard.requestId, 'copy-2');
  assert.deepEqual(writes, ['正文\nconst example = 1;', 'denied']);
});

test('malformed requests and messages from a closed view cannot write to the clipboard', async () => {
  const writes = [], { binding, replies } = fixture(async text => { writes.push(text); });
  for (const message of [undefined, {}, { ...request('text'), version: 2 }, { ...request('text'), command: 'readText' },
    request(42), request('text', ''), request('text', 'x'.repeat(129))]) {
    assert.equal(binding.receive(message), false);
  }
  await tick(); assert.equal(writes.length, 0);
  binding.receive(request('queued')); binding.dispose(); await tick();
  assert.equal(writes.length, 0); assert.equal(replies.length, 0);
  assert.equal(binding.receive(request('stale')), false);
});

test('closing the view drops pending confirmations and queued copies', async () => {
  let finish;
  const writes = [], { binding, replies } = fixture(async text => { writes.push(text); await new Promise(resolve => { finish = resolve; }); });
  binding.receive(request('first')); binding.receive(request('second', 'copy-2'));
  await tick(); binding.dispose(); finish(); await tick();
  assert.deepEqual(writes, ['first']); assert.equal(replies.length, 0);
});
