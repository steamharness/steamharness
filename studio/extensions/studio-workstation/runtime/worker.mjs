import { readFileSync } from 'node:fs';
import { readFile, writeFile, readdir, rm, stat, mkdir, mkdtemp, link } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { register } from 'tsx/esm/api';
import ts from 'typescript';
import { assistantWorkspaceManifest } from './assistant-workspace.mjs';
import {
  inspectLocalWorkflowStructure, resolveLocalWorkflowParams, runLocalWorkflowWithReport, createKanbanArtifactEntryPath,
  createLocalWorkflowFileStore, createServerWorkflowFileStore, createWorkflowFileStore,
  createLocalWorkflowKVStore, createWorkflowKVContext, createWorkflowPersistentValueContext,
  listLocalWorkflowKVEntries, deleteLocalWorkflowKVEntry, getKnowledgeDocument, listKnowledgeDocuments,
} from './core.mjs';

const write = process.stdout.write.bind(process.stdout);
const send = (kind, value) => write(`__STUDIO_WORKFLOW__${JSON.stringify({ kind, value })}\n`);
console.log = console.error;
const controller = new AbortController();
process.on('SIGTERM', () => controller.abort(new Error('Stopped.')));
process.on('SIGINT', () => controller.abort(new Error('Stopped.')));
register({ tsconfig: new URL('./tsconfig.json', import.meta.url).pathname });
let assistantScopeDirectory;

async function requiresSystemAi(directory) {
  const skipped = new Set(['node_modules', 'vendor', 'dist', 'out', 'build', 'test', 'tests', '__tests__', 'fixtures']);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || skipped.has(entry.name.toLowerCase())) { continue; }
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) { if (await requiresSystemAi(file)) { return true; } continue; }
    if (!entry.isFile() || !/\.[cm]?[jt]sx?$/.test(entry.name) || /(?:\.d|\.test|\.spec)\.[cm]?[jt]sx?$/.test(entry.name) || (await stat(file)).size > 1024 * 1024) { continue; }
    const source = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true);
    let required = false;
    const visit = (node) => {
      if (required) { return; }
      if (ts.isCallExpression(node)) {
        const expression = node.expression;
        const name = ts.isPropertyAccessExpression(expression) ? expression.name.text
          : ts.isIdentifier(expression) ? expression.text
          : ts.isElementAccessExpression(expression) && ts.isStringLiteral(expression.argumentExpression) ? expression.argumentExpression.text : undefined;
        if (name === 'getServerLLMCredentials' || name === 'createAgentProjectParamResolver') { required = true; return; }
      }
      ts.forEachChild(node, visit);
    };
    visit(source); if (required) { return true; }
  }
  return false;
}

