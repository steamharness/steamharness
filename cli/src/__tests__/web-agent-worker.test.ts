import { expect, it } from 'vitest';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentSessionSnapshot } from 'steamharness/agent';
import { createWebRuntime } from '../web/runtime';
import { resolveHarnessRoot } from './harness-source';

it('controls the real worker over IPC and replays pending commands after reopening SQLite', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'workflow-agent-ipc-'));
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
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ type: 'module', id: '8912f599-21e5-4ef3-9008-ccf0ac7c242d', name: 'agent-ipc', version: '1.0.0', steamHarness: { projectType: 'conversation', projectInfo: { dataStorage: { mode: 'local' } } } }));
    model.listen(0, '127.0.0.1'); await once(model, 'listening');
    const port = (model.address() as { port: number }).port;
    await writeFile(path.join(directory, 'index.ts'), `
      import { existsSync, writeFileSync } from 'node:fs';
      const registry = workflow.createAgentRegistry();
      registry.install(workflow.defineAgentExtension({ name: 'ipc-extension', tasks: [workflow.defineAgentTask({
        name: 'ipc.timer', version: 1,
        initial: input => ({ phase: 'sleep', wakeAt: input.wakeAt }),
        phases: { sleep: async (task, api, ctx) => {
          await api.sleep(task.state.checkpoint.wakeAt, ctx);
          await api.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: 'awake' } }), ctx);
        } },
        abort: async (_task, api, ctx) => { await api.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx); },
      })] }));
      export const executor = workflow.defineExecutor({
        projectType: 'conversation',
        workflow: workflow.createAgentConversationWorkflow({
          projectName: 'IPC', workflowName: 'ipc', outputItemId: 'answer',
          provider: 'openai', model: 'ipc-test', apiKind: 'openai-completions',
          baseUrl: 'http://127.0.0.1:${port}/v1', apiKey: 'offline-fixture', contextWindow: 8192,
          tools: [], session: { registry, codeMode: {}, compaction: { enabled: false } },
          async createTools() {
            const marker = new URL('./started', import.meta.url);
            if (existsSync(marker)) await new Promise(resolve => setTimeout(resolve, 6000));
            else writeFileSync(marker, 'started');
            return { tools: [] };
          },
        }),
        conversation: { durable: { enabled: true }, recovery: { enabled: true } },
        tools: [{ name: 'update_plan', enabled: true, autoApprove: true }], params: [],
        createInput({ args }) { return workflow.createAgentProjectInput(args); },
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
    snapshot = undefined;
    const plan = { type: 'plan' as const, requestId: 'recovered-plan', expectedVersion: 0, items: [{ id: 'keep', text: 'Survive slow tool initialization', status: 'pending' as const }] };
    run = runtime.run({ ...request, agentCommands: [{ scopeId: 'ipc-session', command: submit }, { scopeId: 'ipc-session', command: plan }, { scopeId: 'ipc-session', command: task }] }, events).catch(error => error);
    await expect.poll(() => snapshot?.turns.find(turn => turn.requestId === 'ipc-second')?.status, { timeout: 15_000 }).toBe('done');
    await expect.poll(() => snapshot?.plan.version, { timeout: 2000 }).toBe(1);
    expect(snapshot!.plan.items).toEqual(plan.items);
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
  }
}, 40_000);
