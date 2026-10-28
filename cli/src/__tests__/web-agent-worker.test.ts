import { writeProjectFixture } from '../../scripts/test-project-fixture.mjs';
import { expect, it } from 'vitest';
import { once } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLocalProjectConfigurationStore } from 'steamharness';
import type { AgentSessionSnapshot } from 'steamharness/agent';
import { createWebRuntime } from '../web/runtime';
import { resolveHarnessRoot } from './harness-source';

it('carries host settings into real workers and IPC tools until a durable session is safely remounted', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'workflow-user-settings-'));
  const applicationId = crypto.randomUUID();
  const configurationKey = createHash('sha256').update(`application:${applicationId}`).digest('hex');
  const runKey = createHash('sha256').update(await realpath(directory)).digest('hex');
  const configurationRoot = path.join(os.homedir(), '.steamharness', 'configurations');
  let settings: import('steamharness').UserSettings = { agent: { permissionPolicy: 'auto' } };
  const runtime = createWebRuntime(directory, path.join(directory, 'data'), () => undefined, { userSettings: () => settings });
  let run: Promise<unknown> | undefined, snapshot: AgentSessionSnapshot | undefined;
  const toolSets: string[][] = [];
  const model = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw), last = body.messages.at(-1);
    toolSets.push(body.tools.map((tool: any) => tool.function.name));
    const result = last.role === 'tool'
      ? { delta: { content: `Observed ${last.content}` }, reason: 'stop' }
      : { delta: { tool_calls: [{ index: 0, id: `settings-${toolSets.length}`, type: 'function', function: { name: 'fixture_settings', arguments: '{}' } }] }, reason: 'tool_calls' };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ id: 'settings', choices: [{ index: 0, delta: { role: 'assistant', ...result.delta }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'settings', choices: [{ index: 0, delta: {}, finish_reason: result.reason }] })}\n\ndata: [DONE]\n\n`);
  });
  try {
    await mkdir(path.join(directory, 'node_modules'));
    await symlink(await resolveHarnessRoot(), path.join(directory, 'node_modules/steamharness'), process.platform === 'win32' ? 'junction' : 'dir');
    await writeProjectFixture(path.join(directory, 'package.json'), JSON.stringify({ type: 'module', id: applicationId, name: 'user-settings', version: '1.0.0',  defaultEntry: 'main', entries: [{entryId:'main',name:'Main',type:'conversation',root:'.',entry:'index.ts',databases:[]}] }));
    model.listen(0, '127.0.0.1'); await once(model, 'listening');
    await writeFile(path.join(directory, 'index.ts'), `
      import { writeFileSync } from 'node:fs';
      export const executor = steamharness.defineExecutor({ projectType: 'conversation',
        workflow: steamharness.createAgentConversationProject({ projectName: 'Settings', outputItemId: 'answer',
          provider: 'openai', model: 'fixture', apiKind: 'openai-completions', apiKey: 'offline-fixture',
          baseUrl: 'http://127.0.0.1:${(model.address() as { port: number }).port}/v1', contextWindow: 8192,
          permissionPolicy: 'inherit', session: { compaction: { enabled: false } },
          createTools() { return [{ name: 'fixture_settings', label: 'Settings', description: 'Read the active user settings',
            parameters: { type: 'object', properties: {} } as any,
            async execute() { return { content: [{ type: 'text', text: steamharness.getUserSettings().agent.permissionPolicy }] }; },
          }]; },
        }), conversation: { durable: { enabled: true }, recovery: { enabled: true } },
        tools: [{ name: 'fixture_settings', enabled: true, autoApprove: true }],
        params: [{ kind: 'quick', id: 'access', label: 'Access', summary: ['access'], fields: [
          { name: 'access', flag: '--access', type: 'string', control: 'select',
            userSetting: { key: 'agent.permissionPolicy', mode: 'fixed' },
            options: [{ value: 'read-only' }, { value: 'workspace' }, { value: 'auto' }] },
        ] }],
        createInput({ args, paramValues }) {
          writeFileSync(new URL('./settings-seen', import.meta.url), steamharness.getUserSettings().agent.permissionPolicy);
          return { ...steamharness.createAgentProjectInput(args), permissionPolicy: paramValues.access };
        },
      });
    `);
    const inspected = await runtime.inspect([directory]); expect(inspected.errors).toEqual([]);
    const project = { ...inspected.projects[0], uri: '' };
    const request = { project, conversationId: 'settings-session', runId: 'settings-run', args: ['--message', 'First', '--access', 'workspace'] };
    const events = (event: Record<string, any>) => {
      if (event.type === 'node_chunk' && event.chunk?.item?.metadata?.kind === 'agent-session') snapshot = event.chunk.item.content;
    };
    let failure: unknown;
    const start = (resumeAgent = false) => { run = runtime.run({ ...request, resumeAgent }, events).catch(error => { failure = error; }); };
    const done = async (count: number) => {
      await expect.poll(() => { if (failure) throw failure; return snapshot?.turns.filter(turn => turn.status === 'done').length; }, { timeout: 15_000 }).toBe(count);
    };
    start(); await done(1);
    expect(await readFile(path.join(directory, 'settings-seen'), 'utf8')).toBe('auto');
    const ownerId = snapshot!.ownerId;
    settings = { agent: { permissionPolicy: 'read-only' } };
    await runtime.agentControl!('settings-run', { type: 'submit', requestId: 'same-owner', prompt: 'Next', mode: 'followUp' }, 'settings-session');
    await done(2);
    expect(snapshot!.turns.at(-1)!.items.map(item => item.content).join('')).toContain('Observed auto');
    expect(toolSets.every(tools => tools.includes('write'))).toBe(true);
    runtime.cancel('settings-run'); await run; run = undefined;
    snapshot = undefined; start(true); await done(2);
    expect(snapshot!.ownerId).not.toBe(ownerId);
    expect(await readFile(path.join(directory, 'settings-seen'), 'utf8')).toBe('read-only');
    const before = toolSets.length;
    const command = { type: 'submit' as const, requestId: 'new-owner', prompt: 'New permissions', mode: 'followUp' as const };
    const receipt = await runtime.agentControl!('settings-run', command, 'settings-session');
    await runtime.agentControl!('settings-run', command, 'settings-session');
    await done(3);
    expect(snapshot!.turns.at(-1)!.items.map(item => item.content).join('')).toContain('Observed read-only');
    expect(toolSets.slice(before).every(tools => !tools.includes('write') && !tools.includes('bash') && tools.includes('read'))).toBe(true);
    expect(snapshot!.turns.filter(turn => turn.requestId === 'new-owner')).toHaveLength(1);
    expect((await runtime.agentControl!('settings-run', command, 'settings-session')).submissionId).toBe(receipt.submissionId);
    runtime.cancel('settings-run'); await run; run = undefined;
  } finally {
    runtime.dispose(); await run;
    await new Promise<void>(resolve => { model.close(() => resolve()); model.closeAllConnections(); });
    await rm(directory, { recursive: true, force: true });
    await Promise.all([rm(path.join(configurationRoot, `${configurationKey}.json`), { force: true }), rm(path.join(configurationRoot, `${configurationKey}.json.lock.sqlite`), { force: true }), rm(path.join(configurationRoot, 'snapshots', runKey), { recursive: true, force: true })]);
  }
}, 40_000);

it('preserves the live generation when the worker loses its IPC owner and resumes it after reconnect', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'workflow-agent-disconnect-'));
  const applicationId = crypto.randomUUID();
  const configurationKey = createHash('sha256').update(`application:${applicationId}`).digest('hex');
  const runKey = createHash('sha256').update(await realpath(directory)).digest('hex');
  const configurationRoot = path.join(os.homedir(), '.steamharness', 'configurations');
  const runtime = createWebRuntime(directory, path.join(directory, 'data'), () => undefined);
  let calls = 0, child: ChildProcess | undefined, resumed: Promise<unknown> | undefined;
  let snapshot: AgentSessionSnapshot | undefined;
  const events = (event: Record<string, any>) => {
    if (event.type === 'node_chunk' && event.chunk?.item?.metadata?.kind === 'agent-session') snapshot = event.chunk.item.content;
  };
  const model = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Consume the request. */ }
    calls++;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ id: 'disconnect', choices: [{ index: 0, delta: { role: 'assistant', content: calls === 1 ? 'Before disconnect' : 'After reconnect' }, finish_reason: null }] })}\n\n`);
    if (calls > 1) response.end(`data: ${JSON.stringify({ id: 'disconnect', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  try {
    await mkdir(path.join(directory, 'node_modules'));
    await symlink(await resolveHarnessRoot(), path.join(directory, 'node_modules/steamharness'), process.platform === 'win32' ? 'junction' : 'dir');
    await writeProjectFixture(path.join(directory, 'package.json'), JSON.stringify({ type: 'module', id: applicationId, name: 'owner-disconnect', version: '1.0.0',  defaultEntry: 'main', entries: [{entryId:'main',name:'Main',type:'conversation',root:'.',entry:'index.ts',databases:[]}] }));
    model.listen(0, '127.0.0.1'); await once(model, 'listening');
    await writeFile(path.join(directory, 'index.ts'), `
      export const executor = steamharness.defineExecutor({ projectType: 'conversation',
        workflow: steamharness.createAgentConversationProject({ projectName: 'disconnect', outputItemId: 'answer',
          provider: 'openai', model: 'fixture', apiKind: 'openai-completions', apiKey: 'offline-fixture',
          baseUrl: 'http://127.0.0.1:${(model.address() as { port: number }).port}/v1', contextWindow: 8192,
          tools: [], session: { compaction: { enabled: false } }, }),
        conversation: { durable: { enabled: true }, recovery: { enabled: true } }, params: [],
        createInput({ args }) { return steamharness.createAgentProjectInput(args); }, });
    `);
    const inspected = await runtime.inspect([directory]); expect(inspected.errors).toEqual([]);
    const project = { ...inspected.projects[0], uri: '' };
    const request = { method: 'run', project, conversationId: 'disconnect-session', runId: 'disconnect-run', args: ['--message', 'First'], storageDir: path.join(directory, 'data'), runtimeProjectDir: directory };
    child = spawn(process.execPath, [fileURLToPath(new URL('../web/worker.mjs', import.meta.url))], { cwd: directory, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
    let output = '', failure = '', lastMessage: unknown;
    child.stderr!.on('data', chunk => { failure += chunk.toString(); });
    child.stdout!.setEncoding('utf8'); child.stdout!.on('data', chunk => {
      output += chunk;
      let newline: number;
      while ((newline = output.indexOf('\n')) >= 0) {
        const line = output.slice(0, newline); output = output.slice(newline + 1);
        if (line.startsWith('__STEAMHARNESS_WEB__')) {
          const message = JSON.parse(line.slice('__STEAMHARNESS_WEB__'.length));
          lastMessage = { kind: message.kind, type: message.value?.type, status: message.value?.status };
          if (message.kind === 'event') events(message.value);
        }
      }
    });
    child.stdin!.end(JSON.stringify(request));
    await expect.poll(() => snapshot?.turns[0]?.items.some(item => item.content === 'Before disconnect'), { timeout: 10_000 }).toBe(true);
    const exited = once(child, 'exit'); child.disconnect();
    let timer: ReturnType<typeof setTimeout>;
    const [code] = await Promise.race([exited, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Disconnected worker did not exit (code=${child?.exitCode}, signal=${child?.signalCode}): ${failure} ${JSON.stringify(lastMessage)}`)), 5000);
    })]).finally(() => clearTimeout(timer));
    expect(code, failure).toBe(0); child = undefined;
    snapshot = undefined;
    resumed = runtime.run({ ...request, resumeAgent: true }, events).catch(error => error);
    await expect.poll(() => snapshot?.turns[0]?.status, { timeout: 10_000 }).toBe('done');
    expect(snapshot!.turns).toHaveLength(1); expect(calls).toBe(2);
    expect(snapshot!.turns[0].prompt).toBe('First');
    expect(JSON.stringify(snapshot!.turns[0].items)).toContain('Before disconnect');
    expect(JSON.stringify(snapshot!.turns[0].items)).toContain('After reconnect');
    expect(snapshot!.turns[0].items.find(item => item.metadata?.partType === 'retry')?.content).toMatchObject({ kind: 'recovery' });
    await runtime.agentControl!('disconnect-run', { type: 'cancel', requestId: 'cleanup', scope: 'all' }, 'disconnect-session');
    runtime.cancel('disconnect-run'); await resumed; resumed = undefined;
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'close'); child.kill('SIGKILL'); await exited; }
    runtime.dispose(); await resumed;
    await new Promise<void>(resolve => { model.close(() => resolve()); model.closeAllConnections(); });
    await rm(directory, { recursive: true, force: true });
    await Promise.all([rm(path.join(configurationRoot, `${configurationKey}.json`), { force: true }), rm(path.join(configurationRoot, `${configurationKey}.json.lock.sqlite`), { force: true }), rm(path.join(configurationRoot, 'snapshots', runKey), { recursive: true, force: true })]);
  }
}, 30_000);

