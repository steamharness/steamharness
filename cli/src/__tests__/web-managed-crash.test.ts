import { writeProjectFixture } from '../../scripts/test-project-fixture.mjs';
import { expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { ConversationController } from '../web/conversation-controller';
import { createWebRuntime } from '../web/runtime';
import { resolveHarnessRoot } from './harness-source';

it('recovers a killed worker inside managed child execution without replaying its committed write', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'managed-crash-'));
  const applicationId = crypto.randomUUID(), diagnostics: string[] = [];
  const runtime = createWebRuntime(directory, path.join(directory, 'data'), () => undefined, { userSettings: () => ({ agent: { permissionPolicy: 'auto' } }) });
  let controller: ConversationController | undefined, killed = false, childWaiting = false, childCalls = 0;
  const model = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const child = body.messages.some((message: any) => ['system', 'developer'].includes(message.role) && JSON.stringify(message.content).includes('CHILD_ONLY_ROLE'));
    const hasTool = body.messages.some((message: any) => message.role === 'tool');
    diagnostics.push(`${child ? 'child' : 'main'} tools=${(body.tools ?? []).map((tool: any) => tool.function.name).join(',')}: ${JSON.stringify(body.messages.filter((message: any) => message.role === 'tool').at(-1)?.content ?? 'first request').slice(0, 1500)}`);
    if (child) childCalls++;
    const tool = !hasTool ? { id: child ? 'record' : 'spawn', type: 'function', function: {
      name: child ? 'record_once' : 'subagent', arguments: JSON.stringify(child ? {} : {
        action: 'spawn', agentId: 'researcher', workId: 'source-1', task: 'Research the source', background: false,
      }),
    } } : undefined;
    const delta = { role: 'assistant', ...(tool ? { tool_calls: [{ index: 0, ...tool }] }
      : { content: child ? killed ? 'Child completed' : 'Child before crash' : 'Owner completed' }) };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ id: 'managed', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    if (child && hasTool && !killed) { childWaiting = true; return; }
    response.end(`data: ${JSON.stringify({ id: 'managed', choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  const configurationRoot = path.join(os.homedir(), '.steamharness', 'configurations');
  const configurationKey = createHash('sha256').update(`application:${applicationId}`).digest('hex');
  const runKey = createHash('sha256').update(await realpath(directory)).digest('hex');
  try {
    model.listen(0, '127.0.0.1'); await once(model, 'listening');
    await mkdir(path.join(directory, 'node_modules'));
    await symlink(await resolveHarnessRoot(), path.join(directory, 'node_modules/steamharness'), process.platform === 'win32' ? 'junction' : 'dir');
    await writeProjectFixture(path.join(directory, 'package.json'), JSON.stringify({ type: 'module', id: applicationId, name: 'managed-crash', version: '1.0.0', defaultEntry: 'main',
      entries: [{ entryId: 'main', name: 'Main', type: 'conversation', root: '.', entry: 'index.ts', databases: [] }] }));
    await writeFile(path.join(directory, 'index.ts'), `
      import { appendFileSync, writeFileSync } from 'node:fs';
      const core = steamharness.createAgentConversationProject({ projectName: 'Managed crash', outputItemId: 'answer',
        provider: 'openai', model: 'fixture', apiKind: 'openai-completions', apiKey: 'offline-fixture',
        baseUrl: 'http://127.0.0.1:${(model.address() as { port: number }).port}/v1', contextWindow: 16384, tools: [],
        session: { compaction: { enabled: false }, subagents: { tools: ['record_once'], maxAgents: null, definitions: [{
          id: 'researcher', description: 'Research one source', systemPrompt: 'CHILD_ONLY_ROLE', tools: ['record_once'], maxConcurrency: null,
        }] } },
        createTools() { return [{ name: 'record_once', label: 'Record', description: 'Write the committed receipt once',
          parameters: { type: 'object', properties: {} }, replay: 'never', async execute() {
            appendFileSync(new URL('./committed-writes', import.meta.url), 'committed\\n');
            return { content: [{ type: 'text', text: 'Committed once' }], details: {} };
          } }]; }
      });
      export const executor = steamharness.defineExecutor({ projectType: 'conversation', workflow: core,
        conversation: { inputQueue: { enabled: true } }, params: [],
        tools: ['subagent', 'record_once'].map(name => ({ name, enabled: true, autoApprove: true })),
        createInput({ args }) { writeFileSync(new URL('./worker-pid', import.meta.url), String(process.pid)); return steamharness.createAgentProjectInput(args); }
      });
    `);
    const inspected = await runtime.inspect([directory]); expect(inspected.errors).toEqual([]);
    controller = new ConversationController({ ...inspected.projects[0], uri: '' }, runtime, {}, { save: async () => {}, changed() {}, log(text) { diagnostics.push(text); } });
    await controller.send({ text: 'Research and report', params: {}, attachments: [] });
    await vi.waitFor(() => {
      const answer = controller!.current.messages.find(message => message.role === 'assistant');
      if (answer?.status === 'failed') throw new Error(`${answer.error}; ${diagnostics.join('\n')}`);
      expect(childWaiting, JSON.stringify({ diagnostics, childCalls, messages: controller!.current.messages.map(message => ({ role: message.role, status: message.status, error: message.error, content: message.content.slice(0, 500), pending: !!message.pendingInput })), hasRuns: controller!.hasRuns })).toBe(true);
      expect(controller!.current.agent?.history.some(task => task.toolName === 'record_once' && task.status === 'completed')).toBe(true);
    }, { timeout: 20_000, interval: 50 });
    const owner = controller.current, originalOwner = owner.agent!.ownerId;
    const work = owner.agent!.agents!.find(item => item.workId === 'source-1')!;
    expect(work.status).toBe('running'); expect(work.childConversationId).toBeGreaterThan(1);
    const pid = Number(await readFile(path.join(directory, 'worker-pid'), 'utf8'));
    killed = true; process.kill(pid, 'SIGKILL');
    await vi.waitFor(() => {
      expect(owner.agent?.ownerId, diagnostics.join('\n')).not.toBe(originalOwner);
      expect(owner.agent?.agents?.find(item => item.taskId === work.taskId)?.status, diagnostics.join('\n')).toBe('completed');
      expect(owner.messages.filter(message => message.role === 'assistant').at(-1)?.status).toBe('success');
    }, { timeout: 20_000, interval: 50 });
    const resumed = owner.agent!.agents!.find(item => item.workId === 'source-1')!;
    expect(resumed.taskId).toBe(work.taskId); expect(resumed.childConversationId).toBe(work.childConversationId);
    expect(resumed.attempt).toBe(1); expect(childCalls).toBeGreaterThanOrEqual(3);
    expect(await readFile(path.join(directory, 'committed-writes'), 'utf8')).toBe('committed\n');
    expect(owner.agentInterrupted).toBeUndefined();
    expect(owner.messages.filter(message => message.role === 'user')).toHaveLength(1);
    await controller.agentCommand(owner.id, { type: 'subagent', action: 'get', taskId: work.taskId, requestId: 'inspect-after-crash' });
  } finally {
    controller?.dispose(); runtime.dispose(); await controller?.idle();
    await new Promise<void>(resolve => { model.close(() => resolve()); model.closeAllConnections(); });
    await rm(directory, { recursive: true, force: true });
    await Promise.all([rm(path.join(configurationRoot, `${configurationKey}.json`), { force: true }), rm(path.join(configurationRoot, `${configurationKey}.json.lock.sqlite`), { force: true }), rm(path.join(configurationRoot, 'snapshots', runKey), { recursive: true, force: true })]);
  }
}, 60_000);
