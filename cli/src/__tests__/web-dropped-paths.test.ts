import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { importDroppedEntries, resolveDroppedPaths } from '../web/dropped-paths';
import { conversationPrompt, pathReferences } from '../web/conversation-paths';
import { ConversationController } from '../web/conversation-controller';
import type { Project, Runtime } from '../web/workflow-types';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function directory() { const root = await mkdtemp(path.join(tmpdir(), 'conversation-drop-')); directories.push(root); return root; }

it('resolves files, folders and encoded file URIs using their actual filesystem types', async () => {
  const root = await directory(), folder = path.join(root, '资料 #1'), file = path.join(folder, 'a b.txt');
  await mkdir(folder); await writeFile(file, 'actual bytes');
  const references = await resolveDroppedPaths([pathToFileURL(file).href, folder]);
  expect(references).toEqual([{ path: file, name: 'a b.txt', kind: 'file' }, { path: folder, name: '资料 #1', kind: 'directory' }]);
  await expect(resolveDroppedPaths(['relative/path'])).rejects.toThrow();
  await expect(resolveDroppedPaths([path.join(root, 'missing')])).rejects.toThrow();
  expect(pathReferences([{ path: 'C:\\Work\\a b.txt', kind: 'file', name: 'untrusted' }])[0].name).toBe('a b.txt');
  expect(pathReferences([{ path: '\\\\server\\share\\folder', kind: 'directory' }])[0].name).toBe('folder');
});

it('imports browser directories with nested bytes, empty folders and top-level file identity intact', async () => {
  const root = await directory();
  const references = await importDroppedEntries(root, [
    { name: '目录', kind: 'directory' }, { name: '目录/空目录', kind: 'directory' },
    { name: '目录/nested/file.txt', kind: 'file', data: Buffer.from('文档内容').toString('base64') },
    { name: 'empty.txt', kind: 'file', data: '' },
  ]);
  expect(references.map(({ name, kind }) => ({ name, kind }))).toEqual([{ name: '目录', kind: 'directory' }, { name: 'empty.txt', kind: 'file' }]);
  expect(await readFile(path.join(references[0].path, 'nested/file.txt'), 'utf8')).toBe('文档内容');
  expect(await readdir(path.join(references[0].path, '空目录'))).toEqual([]);
  expect(await readFile(references[1].path, 'utf8')).toBe('');
});

it.each([
  [{ name: '../escape', kind: 'file', data: '' }], [{ name: '/absolute', kind: 'directory' }],
  [{ name: 'a\\b', kind: 'directory' }], [{ name: 'a', kind: 'file', data: 'invalid' }],
  [{ name: 'A', kind: 'file', data: '' }, { name: 'a', kind: 'file', data: '' }],
  [{ name: 'a', kind: 'file', data: '' }, { name: 'a/child', kind: 'file', data: '' }],
].map(entries => ({ entries })))('rejects invalid or ambiguous browser drop entries before writing any bytes ($entries)', async ({ entries }) => {
  const root = await directory(); await expect(importDroppedEntries(root, entries)).rejects.toThrow(); expect(await readdir(root)).toEqual([]);
});

it('keeps path-only input through initial Core arguments, queues, draft edits and retries', async () => {
  const references = [{ path: path.join(await directory(), 'folder'), name: 'folder', kind: 'directory' as const }];
  const project: Project = {entryId:"main",aggregateName:"Test aggregate",defaultEntry:"main",entryRoot:'/drop',databases:[],entries:[{entryId:"main",name:"Main",type:'conversation',root:".",entry:"index.ts",databases:[]}], id: 'drop', uri: 'file:///drop', folderPath: '/drop', name: 'Drop', projectType: 'conversation', fields: [], entrypoints: [], conversation: { inputQueue: { enabled: true } } };
  let finish: () => void = () => {};
  const runtime = { run: vi.fn(() => new Promise(resolve => { finish = () => resolve({ status: 'success' }); })) } as unknown as Runtime;
  const controller = new ConversationController(project, runtime, {}, { save: async () => {}, changed() {}, log() {} });
  const input = { text: '', attachments: [], references, params: {} };
  await controller.send(input);
  expect(vi.mocked(runtime.run).mock.calls[0][0].args).toEqual(['--message', conversationPrompt('', references)]);
  expect(controller.current.messages[0]).toMatchObject({ content: '', references, input });
  await controller.send(input); const queued = controller.current.queuedInputs![0];
  await controller.editQueued(queued.id); expect(controller.current.draft).toMatchObject({ references, editingQueueId: queued.id });
  await controller.cancelQueueEdit();
  finish(); await vi.waitFor(() => expect(runtime.run).toHaveBeenCalledTimes(2)); finish(); await controller.idle();
  const answer = controller.current.messages.at(-1)!; await controller.retry(answer.id!);
  expect(vi.mocked(runtime.run).mock.calls.at(-1)![0].args).toEqual(['--message', conversationPrompt('', references)]);
  finish(); await controller.idle(); controller.dispose();
});