it('reports the original workflow failure to commands waiting for session startup', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'workflow-agent-startup-'));
  const applicationId = crypto.randomUUID();
  const configurationKey = createHash('sha256').update(`application:${applicationId}`).digest('hex');
  const runKey = createHash('sha256').update(await realpath(directory)).digest('hex');
  const configurationRoot = path.join(os.homedir(), '.steamharness', 'configurations');
  const runtime = createWebRuntime(directory, path.join(directory, 'data'), () => undefined);
  try {
    await mkdir(path.join(directory, 'node_modules'));
    await symlink(await resolveHarnessRoot(), path.join(directory, 'node_modules/steamharness'), process.platform === 'win32' ? 'junction' : 'dir');
    await writeProjectFixture(path.join(directory, 'package.json'), JSON.stringify({ type: 'module', id: applicationId, name: 'startup-failure', version: '1.0.0',  defaultEntry: 'main', entries: [{entryId:'main',name:'Main',type:'conversation',root:'.',entry:'index.ts',databases:[]}] }));
    await writeFile(path.join(directory, 'index.ts'), `
      export const executor = steamharness.defineExecutor({
        projectType: 'conversation',
        workflow: steamharness.createAgentConversationProject({
          projectName: 'startup', outputItemId: 'answer', provider: 'openai', model: 'fixture',
          apiKey: 'offline-fixture', baseUrl: 'http://127.0.0.1:1/v1', tools: [], session: {},
          async createTools() { throw new Error('Fixture tool initialization failed'); },
        }),
        conversation: { durable: { enabled: true }, recovery: { enabled: true } }, params: [],
        createInput({ args }) { return steamharness.createAgentProjectInput(args); },
      });
    `);
    const inspected = await runtime.inspect([directory]); expect(inspected.errors).toEqual([]);
    const events: Record<string, any>[] = [];
    const report = await runtime.run({ project: { ...inspected.projects[0], uri: '' }, conversationId: 'failed-session', runId: 'failed-run', args: ['--message', 'First'],
      agentCommands: [{ scopeId: 'failed-session', command: { type: 'snapshot', requestId: 'waiting-snapshot' } }] }, event => events.push(event));
    expect(report.status).toBe('failed');
    expect(events.find(event => event.type === 'agent_command_failed')).toMatchObject({ requestId: 'waiting-snapshot', message: expect.stringContaining('Fixture tool initialization failed') });
  } finally {
    runtime.dispose(); await rm(directory, { recursive: true, force: true });
    await Promise.all([rm(path.join(configurationRoot, `${configurationKey}.json`), { force: true }), rm(path.join(configurationRoot, `${configurationKey}.json.lock.sqlite`), { force: true }), rm(path.join(configurationRoot, 'snapshots', runKey), { recursive: true, force: true })]);
  }
}, 15_000);

