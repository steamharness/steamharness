import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { resolve } from 'import-meta-resolve';
import { chromium } from '../upstream/vscode/node_modules/playwright/index.mjs';
import { ROOT, assertRuntime, assertUpstream, exists } from '../scripts/distribution.mjs';

await assertRuntime();
const upstream = await assertUpstream();
assert.ok(await exists(path.join(upstream.directory, 'out/server-main.js')), 'Run npm run build first.');
const aggregateAssistant = path.resolve(ROOT, '../open-soucres/build-in/build-in-developer-assistant');
const assistant = path.resolve(process.env.STUDIO_CONTROL_TEST_ASSISTANT_DIR ||
  (await exists(path.join(aggregateAssistant, 'package.json')) ? aggregateAssistant : path.join(ROOT, 'vendor/developer-assistant')));
const aggregateControl = path.resolve(ROOT, '../open-soucres/build-in/build-in-studio-control');
const controlProject = await exists(path.join(aggregateControl, 'package.json')) ? aggregateControl : path.join(ROOT, 'vendor/studio-control');
const require = createRequire(path.join(assistant, 'package.json'));
const cliManifestPath = require.resolve('@workflow-code/cli/package.json');
const cliManifest = JSON.parse(await readFile(cliManifestPath, 'utf8'));
const runtimeApi = resolve('workflow-code/runtime-api', pathToFileURL(path.join(assistant, 'index.ts')).href);
const directory = await mkdtemp(path.join(tmpdir(), 'studio-control-live-'));
const extension = path.join(directory, 'extensions/control-test');
const workdir = path.join(directory, 'workspace');
const proof = path.join(ROOT, '.studio/studio-control-live');
const reportFile = path.join(directory, 'report.json');
for (const target of [extension, workdir, proof]) await mkdir(target, { recursive: true });
await writeFile(path.join(extension, 'package.json'), JSON.stringify({ name: 'control-test', publisher: 'studio-test', version: '0.0.1',
  engines: { vscode: '^1.140.0' }, main: './extension.cjs', extensionKind: ['workspace'], activationEvents: ['onStartupFinished'] }));
await build({ entryPoints: [path.join(ROOT, 'tests/studio-control-live-extension.mjs')], bundle: true, platform: 'node', format: 'cjs',
  external: ['vscode'], outfile: path.join(extension, 'extension.cjs') });
const token = randomBytes(32).toString('hex');
let log = '', child, browser;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  child = spawn(process.execPath, [path.join(upstream.directory, 'scripts/code-server.js'), '--host', '127.0.0.1', '--port', '0',
    '--connection-token', token, '--server-data-dir', path.join(directory, 'server'), '--extensions-dir', path.join(directory, 'extensions'),
    '--builtin-extensions-dir', path.join(upstream.directory, 'extensions'), '--disable-workspace-trust', '--telemetry-level', 'off',
    '--default-folder', workdir], { cwd: upstream.directory, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'development', VSCODE_DEV: '1', WORKFLOW_CLI_AUTH_DIR: path.join(directory, 'auth'),
      WORKFLOW_SERVER_URL: '', WORKFLOW_SERVER_ADMIN_KEY: '', VSCODE_SKIP_BUILTIN_EXTENSIONS: 'vscode.vscode-api-tests,GitHub.copilot,GitHub.copilot-chat',
      STUDIO_CONTROL_TEST_REPORT: reportFile, STUDIO_CONTROL_TEST_ASSISTANT: assistant, STUDIO_CONTROL_TEST_NODE: process.execPath,
      STUDIO_CONTROL_TEST_PROJECT: controlProject,
      STUDIO_CONTROL_TEST_TEMPLATE: path.join(ROOT, 'extensions/studio-workstation/dist/studio-control'),
      STUDIO_CONTROL_TEST_CLI: path.resolve(path.dirname(cliManifestPath), cliManifest.bin['workflow-code']), STUDIO_CONTROL_TEST_RUNTIME_API: runtimeApi } });
  child.stdout.on('data', chunk => { log = (log + chunk.toString()).replaceAll(token, '[redacted]'); });
  child.stderr.on('data', chunk => { log = (log + chunk.toString()).replaceAll(token, '[redacted]'); });
  let port;
  for (let attempt = 0; attempt < 300; attempt++) {
    port = /Web UI available at http:\/\/[^:/\s]+:(\d+)/.exec(log)?.[1]
      ?? /Extension host agent listening on (\d+)/.exec(log)?.[1];
    if (port) break;
    assert.equal(child.exitCode, null, log);
    await pause(100);
  }
  assert.ok(port, `Studio server did not become ready.\n${log}`);
  browser = await chromium.launch({ channel: process.env.STUDIO_CONTROL_TEST_BROWSER || 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`http://127.0.0.1:${port}/?tkn=${token}`, { waitUntil: 'domcontentloaded' });
  let report;
  for (let attempt = 0; attempt < 1800; attempt++) {
    if (await exists(reportFile)) {
      try { report = JSON.parse(await readFile(reportFile, 'utf8')); break; } catch { /* The extension is still writing. */ }
    }
    assert.equal(child.exitCode, null, log);
    await pause(100);
  }
  assert.ok(report, 'Studio Control live extension timed out. See .studio/studio-control-live/server.log.');
  await writeFile(path.join(proof, 'results.json'), JSON.stringify(report, null, 2));
  assert.equal(report.passed, true, report.error);
  for (const check of report.checks) console.log(`[OK] ${check}`);
  console.log(`Live Studio Control checks passed on VS Code ${report.vscodeVersion}.`);
} finally {
  await browser?.close();
  if (child?.pid) {
    const kill = signal => { try { process.platform === 'win32' ? child.kill(signal) : process.kill(-child.pid, signal); }
      catch (error) { if (error.code !== 'ESRCH') throw error; } };
    kill('SIGTERM');
    if (child.exitCode === null) {
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), pause(5000)]);
      if (child.exitCode === null) kill('SIGKILL');
    }
  }
  await writeFile(path.join(proof, 'server.log'), log);
  await rm(directory, { recursive: true, force: true });
}