try {
  const request = JSON.parse(readFileSync(0, 'utf8'));
  if (request.method === 'inspect') {
    const projects = [];
    const errors = [];
    for (const folderPath of request.paths) {
      try {
        const pkg = JSON.parse(readFileSync(path.join(folderPath, 'package.json'), 'utf8'));
        const structure = inspectLocalWorkflowStructure({ workflowDir: folderPath });
        const parameters = (entry) => ({ fields: entry.params ?? [], paramLayout: entry.paramLayout, paramResolver: entry.paramResolver, tools: entry.tools });
        projects.push({
          id: pkg.id,
          folderPath,
          name: pkg.workflowCode?.projectInfo?.localizedNames?.['zh-CN'] ?? pkg.name ?? path.basename(folderPath),
          projectType: structure.projectType,
          ...parameters(structure),
          entrypoints: (structure.entrypoints ?? []).map((entry) => ({ id: entry.id, title: entry.title, ...parameters(entry) })),
          defaultEntrypoint: structure.defaultEntrypoint,
          artifactEntry: structure.kanban ? createKanbanArtifactEntryPath(structure.kanban) : undefined,
          conversation: structure.conversation,
          requiresLogin: await requiresSystemAi(folderPath),
        });
      } catch (error) { errors.push(`${folderPath}: ${error.message}`); }
    }
    send('result', { projects, errors });
  } else if (request.project?.folderPath) {
    const projectKey = createHash('sha256').update(request.project.assistant ? `assistant:${request.project.assistant.workdir}` : request.project.folderPath).digest('hex').slice(0, 24);
    const dataDir = path.join(request.storageDir, projectKey);
    if (request.project.assistant) {
      const manifest = assistantWorkspaceManifest(request.project.assistant);
      await mkdir(dataDir, { recursive: true });
      assistantScopeDirectory = await mkdtemp(path.join(dataDir, 'scope-'));
      const manifestPath = path.join(assistantScopeDirectory, 'workspace.json');
      await writeFile(manifestPath, JSON.stringify(manifest));
      process.env.WORKFLOW_DEVELOPER_ASSISTANT_HOST = 'vscode';
      process.env.WORKFLOW_DEVELOPER_ASSISTANT_WORKDIR = request.project.assistant.workdir;
      process.env.WORKFLOW_DEVELOPER_ASSISTANT_WORKSPACE_MANIFEST = manifestPath;
    }
    const storage = { host: 'local', local: { kvStoreDir: path.join(dataDir, 'kv'), persistentValueStoreDir: path.join(dataDir, 'values') } };
    const filesDir = path.join(dataDir, 'files');
    const createdFiles = [];
    const managed = createServerWorkflowFileStore({ rootDir: filesDir, workflowName: request.project.id, conversationId: request.conversationId });
    const createFile = async (input) => {
      const file = await managed.createFile(input);
      const previewDir = path.join(filesDir, file.id, 'preview');
      await mkdir(previewDir);
      const previewPath = path.join(previewDir, path.basename(file.name));
      await link(path.join(filesDir, file.id, 'content'), previewPath);
      const reference = { ...file, storage: 'local', url: undefined, path: previewPath };
      await writeFile(path.join(filesDir, file.id, 'metadata.json'), JSON.stringify(reference));
      createdFiles.push(reference);
      if (request.method === 'run') { send('event', { type: 'file_created', file: reference, runId: request.runId }); }
      return reference;
    };
    const readManagedFile = async (id) => {
      if (typeof id !== 'string' || !/^wf_[a-f0-9]{32}$/.test(id)) { throw new Error('Invalid managed file id.'); }
      const reference = JSON.parse(await readFile(path.join(filesDir, id, 'metadata.json'), 'utf8'));
      return { reference, path: reference.path };
    };
    if (request.method === 'resolve') {
      send('result', await resolveLocalWorkflowParams({
        workflowDir: request.project.folderPath,
        entrypointId: request.entrypointId,
        request: request.request,
        storage,
        abortSignal: controller.signal,
      }));
    } else if (request.method === 'run') {
      const report = await runLocalWorkflowWithReport({
        workflowDir: request.project.folderPath,
        args: request.args,
        entrypointId: request.entrypointId,
        conversationId: request.conversationId,
        runId: request.runId,
        storage,
        fileStore: createWorkflowFileStore({ resolveStore: createLocalWorkflowFileStore({ rootDir: filesDir, allowAbsolutePaths: true }), createFile }),
        toolPermissionPolicies: request.toolPermissionPolicies,
        userInput: {
          __workflowResumeRuntimeEventAfterRequestId: request.resumeAfterRequestId,
          getResolvedInput: (id) => {
            const input = request.resolvedInputs?.find((input) => input.requestId === id);
            return input && { ...input, submittedAt: new Date(input.submittedAt), request: input.request && { ...input.request, createdAt: new Date(input.request.createdAt) } };
          },
          requestInput: () => undefined,
        },
        abortSignal: controller.signal,
        onRuntimeEvent: (event) => send('event', event),
      });
      const data = report.result?.data;
      const items = data?.output?.items ?? data?.items ?? report.outputs?.flatMap((entry) => entry.output?.items ?? []) ?? [];
      send('result', { ...report, output: { items }, files: createdFiles });
    } else if (request.method === 'upload') {
      if (!Array.isArray(request.files) || request.files.length > 32) { throw new Error('Too many attachments.'); }
      const references = [];
      for (const file of request.files) {
        if (typeof file.name !== 'string') { throw new Error('Invalid attachment.'); }
        if (typeof file.path === 'string') {
          const info = await stat(file.path);
          if (!info.isFile() || info.size > 50 * 1024 * 1024) { throw new Error('Attachment exceeds 50 MiB or is not a file.'); }
        }
        if (file.data?.length > 70 * 1024 * 1024) { throw new Error('Attachment exceeds 50 MiB.'); }
        const buffer = typeof file.path === 'string' ? await readFile(file.path) : Buffer.from(file.data ?? '', 'base64');
        references.push(await createFile({ name: file.name, mimeType: file.mimeType, buffer }));
      }
      send('result', references);
    } else if (request.method === 'file') {
      send('result', await readManagedFile(request.id));
    } else if (request.method === 'delete-files') {
      for (const id of request.ids ?? []) {
        const file = await readManagedFile(id).catch(() => undefined);
        if (file?.reference.conversationId === request.conversationId) { await rm(path.join(filesDir, id), { recursive: true, force: true }); }
      }
      send('result', { deleted: true });
    } else if (request.method === 'resource') {
      const target = request.target ?? {};
      const rootDir = request.kind === 'knowledge' ? path.join(dataDir, 'values') : path.join(dataDir, 'kv');
      const store = createLocalWorkflowKVStore({ rootDir, storageKind: request.kind === 'knowledge' ? 'persistent_value' : 'kv' });
      const context = request.kind === 'knowledge'
        ? createWorkflowPersistentValueContext({ store, projectId: request.project.id, conversationId: request.conversationId })
        : createWorkflowKVContext({ store, projectId: request.project.id, conversationId: request.conversationId });
      if (request.kind === 'knowledge') {
        send('result', target.documentId ? await getKnowledgeDocument({ persistentValue: context }, target.documentId) : await listKnowledgeDocuments({ persistentValue: context }));
      } else if (target.key) {
        send('result', await (target.scope === 'conversation' ? context.conversation : context).getValue(target.key) ?? null);
      } else {
        send('result', await listLocalWorkflowKVEntries({ rootDir, storageKind: 'kv', projectId: request.project.id, scope: target.scope === 'conversation' ? 'conversation' : 'project', conversationId: target.scope === 'conversation' ? request.conversationId : undefined, pageSize: 100 }));
      }
    } else if (request.method === 'delete-conversation') {
      for (const [storageKind, rootDir] of [['kv', path.join(dataDir, 'kv')], ['persistent_value', path.join(dataDir, 'values')]]) {
        const entries = [];
        let cursor;
        do {
          const page = await listLocalWorkflowKVEntries({ rootDir, storageKind, projectId: request.project.id, scope: 'conversation', conversationId: request.conversationId, pageSize: 100, cursor });
          entries.push(...page.items); cursor = page.nextCursor;
        } while (cursor);
        for (const entry of entries) { await deleteLocalWorkflowKVEntry({ ...entry, rootDir }); }
      }
      for (const directory of await readdir(filesDir).catch(() => [])) {
        if (!/^wf_[a-f0-9]{32}$/.test(directory)) { continue; }
        const file = await readManagedFile(directory).catch(() => undefined);
        if (file?.reference.conversationId === request.conversationId) { await rm(path.join(filesDir, directory), { recursive: true, force: true }); }
      }
      send('result', { deleted: true });
    } else { throw new Error('Unknown runtime method.'); }
  } else { throw new Error('Unknown runtime method.'); }
} catch (error) {
  write(`__STUDIO_WORKFLOW__${JSON.stringify({ kind: 'error', error: error.message, status: error.metadata?.status })}\n`);
  process.exitCode = 1;
} finally {
  if (assistantScopeDirectory) { await rm(assistantScopeDirectory, { recursive: true, force: true }); }
}