it('controls the real worker over IPC and replays pending commands after reopening SQLite', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'workflow-agent-ipc-'));
  const applicationId = crypto.randomUUID();
  const configurationKey = createHash('sha256').update(`application:${applicationId}`).digest('hex');
  const runKey = createHash('sha256').update(await realpath(directory)).digest('hex');
  const configurationRoot = path.join(os.homedir(), '.steamharness', 'configurations');
  let calls = 0;
  const model = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Consume the model request. */ }
    calls++;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of [
      { choices: [{ index: 0, delta: { role: 'assistant', content: `Answer ${calls}` }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } },
    ]) response.write(`data: ${JSON.stringify({ id: 'ipc', object: 'chat.completion.chunk', model: 'ipc-test', ...event })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  const runtime = createWebRuntime(directory, path.join(directory, 'data'), () => undefined);
  let run: Promise<unknown> | undefined;
  try {
    const harnessRoot = await resolveHarnessRoot();
    await mkdir(path.join(directory, 'node_modules'));
    await symlink(harnessRoot, path.join(directory, 'node_modules/steamharness'), process.platform === 'win32' ? 'junction' : 'dir');
    await writeProjectFixture(path.join(directory, 'package.json'), JSON.stringify({ type: 'module', id: applicationId, name: 'agent-ipc', version: '1.0.0',  defaultEntry: 'main', entries: [{entryId:'main',name:'Main',type:'conversation',root:'.',entry:'index.ts',configuration:'configuration.json',databases:[]}] }));
    const declareConfiguration = (label: string) => writeFile(path.join(directory, 'configuration.json'), JSON.stringify({version:1,fields:[{name:'label',type:'string',defaultValue:label}]}));
    await declareConfiguration('first');
    model.listen(0, '127.0.0.1'); await once(model, 'listening');
    const port = (model.address() as { port: number }).port;
    await writeFile(path.join(directory, 'index.ts'), `
      import { existsSync, writeFileSync } from 'node:fs';
      const registry = steamharness.createAgentRegistry();
      registry.install(steamharness.defineAgentExtension({ name: 'ipc-extension', tasks: [steamharness.defineAgentTask({
        name: 'ipc.timer', version: 1,
        initial: input => ({ phase: 'sleep', wakeAt: input.wakeAt }),
        phases: { sleep: async (task, api, ctx) => {
          await api.sleep(task.state.checkpoint.wakeAt, ctx);
          await api.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: 'awake' } }), ctx);
        } },
        abort: async (_task, api, ctx) => { await api.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx); },
      })] }));
      export const executor = steamharness.defineExecutor({
        projectType: 'conversation',
        workflow: steamharness.createAgentConversationProject({
          projectName: 'IPC', projectName: 'ipc', outputItemId: 'answer',
          provider: 'openai', model: 'ipc-test', apiKind: 'openai-completions',
          baseUrl: 'http://127.0.0.1:${port}/v1', apiKey: 'offline-fixture', contextWindow: 8192,
          tools: [], session: { registry, codeMode: {}, compaction: { enabled: false } },
          async createTools() {
            writeFileSync(new URL('./configuration-seen', import.meta.url), steamharness.getConfig('label') ?? 'missing');
            const marker = new URL('./started', import.meta.url);
            if (existsSync(marker)) await new Promise(resolve => setTimeout(resolve, 6000));
            else writeFileSync(marker, 'started');
            return { tools: [] };
          },
        }),
        conversation: { durable: { enabled: true }, recovery: { enabled: true } },
        tools: [{ name: 'update_plan', enabled: true, autoApprove: true }], params: [],
        createInput({ args }) { return steamharness.createAgentProjectInput(args); },
      });
    `);
    const inspected = await runtime.inspect([directory]);
    expect(inspected.errors).toEqual([]);
    const project = { ...inspected.projects[0], uri: '' };
    expect(project.conversation?.durable).toEqual({ enabled: true });
    let snapshot: AgentSessionSnapshot | undefined;
    let earlyResult: unknown;
    const events = (event: Record<string, any>) => {
      if (event.type === 'node_chunk' && event.chunk?.type === 'output_item_start' && event.chunk.item?.metadata?.kind === 'agent-session') snapshot = event.chunk.item.content;
    };
    const request = { project, conversationId: 'ipc-session', runId: 'ipc-run', args: ['--message', 'First'] };
    run = runtime.run(request, events).then(result => { earlyResult = result; return result; }, error => { earlyResult = error; return error; });
    await expect.poll(() => {
      if (earlyResult) throw new Error(`Worker exited before a completed snapshot: ${earlyResult instanceof Error ? earlyResult.stack : JSON.stringify(earlyResult)}`);
      return snapshot?.turns.some(turn => turn.status === 'done');
    }, { timeout: 15_000 }).toBe(true);
    const ownerId = snapshot!.ownerId;
    expect(snapshot!.resources).toMatchObject({ codeMode: true, environment: { remote: false }, storage: 'SQLite' });
    expect(snapshot!.resources!.extensions).toContainEqual(expect.objectContaining({ name: 'ipc-extension', tasks: [{ name: 'ipc.timer', version: 1 }] }));
    const task = { type: 'task' as const, requestId: 'ipc-timer', name: 'ipc.timer', input: { wakeAt: Date.now() + 500 }, background: true };
    const taskReceipt = await runtime.agentControl!('ipc-run', task, 'ipc-session');
    expect(await runtime.agentControl!('ipc-run', task, 'ipc-session')).toEqual(taskReceipt);
    await expect.poll(() => snapshot?.tasks.find(item => item.id === taskReceipt.taskId)?.wakeAt).toBe(task.input.wakeAt);
    expect(snapshot!.tasks.find(item => item.id === taskReceipt.taskId)).toMatchObject({ definitionVersion: 1, checkpoint: { phase: 'sleep', wakeAt: task.input.wakeAt } });
    await expect.poll(() => snapshot?.history.find(item => item.id === taskReceipt.taskId)?.status).toBe('completed');
    const submit = { type: 'submit' as const, requestId: 'ipc-second', prompt: 'Second', mode: 'followUp' as const };
    const receipt = await runtime.agentControl!('ipc-run', submit, 'ipc-session');
    expect(receipt.status).toBe('accepted');
    await runtime.agentControl!('ipc-run', submit, 'ipc-session');
    await expect.poll(() => snapshot?.turns.find(turn => turn.requestId === 'ipc-second')?.status).toBe('done');
    expect(snapshot!.turns.map(turn => turn.items.map(item => item.content).join(''))).toEqual(['Answer 1', 'Answer 2']);
    expect(calls).toBe(2);
    runtime.cancel('ipc-run'); await run; run = undefined;
    expect(await readFile(path.join(directory, 'configuration-seen'), 'utf8')).toBe('first');
    const configurations = await createLocalProjectConfigurationStore(directory);
    const currentConfiguration = await configurations.read();
    await configurations.dispatch({action:'save',revision:currentConfiguration.revision,id:currentConfiguration.activeConfigurationId,values:{label:'second'}});
    snapshot = undefined;
    const plan = { type: 'plan' as const, requestId: 'recovered-plan', expectedVersion: 0, items: [{ id: 'keep', text: 'Survive slow tool initialization', status: 'pending' as const }] };
    run = runtime.run({ ...request, resumeAgent: true, args: ['--message', 'Reconnect must not submit this prompt'], configurationRunId:'ipc-config-v2', agentCommands: [{ scopeId: 'ipc-session', command: submit }, { scopeId: 'ipc-session', command: plan }, { scopeId: 'ipc-session', command: task }] }, events).catch(error => error);
    await expect.poll(() => snapshot?.turns.find(turn => turn.requestId === 'ipc-second')?.status, { timeout: 15_000 }).toBe('done');
    await expect.poll(() => snapshot?.plan.version, { timeout: 2000 }).toBe(1);
    expect(snapshot!.plan.items).toEqual(plan.items);
    expect(await readFile(path.join(directory, 'configuration-seen'), 'utf8')).toBe('second');
    expect(snapshot!.ownerId).not.toBe(ownerId);
    expect(calls).toBe(2);
    expect(await runtime.agentControl!('ipc-run', task, 'ipc-session')).toEqual(taskReceipt);
    expect(snapshot!.history.filter(item => item.id === taskReceipt.taskId)).toHaveLength(1);
    expect((await runtime.agentControl!('ipc-run', submit, 'ipc-session')).submissionId).toBe(receipt.submissionId);
    await runtime.agentControl!('ipc-run', { type: 'cancel', requestId: 'ipc-stop', scope: 'all' }, 'ipc-session');
    runtime.cancel('ipc-run'); await run; run = undefined;
    await runtime.cancelConversation(project, 'ipc-session');
  } finally {
    runtime.dispose(); await run;
    await new Promise<void>(resolve => { model.close(() => resolve()); model.closeAllConnections(); });
    await rm(directory, { recursive: true, force: true });
    await Promise.all([rm(path.join(configurationRoot,`${configurationKey}.json`),{force:true}),rm(path.join(configurationRoot,`${configurationKey}.json.lock.sqlite`),{force:true}),rm(path.join(configurationRoot,'snapshots',runKey),{recursive:true,force:true})]);
  }
}, 40_000);
