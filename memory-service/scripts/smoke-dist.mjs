import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
import { once } from 'node:events';

const root = await mkdtemp(path.join(tmpdir(), 'memory-dist-'));
const listener = createServer();
listener.listen(0, '127.0.0.1');
await once(listener, 'listening');
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const token = randomBytes(32).toString('hex');
const child = spawn(process.execPath, [path.resolve(import.meta.dirname, '../dist/index.js')], {
  env: { ...process.env, STEAMHARNESS_MEMORY_PORT: String(port), STEAMHARNESS_MEMORY_HOST: '127.0.0.1', STEAMHARNESS_MEMORY_SERVICE_TOKEN: token, STEAMHARNESS_MEMORY_DATA_DIR: root },
  stdio: ['ignore', 'ignore', 'pipe'],
});
const closed = once(child, 'exit');
let errors = '';
child.stderr.setEncoding('utf8').on('data', chunk => { errors = (errors + chunk).slice(-4000); });
try {
  let healthy = false;
  for (let i = 0; i < 100 && child.exitCode === null; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { headers: { Authorization: `Bearer ${token}` } });
      if (response.ok) { assert.equal((await response.json()).fts, true); healthy = true; break; }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(healthy, `Built memory service did not start. ${errors.replaceAll(token, '[redacted]')}`);
  console.log('Built memory service started with native node:sqlite and FTS5.');
} finally {
  child.kill('SIGTERM');
  await closed;
  await rm(root, { recursive: true, force: true });
}
