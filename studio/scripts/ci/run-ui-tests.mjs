import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from '../distribution.mjs';

assert.equal(process.platform, 'linux', 'Desktop tests require the isolated Linux runner.');
assert.ok(process.env.CI && process.env.DISPLAY, 'Run full tests in GitLab CI under Xvfb.');
const manifest = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
const directory = path.join(ROOT, '.studio/ci-results');
await mkdir(directory, { recursive: true });
const results = [];
const suites = ['test:desktop', ...Object.keys(manifest.scripts).filter(name => /^test:.*ui$/.test(name))];

function killGroup(pid, signal) {
  try { process.kill(-pid, signal); } catch (error) { if (error.code !== 'ESRCH') { throw error; } }
}

for (const name of suites) {
  const reason = name === 'test:conversation-server-ui'
    ? 'Requires a configured real dev server and model credentials.'
    : name === 'test:document-preview-ui' && !process.env.STUDIO_TEST_PREVIEW_FILES
      ? 'Requires STUDIO_TEST_PREVIEW_FILES with PDF, DOCX, PPTX, XLSX, TEX and HEIC samples.' : undefined;
  if (reason) {
    results.push({ name, status: 'skipped', reason });
    console.log(`[SKIPPED] ${name}: ${reason}`);
  } else {
    console.log(`[START] ${name}`);
    const started = Date.now();
    const log = await open(path.join(directory, `${name.replaceAll(':', '-')}.log`), 'w');
    const result = await new Promise(resolve => {
      const args = ['run', name, ...(name === 'test:desktop' ? ['--', '--no-sandbox'] : [])];
      const child = spawn('npm', args, { cwd: ROOT, stdio: ['ignore', log.fd, log.fd], detached: true });
      let timedOut = false;
      let forceKill;
      const timeout = setTimeout(() => {
        timedOut = true;
        killGroup(child.pid, 'SIGTERM');
        forceKill = setTimeout(() => killGroup(child.pid, 'SIGKILL'), 10_000);
      }, 600_000);
      child.once('error', error => {
        clearTimeout(timeout);
        resolve({ name, status: 'failed', error: error.message });
      });
      child.once('exit', (code, signal) => {
        clearTimeout(timeout);
        clearTimeout(forceKill);
        killGroup(child.pid, 'SIGKILL');
        resolve({ name, status: code === 0 && !timedOut ? 'passed' : 'failed', code, signal, timedOut });
      });
    });
    await log.close();
    results.push({ ...result, durationMs: Date.now() - started });
    console.log(`[${result.status.toUpperCase()}] ${name}`);
  }
  await writeFile(path.join(directory, 'results.json'), JSON.stringify({
    commit: process.env.CI_COMMIT_SHA,
    runner: process.env.CI_RUNNER_DESCRIPTION,
    platform: process.platform,
    results,
  }, null, 2) + '\n');
}
process.exitCode = results.some(result => result.status === 'failed') ? 1 : 0;
