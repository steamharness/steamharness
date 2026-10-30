import { expect, it } from 'vitest';
import { once } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeProjectFixture } from '../../scripts/test-project-fixture.mjs';
import { startWebServer } from '../web/server';
import { resolveHarnessRoot, resolveHarnessVersion } from './harness-source';

it.each(['generation', 'uncooperative-tool'])('recovers a wrapped Agent after its CLI is SIGKILLed during %s without sending its queue after failure', async phase => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'web-crash-recovery-'));
  const applicationId = crypto.randomUUID(), dataDir = path.join(directory, 'data');
  const configurationRoot = path.join(os.homedir(), '.steamharness', 'configurations');
  const configurationKey = createHash('sha256').update(`application:${applicationId}`).digest('hex');
  const runKey = createHash('sha256').update(await realpath(directory)).digest('hex');
  let cli: ChildProcess | undefined, workerPid: number | undefined;
  let restored: Awaited<ReturnType<typeof startWebServer>> | undefined;
  let calls = 0, recovered = false;
  const model = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Consume the local fixture request. */ }
    ++calls;
    // Keep the failure in place through Core's ten fallback attempts. A single
    // failure now recovers successfully and legitimately releases queued input.
    if (calls > 1 && !recovered) { response.writeHead(401, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'Fixture authorization failure' } })); return; }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const delta = calls === 1 && phase === 'uncooperative-tool'
      ? { tool_calls: [{ index: 0, id: 'stuck', type: 'function', function: { name: 'stuck_tool', arguments: '{}' } }] }
      : { content: calls === 1 ? 'Before forced exit' : 'Successful answer' };
    response.write(`data: ${JSON.stringify({ id: 'crash', choices: [{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: null }] })}\n\n`);
    if (calls === 1 && phase === 'generation') return;
    response.end(`data: ${JSON.stringify({ id: 'crash', choices: [{ index: 0, delta: {}, finish_reason: calls === 1 ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  try {
    model.listen(0, '127.0.0.1'); await once(model, 'listening');
    await mkdir(path.join(directory, 'node_modules'));
    await symlink(await resolveHarnessRoot(), path.join(directory, 'node_modules/steamharness'), process.platform === 'win32' ? 'junction' : 'dir');
    await writeProjectFixture(path.join(directory, 'package.json'), JSON.stringify({ type: 'module', id: applicationId, name: 'crash-fixture', version: '1.0.0', devDependencies: { steamharness: await resolveHarnessVersion() },
      defaultEntry: 'main', entries: [{ entryId: 'main', name: 'Main', type: 'conversation', root: '.', entry: 'index.ts', databases: [] }] }));
    await writeFile(path.join(directory, 'index.ts'), `
      import { writeFileSync } from 'node:fs';
      const core = steamharness.createAgentConversationProject({ projectName: 'Crash fixture', outputItemId: 'answer',
        provider: 'openai', model: 'fixture', apiKind: 'openai-completions', apiKey: 'offline-fixture',
        baseUrl: 'http://127.0.0.1:${(model.address() as { port: number }).port}/v1', contextWindow: 8192, tools: [],
        createTools() { return [{ name: 'stuck_tool', label: 'Stuck tool', description: 'Offline shutdown fixture',
          parameters: { type: 'object', properties: {} }, replay: 'never',
          async execute() {
            writeFileSync(new URL('./tool-started', import.meta.url), String(process.pid));
            setInterval(() => {}, 1000);
            await new Promise(() => {});
          } }]; }
      });
      const wrapped = steamharness.defineProject({ name: 'Business wrapper', run(input, context) { return core.run(input, context); } });
      export const executor = steamharness.defineExecutor({ projectType: 'conversation', workflow: wrapped, coreAgent: core,
        conversation: { inputQueue: { enabled: true } }, params: [],
        tools: [{ name: 'stuck_tool', enabled: true, autoApprove: true }],
        createInput({ args }) { writeFileSync(new URL('./worker-pid', import.meta.url), String(process.pid)); return steamharness.createAgentProjectInput(args); }
      });
    `);
    cli = spawn(process.execPath, [fileURLToPath(new URL('../../dist/index.js', import.meta.url)), 'web', directory, '--data-dir', dataDir, '--no-open', '--json'],
      { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', diagnostics = '';
    cli.stderr!.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-8000); });
    const ready = await new Promise<{ url: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CLI startup timed out: ${diagnostics}`)), 20_000);
      const exited = () => { clearTimeout(timer); reject(new Error(`CLI exited before ready: ${diagnostics}`)); };
      cli!.once('exit', exited); cli!.once('error', reject);
      cli!.stdout!.on('data', chunk => {
        output += chunk;
        let newline: number;
        while ((newline = output.indexOf('\n')) >= 0) {
          const line = output.slice(0, newline); output = output.slice(newline + 1);
          if (!line.startsWith('{')) continue;
          const message = JSON.parse(line);
          if (message.type === 'ready') { clearTimeout(timer); cli!.off('exit', exited); resolve(message); }
        }
      });
    });
    const token = new URL(ready.url).hash.slice('#session='.length);
    const post = async (value: string | object) => {
      const response = await fetch(new URL('api/message', ready.url), { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(typeof value === 'string' ? { type: 'send', text: value, params: {}, attachments: [] } : value) });
      const text = await response.text();
      if (!text.startsWith('{')) {
        const retry = await fetch(new URL('api/retry', ready.url), { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
        throw new Error(`Fixture entry unavailable: ${await retry.text()}; ${diagnostics}`);
      }
      const result = JSON.parse(text); expect(response.status, JSON.stringify(result)).toBe(200);
      return result.messages;
    };
    await post('Original input');
    await expect.poll(async () => {
      const state = (await post({ type: 'ready' })).find((message: { type: string }) => message.type === 'state');
      const answer = state.sessions?.[0]?.messages.at(-1);
      if (answer?.status === 'failed') throw new Error(`Fixture run failed: ${answer.error}; ${diagnostics}`);
      if (phase === 'uncooperative-tool') return readFile(path.join(directory, 'tool-started'), 'utf8').then(Number, () => 0);
      return calls;
    }, { timeout: 12_000 }).toBeGreaterThan(0);
    workerPid = Number(await readFile(path.join(directory, 'worker-pid'), 'utf8'));
    await post('Queued one'); await post('Queued two');
    const exited = once(cli, 'exit'); cli.kill('SIGKILL'); await exited;
    restored = await startWebServer({ projectDir: directory, dataDir });
    await expect.poll(() => {
      try { process.kill(workerPid!, 0); return false; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true; throw error; }
    }, { timeout: 8000 }).toBe(true);
    workerPid = undefined;
    expect(restored.project.conversation?.recovery?.enabled).toBe(true);
    await restored.controller!.idle();
    const session = restored.controller!.current;
    expect(session.messages.filter(message => message.role === 'assistant')).toHaveLength(1);
    expect(session.messages.at(-1)?.status).toBe('failed');
    expect(session.messages.at(-1)?.error).not.toContain('busy');
    expect(session.queuedInputs?.map(input => input.text)).toEqual(['Queued one', 'Queued two']);
    const failedCalls = calls;
    // A generation interrupted by SIGKILL may already consume the first
    // attempt. Both phases must retry and exhaust within the bounded budget.
    expect(failedCalls).toBeGreaterThan(2); expect(failedCalls).toBeLessThanOrEqual(12);
    await restored.controller!.cancelQueueEdit();
    expect(calls).toBe(failedCalls);
    recovered = true;
    await restored.controller!.send({ text: 'Explicit input after restart', params: {}, attachments: [] });
    await restored.controller!.idle();
    expect(session.messages.filter(message => message.role === 'assistant').map(message => message.status)).toEqual(['failed', 'success', 'success', 'success']);
    expect(session.queuedInputs).toEqual([]); expect(calls).toBe(failedCalls + 3);
    expect(session.messages.filter(message => message.role === 'user').map(message => message.content)).toEqual(['Original input', 'Explicit input after restart', 'Queued one', 'Queued two']);
    if (phase === 'uncooperative-tool') expect(Number(await readFile(path.join(directory, 'tool-started'), 'utf8'))).not.toBe(Number(await readFile(path.join(directory, 'worker-pid'), 'utf8')));
  } finally {
    if (cli && cli.exitCode === null && cli.signalCode === null) { const exited = once(cli, 'exit'); cli.kill('SIGKILL'); await exited; }
    if (workerPid) try { process.kill(workerPid, 'SIGKILL'); } catch {}
    await restored?.close();
    await new Promise<void>(resolve => { model.close(() => resolve()); model.closeAllConnections(); });
    await rm(directory, { recursive: true, force: true });
    await Promise.all([rm(path.join(configurationRoot, `${configurationKey}.json`), { force: true }), rm(path.join(configurationRoot, `${configurationKey}.json.lock.sqlite`), { force: true }), rm(path.join(configurationRoot, 'snapshots', runKey), { recursive: true, force: true })]);
  }
}, 120_000);
