import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

const compiled = await build({ entryPoints: ['extensions/studio-workstation/src/workflow-project-usage.ts'], bundle: true,
  platform: 'node', format: 'esm', write: false });
const { bindProjectUsage } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);

test('the embedded usage bridge is bound to its own project and cancels stale readers', async () => {
  const posted = [], started = [], cancelled = [];
  let active = true;
  const binding = bindProjectUsage({ postMessage: async message => posted.push(message) }, { uri: 'file:///project', identity: 'known:release', managed: true },
    () => active, input => {
      if (input.cancel) { cancelled.push(input.id); return; }
      return new Promise(resolve => started.push({ ...input, resolve }));
    });
  const requestId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
  let frame = binding.frame();
  const request = (part, fields = {}) => binding.receive({ type: 'workflow-project-usage', version: 1, revision: frame.revision, requestId, part, ...fields });
  request('directory', { revision: 'foreign' });
  request('directory', { uri: 'file:///unrelated', identity: 'foreign', managed: false });
  request('directory', { requestId: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb' });
  await Promise.resolve();
  assert.equal(started.length, 1);
  assert.deepEqual({ uri: started[0].uri, identity: started[0].identity, managed: started[0].managed }, { uri: 'file:///project', identity: 'known:release', managed: true });
  assert.equal(started[0].refresh, true);
  assert.notEqual(started[0].id, requestId);
  frame = binding.frame();
  assert.deepEqual(cancelled, [started[0].id]);
  const snapshot = { part: 'directory', measuredAt: 1, usage: { state: 'ok', folders: [] } };
  started[0].resolve(snapshot);
  active = false; request('runtime');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(posted.length, 0); assert.equal(started.length, 1);
  active = true; request('directory');
  await Promise.resolve(); started[1].resolve(snapshot);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(posted, [{ type: 'workflow-host', projectUsage: { version: 1, revision: frame.revision, requestId, snapshot } }]);
  request('runtime'); await Promise.resolve(); binding.dispose();
  assert.deepEqual(cancelled, [started[0].id, started[2].id]);
});

test('opening the browser vault carries no project or credential data from the iframe', () => {
  const signals = [];
  let active = true;
  const binding = bindProjectUsage({ postMessage: () => assert.fail('Unexpected reply to the project frame') },
    { uri: 'file:///project', identity: 'known:release', managed: false }, () => active, undefined, async signal => signals.push(signal));
  const frame = binding.frame();
  assert.equal(frame.webCredentials, true);
  const message = { type: 'workflow-bot-credentials', version: 1, revision: frame.revision };
  binding.receive({ ...message, revision: 'stale' });
  assert.equal(signals.length, 0);
  binding.receive(message);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].aborted, false);
  binding.frame();
  assert.equal(signals[0].aborted, true);
  binding.receive(message);
  active = false;
  binding.receive({ ...message, revision: binding.frame().revision });
  assert.equal(signals.length, 1);
  binding.dispose();
});
