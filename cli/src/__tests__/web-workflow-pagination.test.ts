import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLocalRuntimePersistence } from 'steamharness/runtime-storage';
import { Controller } from '../web/workflow-controller';
import { WorkflowHistory } from '../web/workflow-history';
import { createProjectActions } from '../web/workflow-actions';
import type { Project, Runtime } from '../web/workflow-types';

const project: Project = { id: 'bdfbd2d2-08f9-4c0d-b9d6-6d0c00027bd4', entryId: 'main', name: 'Monitor', aggregateName: 'Monitor', defaultEntry: 'main',
  uri: 'file:///test', folderPath: '/test', entryRoot: '/test', databases: [], entries: [], projectType: 'workflow', fields: [], defaultEntrypoint: 'main', entrypoints: [{ id: 'main', title: 'Listen', fields: [] }] };
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
const item = (index: number) => ({ id: String(index), title: 'Output', contentType: 'text', content: `Frame ${index}` });
async function fixture(run: Runtime['run']) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'workflow-pagination-'));
  const backend = createLocalRuntimePersistence({ directory });
  const history = new WorkflowHistory(() => backend);
  const runtime = { run, cancel: vi.fn(), readFile: vi.fn(), deleteFiles: vi.fn(async () => {}), deleteConversation: vi.fn(async () => {}) } as unknown as Runtime;
  const controller = new Controller(project, runtime, await history.read(), { journal: history.journal, save: state => history.save(state), changed() {}, log() {} });
  cleanup.push(async () => { controller.dispose(); await controller.idle(); await history.reset(); await backend.close(); await rm(directory, { recursive: true, force: true }); });
  return { backend, history, controller, runtime };
}
it('keeps full output on disk, bounds live state, sends only the requested page and restores cancelled runs', async () => {
  const f = await fixture(async (_request, emit) => {
    for (let i = 0; i < 201; i++) emit({ type: 'node_chunk', chunk: { type: 'output_item_start', item: item(i) } });
    return { status: 'aborted', output: { items: Array.from({ length: 100 }, (_, i) => item(i + 101)) }, nodes: [] };
  });
  const record = await f.controller.start({ entrypointId: 'main', params: {} }); await f.controller.idle();
  expect(record.items.length).toBeLessThanOrEqual(100); expect(record.events.length).toBeLessThanOrEqual(100);
  expect(record.outputSummary?.total).toBe(201);
  const actions = createProjectActions(f.controller, f.runtime, project, () => 0, () => {});
  expect(actions.state().run?.items).toEqual([]); expect(actions.state().run?.events).toEqual([]);
  const [reply] = await actions.handle({ type: 'workflow-output-page', runId: record.id, page: 2, pageSize: 100, requestId: 7 });
  expect(reply).toMatchObject({ requestId: 7, page: 2, total: 201 }); expect(reply.items).toHaveLength(100); expect(reply.items[0].id).toBe('100');
  expect((await f.controller.outputPage(record.id)).items).toHaveLength(1);
  expect((await f.controller.materialize(record.id)).items).toHaveLength(201);
  const restored = await f.history.read(); expect(restored.runs[0].items).toEqual([]); expect(restored.runs[0].outputSummary?.total).toBe(201);
  await f.controller.remove(record.id); expect((await f.backend.readRunOutputPage!(record.id)).total).toBe(0);
});
it('does not replace streamed history with a smaller successful final report', async () => {
  const f = await fixture(async (_request, emit) => {
    for (let i = 0; i < 101; i++) emit({ type: 'node_chunk', chunk: { type: 'output_item_start', item: item(i) } });
    return { status: 'success', output: { items: [item(100)] }, nodes: [] };
  });
  const record = await f.controller.start({ params: {} }); await f.controller.idle();
  expect((await f.controller.outputPage(record.id, 1)).items).toHaveLength(100);
  expect((await f.controller.outputPage(record.id, 2)).total).toBe(101);
  expect(record.report?.output?.items).toEqual([]);
});
it('stops a running stream without discarding output already received', async () => {
  let finish!: () => void;
  const waiting = new Promise<void>(resolve => { finish = resolve; });
  let started!: () => void;
  const running = new Promise<void>(resolve => { started = resolve; });
  const f = await fixture(async (_request, emit) => {
    for (let i = 0; i < 101; i++) emit({ type: 'node_chunk', chunk: { type: 'output_item_start', item: item(i) } });
    started(); await waiting; return { status: 'aborted', nodes: [] };
  });
  vi.mocked(f.runtime.cancel).mockImplementation(() => finish());
  const record = await f.controller.start({ params: {} }); await running; await f.controller.stop();
  expect(record.status).toBe('aborted'); expect((await f.controller.outputPage(record.id, 1)).items).toHaveLength(100);
  expect((await f.controller.outputPage(record.id, 2)).items[0].id).toBe('100');
});

it('keeps a journal write failure visible when Stop races the failed write', async () => {
  let finish!: () => void, rejectWrite!: (error: Error) => void, writing!: () => void;
  const writes = new Promise<void>(resolve => { writing = resolve; });
  const waiting = new Promise<void>(resolve => { finish = resolve; });
  const f = await fixture(async (_request, emit) => {
    emit({ type: 'node_chunk', chunk: { type: 'output_item_start', item: item(1) } });
    await waiting; return { status: 'aborted', nodes: [] };
  });
  const acquire = f.backend.acquire.bind(f.backend);
  f.backend.acquire = async (...args) => {
    const lease = await acquire(...args);
    return { ...lease, appendRunOutput: async (runId, input) => {
      if (input.events?.length) { writing(); return new Promise((_resolve, reject) => { rejectWrite = reject; }); }
      return lease.appendRunOutput!(runId, input);
    } };
  };
  vi.mocked(f.runtime.cancel).mockImplementation(() => finish());
  const record = await f.controller.start({ params: {} }); await writes;
  const stopping = f.controller.stop(); rejectWrite(new Error('Disk full')); await stopping;
  expect(record.status).toBe('failed'); expect(record.error).toBe('Disk full');
});
it('keeps input attachments pinned when more than 100 screenshots have arrived', async () => {
  const inputId = `wf_${'f'.repeat(32)}`;
  const f = await fixture(async (_request, emit) => {
    for (let i = 0; i < 201; i++) {
      const id = `wf_${String(i).padStart(32, '0')}`;
      emit({ type: 'file_created', file: { id, name: `${i}.jpg`, mimeType: 'image/jpeg' } });
      emit({ type: 'node_chunk', chunk: { type: 'output_item_start', item: { ...item(i), content: `![frame](${id})` } } });
    }
    return { status: 'success', nodes: [] };
  });
  vi.mocked(f.runtime.readFile).mockResolvedValue({ reference: { id: inputId, name: 'input.txt', mimeType: 'text/plain', size: 1, kind: 'file', storage: 'local', createdAt: new Date().toISOString() }, path: '/unused' });
  const record = await f.controller.start({ params: { files: JSON.stringify({ id: inputId }) } }); await f.controller.idle();
  expect(record.files).toHaveLength(101);
  expect((await f.controller.outputPage(record.id, 1)).files.some(file => file.id === inputId)).toBe(true);
  expect((await f.controller.outputPage(record.id, 3)).files).toHaveLength(2);
});
