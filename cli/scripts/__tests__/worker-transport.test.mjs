import assert from 'node:assert/strict';
import test from 'node:test';
import { Writable } from 'node:stream';
import { createWorkerTransport } from '../../src/web/worker-transport.mjs';

test('large worker frames wait for a slow host without accumulating the remaining stream', async () => {
  const callbacks = [], frames = [];
  const output = new Writable({ highWaterMark: 16, write(chunk, _encoding, done) { frames.push(chunk.toString()); callbacks.push(done); } });
  const send = createWorkerTransport(output);
  let finished = false;
  const producing = (async () => {
    for (let revision = 0; revision < 100; revision++) await send({ kind: 'event', value: { revision, text: '中文'.repeat(50_000) } });
    await send({ kind: 'result', value: 'done' });
    finished = true;
  })();
  for (let revision = 0; revision <= 100; revision++) {
    assert.equal(frames.length, revision + 1);
    assert.equal(callbacks.length, 1);
    assert.equal(finished, false);
    assert.equal(output.writableLength, Buffer.byteLength(frames[revision]));
    const parsed = JSON.parse(frames[revision].slice('__STEAMHARNESS_WEB__'.length));
    assert.equal(parsed.kind, revision === 100 ? 'result' : 'event');
    if (revision < 100) assert.equal(parsed.value.revision, revision);
    callbacks.shift()();
    await new Promise(resolve => setImmediate(resolve));
  }
  await producing;
  assert.equal(finished, true);
  assert.equal(output.writableLength, 0);
  output.destroy();
});

test('worker transport propagates pipe failures to its producer', async () => {
  const failure = new Error('Disconnected pipe');
  const output = new Writable({ write(_chunk, _encoding, done) { done(failure); } });
  output.on('error', () => {});
  await assert.rejects(createWorkerTransport(output)({ kind: 'event' }), error => error === failure);
});
