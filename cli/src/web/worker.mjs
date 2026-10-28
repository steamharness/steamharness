import { readFileSync } from 'node:fs';
import { readFile, writeFile, readdir, rm, stat, mkdir, link, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { register } from 'tsx/esm/api';
import { resolve } from 'import-meta-resolve';
import { pathToFileURL, fileURLToPath } from 'node:url';
let ts;
let assistantScopeDirectory;
let agentHost;
let ownerDisconnected = false;


const write = process.stdout.write.bind(process.stdout);
const send = (kind, value) => write(`__STEAMHARNESS_WEB__${JSON.stringify({ kind, value })}\n`);
console.log = console.error;
const controller = new AbortController();
process.on('SIGTERM', () => { agentHost?.close(); controller.abort(new Error('Stopped.')); });
process.on('SIGINT', () => { agentHost?.close(); controller.abort(new Error('Stopped.')); });
process.on('disconnect', () => {
  ownerDisconnected = true;
  if (agentHost) agentHost.suspend();
  else controller.abort(new Error('Owner disconnected.'));
});


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
        if (name === 'getServerLLMCredentials') { required = true; return; }
      }
      ts.forEachChild(node, visit);
    };
    visit(source); if (required) { return true; }
  }
  return false;
}

try {
  // Pipe requests can arrive in several chunks, including inside a UTF-8 sequence.
  const chunks = [];
  for await (const chunk of process.stdin) { chunks.push(chunk); }
  const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const projectDir = path.resolve(request.project?.folderPath ?? request.paths?.[0]);
  const runtimeProjectDir = path.resolve(request.runtimeProjectDir ?? projectDir);
  let coreUrl;
  // An assistant's executor is separate from the project that owns its runtime.
  try { coreUrl = resolve('steamharness', pathToFileURL(path.join(runtimeProjectDir, 'package.json')).href); }
  catch { throw new Error('Install steamharness in the project before starting steamharness web.'); }
  const harnessPath = fileURLToPath(coreUrl);
  let manifestDir = path.dirname(harnessPath);
  let coreManifest;
  for (let depth = 0; depth < 12; depth++) {
    try {
      const manifest = JSON.parse(readFileSync(path.join(manifestDir, 'package.json'), 'utf8'));
      if (manifest.name === 'steamharness') { coreManifest = manifest; break; }
    } catch {}
    const parent = path.dirname(manifestDir);
    if (parent === manifestDir) break;
    manifestDir = parent;
  }
  if (!coreManifest) { throw new Error('Cannot identify the project steamharness version.'); }
  ts = (await import(resolve('typescript', coreUrl))).default;
  const tsconfig = path.join(projectDir, 'tsconfig.json');
  register({ tsconfig: await stat(tsconfig).then(() => tsconfig, () => false) });
  const {  inspectLocalProjectStructure, resolveLocalProjectParams, runLocalProjectWithReport, createKanbanArtifactEntryPath,
  createLocalProjectFileStore, createServerProjectFileStore, createProjectFileStore,
  createLocalProjectKVStore, createProjectKVContext, createProjectPersistentValueContext,
  listLocalProjectKVEntries, deleteLocalProjectKVEntry, getKnowledgeDocument, listKnowledgeDocuments,
} = await import(coreUrl);
  const core = await import(coreUrl);
  // IPC callbacks execute outside the async scope that registered the listener.
  // Re-enter the same run snapshot for every command and its asynchronous work.
  const withSettings = run => request.userSettings !== undefined && typeof core.withUserSettings === 'function'
    ? core.withUserSettings(request.userSettings, run) : run();
  const execute = async () => {
  const language = /^zh/i.test(process.env[core.STEAMHARNESS_RUNTIME_LOCALE_ENV] ?? process.env.STEAMHARNESS_LOCALE ?? 'en') ? 'zh-CN' : 'en';
  const { readProjectInfo, readProjectCardMetadataFromPackageJson, resolveProjectName, runKanbanDataCall } = await import(new URL(import.meta.url.includes('/src/web/') ? './kanban-data.ts' : './kanban-data.mjs', import.meta.url));
  if (request.method === 'inspect') {
    const projects = [];
    const errors = [];
    for (const folderPath of request.paths) {
      try {
        const pkg = JSON.parse(readFileSync(path.join(folderPath, 'package.json'), 'utf8'));
        const manifest = await core.readProjectManifestFromDirectory(folderPath);
        for (const registration of manifest.entries.filter(entry => !request.entryId || entry.entryId === request.entryId)) {
        const structure = inspectLocalProjectStructure({ projectDir: folderPath, entryId: registration.entryId });
        const projectInfo = readProjectInfo(pkg);
        const parameters = (entry) => ({ fields: entry.params ?? [], paramLayout: entry.paramLayout, paramResolver: entry.paramResolver, tools: entry.tools, tokenUsage: entry.tokenUsage });
        projects.push({
          id: manifest.projectId,
          entryId: registration.entryId, entryRoot: path.resolve(folderPath, registration.root),
          aggregateName: resolveProjectName(pkg.name, projectInfo, language),
          entries: manifest.entries, defaultEntry: manifest.defaultEntry, databases: registration.databases,
          runtime: { harnessVersion: coreManifest.version, harnessPath },
          folderPath,
          name: registration.name,
          manifest: Object.fromEntries(['name', 'version', 'description'].filter(key => typeof pkg[key] === 'string').map(key => [key, pkg[key]])),
          projectType: structure.projectType,
          projectCard: registration.projectCard,
          aggregateProjectCard: readProjectCardMetadataFromPackageJson(pkg, manifest.entries.find(entry => entry.entryId === manifest.defaultEntry).type),
          ...parameters(structure),
          entrypoints: (structure.entrypoints ?? []).map((entry) => ({ id: entry.id, title: entry.title, group: entry.group, description: entry.description, execution: entry.execution, ...parameters(entry) })),
          definitions: structure.definitions,
          execution: structure.execution,
          diagnostics: structure.diagnostics,
          defaultEntrypoint: structure.defaultEntrypoint,
          artifactEntry: structure.kanban ? `${registration.root === "." ? "" : registration.root + "/"}${createKanbanArtifactEntryPath(structure.kanban)}` : undefined,
          kanban: structure.kanban ? { artifactDir: structure.kanban.artifactDir, entry: structure.kanban.entry } : undefined,
          projectInfo,
          conversation: structure.conversation,
          requiresLogin: await requiresSystemAi(path.resolve(folderPath, registration.root)),
        });
        }
      } catch (error) {
        const details = (Array.isArray(error.metadata?.violations) ? error.metadata.violations : []).map(violation => violation?.message).filter(message => typeof message === 'string');
        errors.push(`${folderPath}: ${[error.message, ...new Set(details)].join('\n')}`);
      }
    }
    send('result', { projects, errors });
  } else if (request.project?.folderPath) {
    const projectKey = createHash('sha256').update(request.project.assistant ? `assistant:${request.project.id}:${request.project.assistant.workdir}` : request.project.folderPath).digest('hex').slice(0, 24);
    const { projectDataDirectory } = await import(new URL(import.meta.url.includes('/src/web/') ? './project-data-directory.ts' : './project-data-directory.mjs', import.meta.url));
    const dataDir = request.project.assistant ? path.join(request.storageDir, projectKey)
      : await projectDataDirectory(request.storageDir, request.project.folderPath, request.project.id, request.project.entryId);
    if (request.project.assistant) {
      const assistant = request.project.assistant;
      const primary = assistant.roots.find(root => root.folderPath === assistant.workdir);
      if (!primary) { throw new Error('Assistant working directory is not an opened workspace folder.'); }
      await mkdir(dataDir, { recursive: true });
      assistantScopeDirectory = await mkdtemp(path.join(dataDir, 'scope-'));
      const manifestPath = path.join(assistantScopeDirectory, 'workspace.json');
      await writeFile(manifestPath, JSON.stringify({ schemaVersion: 2, primaryTarget: { kind: 'folder', folderId: primary.uri }, warnings: [],
        roots: assistant.roots.map(root => ({ target: { kind: 'folder', folderId: root.uri }, name: root.name, rootPath: root.folderPath, role: root === primary ? 'primary' : 'linked', depth: root === primary ? 0 : 1 })) }));
      process.env.STEAMHARNESS_DEVELOPER_ASSISTANT_HOST = 'vscode';
      process.env.STEAMHARNESS_DEVELOPER_ASSISTANT_WORKDIR = assistant.workdir;
      process.env.STEAMHARNESS_DEVELOPER_ASSISTANT_WORKSPACE_MANIFEST = manifestPath;
    }
    const storage = { host: 'local', local: { kvStoreDir: path.join(dataDir, 'kv'), persistentValueStoreDir: path.join(dataDir, 'values'), agentStoreDir: path.join(dataDir, 'agents') } };
    const filesDir = path.join(dataDir, 'files');
    const createdFiles = [];
    const managed = createServerProjectFileStore({ rootDir: filesDir, projectName: request.project.id, conversationId: request.conversationId });
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
    if (request.method === 'kanban-bridge') {
      send('result', await runKanbanDataCall(core, request.project, request.storageDir, request.call));
    } else if (request.method === 'resolve') {
      send('result', await resolveLocalProjectParams({
        projectDir: request.project.folderPath,
        entryId: request.project.entryId,
        actor: request.actor,
        entrypointId: request.entrypointId,
        request: request.request,
        configuration: request.configuration,
        storage,
        abortSignal: controller.signal,
      }));
    } else if (request.method === 'run') {
      const configuration = await (await core.createLocalProjectConfigurationStore(projectDir, { entryId: request.project.entryId })).snapshot({runId:request.configurationRunId ?? request.runId,configuration:request.configuration,requireExisting:request.resumeConfiguration});
      let agentControl;
      let runFinished = false;
      let runFailure;
      if (request.project.conversation?.durable?.enabled) {
        const agent = await import(resolve('steamharness/agent', pathToFileURL(path.join(runtimeProjectDir, 'package.json')).href));
        agentHost = agent.createAgentSessionHost(request.conversationId, { resume: request.resumeAgent === true });
        agentControl = async ({ command, scopeId, attachments }) => core.withProjectConfiguration(configuration, async () => {
          if (typeof scopeId !== 'string' || !command || typeof command.requestId !== 'string') throw new Error('Invalid agent command.');
          if(command.type!=='cancel')await core.assertProjectConfigurationAccess(projectDir,configuration, request.project.entryId);
          let prepared = command;
          if (attachments?.length) {
            if (command.type !== 'submit' || attachments.length > 32) throw new Error('Invalid agent attachments.');
            const images = [];
            for (const attachment of attachments) {
              const file = await readManagedFile(attachment.id);
              if (file.reference.conversationId !== scopeId || file.reference.kind !== 'image') throw new Error('The attachment does not belong to this conversation.');
              images.push({ data: (await readFile(file.path)).toString('base64'), mimeType: file.reference.mimeType });
            }
            prepared = { ...command, images };
          }
          while (true) {
            try { return await agent.controlAgentSession(request.conversationId, prepared); }
            catch (error) {
              if (error.code !== 'AGENT_NOT_READY') throw error;
              if (controller.signal.aborted) throw Object.assign(new Error('The agent owner disconnected.'), { code: 'STEAMHARNESS_WORKER_INTERRUPTED' });
              if (runFinished) throw Object.assign(new Error(runFailure ?? 'The workflow ended without an active agent session.'), { code: 'AGENT_SESSION_ENDED' });
              await new Promise(resolve => setTimeout(resolve, 25));
            }
          }
        },projectDir,request.project.entryId);
        process.on('message', async message => {
          if (message?.type !== 'agent-control') return;
          try {
            const receipt = await withSettings(() => agentControl(message));
            process.send?.({ type: 'agent-receipt', id: message.id, receipt });
          } catch (error) { process.send?.({ type: 'agent-receipt', id: message.id, error: error.message, code: error.code }); }
        });
      }
      const running = runLocalProjectWithReport({
        configuration,
        configurationRunId: request.configurationRunId,
        projectDir: request.project.folderPath,
        entryId: request.project.entryId,
        actor: request.actor,
        args: request.args,
        entrypointId: request.entrypointId,
        conversationId: request.conversationId,
        runId: request.runId,
        storage,
        fileStore: createProjectFileStore({ resolveStore: createLocalProjectFileStore({ rootDir: filesDir, allowAbsolutePaths: true }), createFile }),
        toolPermissionPolicies: request.toolPermissionPolicies,
        userInput: {
          __projectResumeRuntimeEventAfterRequestId: request.resumeAfterRequestId,
          getResolvedInput: (id) => {
            const input = request.resolvedInputs?.find((input) => input.requestId === id);
            return input && { ...input, submittedAt: new Date(input.submittedAt), request: input.request && { ...input.request, createdAt: new Date(input.request.createdAt) } };
          },
          requestInput: () => undefined,
        },
        abortSignal: controller.signal,
        onRuntimeEvent: (event) => send('event', event),
      }).then(report => {
        if (report.status === 'failed') runFailure = report.result?.error?.message ?? report.result?.data?.errMessage;
        return report;
      }, error => { runFailure = error.message; throw error; }).finally(() => { runFinished = true; });
      const initialCommands = (request.agentCommands ?? []).map(async command => {
        try { const receipt = await agentControl?.(command); send('event', { type: 'agent_command_receipt', receipt }); }
        catch (error) { send('event', { type: 'agent_command_failed', requestId: command.command.requestId, targetId: command.command.targetId, message: error.message, code: error.code }); }
      });
      const report = await running;
      await Promise.all(initialCommands);
      agentHost?.close();
      const data = report.result?.data;
      const outputItems = data?.output?.items ?? data?.items ?? report.outputs?.flatMap((entry) => entry.output?.items ?? []) ?? [];
      const items = request.project.projectType === 'workflow'
        ? [...new Map(outputItems.map((item, index) => [item.id ?? `item-${index}`, item])).values()]
        : outputItems;
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
      if (typeof target.database !== 'string') throw new Error('A declared database alias is required.');
      const registration = core.selectProjectEntry(await core.readProjectManifestFromDirectory(projectDir), request.project.entryId);
      const local = core.createLocalDatabaseResolver();
      const connection = core.databaseConnectionFromEnv();
      const remote = connection && core.createRemoteDatabaseResolver(connection);
      const databases = core.createDatabasesContext({ projectId: request.project.id, entryId: request.project.entryId, requirements: registration.databases, conversationId: request.conversationId, resolver: { async resolve(requirement, consumer) { return await local.resolve(requirement, consumer) ?? remote?.resolve(requirement, consumer); } } });
      const database = databases.get(target.database);
      if (request.kind === 'knowledge') send('result', target.documentId ? await database.knowledge.getDocument(target.documentId) ?? null : await database.knowledge.listDocuments({ pageSize: 100 }));
      else if (target.key) send('result', await (target.scope === 'conversation' ? database.kv.conversation : database.kv).getValue(target.key) ?? null);
      else throw new Error('A database key is required.');
    } else if (request.method === 'cancel-conversation' || request.method === 'delete-conversation') {
      const { cancelAgentConversation } = await import(resolve('steamharness/agent', coreUrl));
      await cancelAgentConversation({ agentStoreDir: path.join(dataDir, 'agents'), conversationId: request.conversationId });
      if (request.method === 'cancel-conversation') { send('result', { cancelled: true }); }
      else {
      for (const [storageKind, rootDir] of [['kv', path.join(dataDir, 'kv')], ['persistent_value', path.join(dataDir, 'values')]]) {
        const entries = [];
        let cursor;
        do {
          const page = await listLocalProjectKVEntries({ rootDir, storageKind, projectId: `${request.project.id}:${request.project.entryId}`, scope: 'conversation', conversationId: request.conversationId, pageSize: 100, cursor });
          entries.push(...page.items); cursor = page.nextCursor;
        } while (cursor);
        for (const entry of entries) { await deleteLocalProjectKVEntry({ ...entry, rootDir }); }
      }
      for (const directory of await readdir(filesDir).catch(() => [])) {
        if (!/^wf_[a-f0-9]{32}$/.test(directory)) { continue; }
        const file = await readManagedFile(directory).catch(() => undefined);
        if (file?.reference.conversationId === request.conversationId) { await rm(path.join(filesDir, directory), { recursive: true, force: true }); }
      }
      const agentDirectory = path.join(dataDir, 'agents', createHash('sha256').update(request.conversationId).digest('hex'));
      await rm(agentDirectory, { recursive: true, force: true });
      send('result', { deleted: true });
      }
    } else { throw new Error('Unknown runtime method.'); }
  } else { throw new Error('Unknown runtime method.'); }
  };
  await withSettings(execute);
} catch (error) {
  write(`__STEAMHARNESS_WEB__${JSON.stringify({ kind: 'error', error: error.message, code: error.code, metadata: error.metadata, status: error.metadata?.status })}\n`);
  process.exitCode = 1;
} finally {
  agentHost?.close();
  if (assistantScopeDirectory) { await rm(assistantScopeDirectory, { recursive: true, force: true }); }
  // Cleanup has joined the durable scheduler and released its storage owner.
  // A disconnected worker has no further jobs; an unfinished HTTP body must
  // not keep this orphan alive and prevent the next owner from taking over.
  if (ownerDisconnected) write('', () => process.exit(process.exitCode ?? 0));
  else if (process.connected) process.disconnect();
}
