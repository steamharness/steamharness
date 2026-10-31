import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createWebRuntime } from '../web/runtime';
import type { Project } from '../web/workflow-types';

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn }));

afterEach(() => { spawn.mockReset(); vi.useRealTimers(); });

function conflictWorker() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    connected: true, kill: vi.fn(), send: vi.fn(),
  });
  child.stdin.once('finish', () => queueMicrotask(() => {
    child.stdout.write(`__STEAMHARNESS_WEB__${JSON.stringify({ kind: 'error', error: 'Storage owner is shutting down', metadata: { agentFailure: 'owner_conflict' } })}\n`);
    child.connected = false; child.emit('close', 1, null);
  }));
  return child;
}

it.each(['cancel', 'dispose'] as const)('does not restart a recovering worker when %s occurs between ownership retries', async action => {
  spawn.mockImplementation(conflictWorker);
  const runtime = createWebRuntime(process.cwd(), process.cwd(), () => undefined);
  const run = runtime.run({ project: {} as Project, conversationId: 'session', runId: 'run', args: [], resumeAgent: true }, vi.fn());
  const rejected = expect(run).rejects.toThrow();
  // Let the conflict settle; the next worker is waiting on the retry delay.
  await new Promise(resolve => setImmediate(resolve));
  expect(spawn).toHaveBeenCalledOnce();
  if (action === 'cancel') runtime.cancel('run'); else runtime.dispose();
  await rejected;
  expect(spawn).toHaveBeenCalledOnce();
  runtime.dispose();
});

it('does not retry ownership conflicts for a new input', async () => {
  spawn.mockImplementation(conflictWorker);
  const runtime = createWebRuntime(process.cwd(), process.cwd(), () => undefined);
  await expect(runtime.run({ project: {} as Project, conversationId: 'session', runId: 'new', args: [] }, vi.fn())).rejects.toThrow('Storage owner');
  expect(spawn).toHaveBeenCalledOnce();
  runtime.dispose();
});

function pendingWorker() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    connected: true, kill: vi.fn(), send: vi.fn(),
  });
  child.kill.mockImplementation(() => { child.connected = false; child.emit('close', 1, null); return true; });
  return child;
}

it('allows a large Kanban file to finish after the ordinary worker deadline', async () => {
  vi.useFakeTimers();
  const child = pendingWorker(); spawn.mockReturnValue(child);
  const runtime = createWebRuntime(process.cwd(), process.cwd(), () => undefined);
  const read = runtime.kanbanBridge!({} as Project, { requestId: 'image', operation: 'files.readFile', input: { database: 'data', fileId: 'image' } });
  await vi.advanceTimersByTimeAsync(45_000);
  expect(child.kill).not.toHaveBeenCalled();
  child.stdout.write('__STEAMHARNESS_WEB__' + JSON.stringify({ kind: 'result', value: { file: { id: 'image' }, base64: 'aW1hZ2U=' } }) + '\n');
  child.connected = false; child.emit('close', 0, null);
  await expect(read).resolves.toMatchObject({ base64: 'aW1hZ2U=' });
  await vi.advanceTimersByTimeAsync(120_000);
  expect(child.kill).not.toHaveBeenCalled();
  runtime.dispose();
});

it.each(['files.readFile', 'kv.getValue'] as const)('bounds %s workers and returns a safe timeout code', async operation => {
  vi.useFakeTimers();
  const child = pendingWorker(); spawn.mockReturnValue(child);
  const runtime = createWebRuntime(process.cwd(), process.cwd(), () => undefined);
  const read = runtime.kanbanBridge!({} as Project, { requestId: 'request', operation, input: { database: 'data', fileId: 'image', key: 'map' } });
  const rejected = expect(read).rejects.toMatchObject({ code: 'KANBAN_BRIDGE_TIMEOUT' });
  const deadline = operation === 'files.readFile' ? 120_000 : 30_000;
  await vi.advanceTimersByTimeAsync(deadline - 1);
  expect(child.kill).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await rejected;
  expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
  await vi.advanceTimersByTimeAsync(5_000);
  expect(child.kill).toHaveBeenCalledTimes(1);
  runtime.dispose();
});
