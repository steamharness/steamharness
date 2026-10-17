import { readFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolve } from 'import-meta-resolve';

const PAGE_SIZE = 30;

export async function runResourceRequest(request, core, fetcher = fetch) {
  if (!['kv', 'knowledge'].includes(request.input.kind) || !['list', 'get', 'save', 'delete'].includes(request.input.action)) { throw new Error('Invalid resource operation.'); }
  if (request.input.scope && !['project', 'conversation'].includes(request.input.scope)) { throw new Error('Invalid KV scope.'); }
  if (request.input.source === 'server' && request.input.projectId) {
    if (!['list', 'get'].includes(request.input.action)) { throw new Error('This resource preview is read-only.'); }
    const remote = { ...request, project: { id: request.input.projectId } };
    const result = await serverRequest(remote, fetcher);
    if (request.input.action !== 'list') { return result; }
    if (request.input.kind === 'knowledge' && request.input.query?.trim()) {
      return { items: result.matches.map(match => ({ id: `${match.documentId}:${match.lineNumber}`, documentId: match.documentId, title: match.title,
        preview: match.line, lineNumber: match.lineNumber })), total: result.totalMatches, hasMore: result.hasMore, nextCursor: result.nextCursor,
        source: 'server', sources: ['server'], search: true };
    }
    return { ...result, source: 'server', sources: ['server'], items: result.items.map(item => request.input.kind === 'kv'
      ? { ...item, id: JSON.stringify([item.scope, item.conversationId ?? '', item.key]), title: item.key, preview: item.valuePreview }
      : { ...item, documentId: item.id, preview: item.markdownPreview }) };
  }
  const folderPath = await realpath(request.project.folderPath);
  const manifest = JSON.parse(await readFile(path.join(folderPath, 'package.json'), 'utf8'));
  if (manifest.id !== request.project.id) { throw new Error('The project identity has changed. Refresh the project list.'); }
  const mode = manifest.workflowCode?.projectInfo?.dataStorage?.mode;
  const sources = mode === 'server' ? ['server'] : mode === 'local' ? ['local'] : ['local', 'server'];
  const input = request.input;
  const source = input.source ?? sources[0];
  if (!sources.includes(source)) { throw Object.assign(new Error('The project does not allow this storage location.'), { source: sources[0], sources }); }
  try {
    if (input.action === 'list') {
      const page = await (source === 'server' ? serverRequest(request, fetcher) : localRequest(request, core, folderPath));
      if (input.kind === 'knowledge' && input.query?.trim()) {
        return { items: page.matches.map(match => ({ id: `${match.documentId}:${match.lineNumber}`, documentId: match.documentId, title: match.title,
          preview: match.line, lineNumber: match.lineNumber })), total: page.totalMatches, hasMore: page.hasMore, nextCursor: page.nextCursor, source, sources, search: true };
      }
      return { ...page, source, sources, items: page.items.map(item => input.kind === 'kv'
        ? { ...item, id: JSON.stringify([item.scope, item.conversationId ?? '', item.key]), title: item.key, preview: item.valuePreview }
        : { ...item, documentId: item.id, preview: item.markdownPreview }) };
    }
    return await (source === 'server' ? serverRequest(request, fetcher) : localRequest(request, core, folderPath));
  } catch (error) { throw Object.assign(error, { source, sources }); }
}

async function localRequest(request, core, folderPath) {
  const input = request.input;
  // Use the same canonical project key and storage roots as the project CLI.
  const projectKey = createHash('sha256').update(folderPath).digest('hex').slice(0, 24);
  const dataDir = path.join(request.storageDir, projectKey);
  const rootDir = path.join(dataDir, input.kind === 'kv' ? 'kv' : 'values');
  const storageKind = input.kind === 'kv' ? 'kv' : 'persistent_value';
  const projectId = request.project.id;
  const store = core.createLocalWorkflowKVStore({ rootDir, storageKind });
  if (input.kind === 'kv') {
    if (input.action === 'list') {
      return core.listLocalWorkflowKVEntries({ rootDir, storageKind, projectId, pageSize: PAGE_SIZE, cursor: input.cursor,
        scope: input.scope, conversationId: input.conversationId || undefined, query: input.query || undefined });
    }
    if (typeof input.key !== 'string' || !input.key.trim()) { throw new Error('A KV key is required.'); }
    const entry = { storageKind, projectId, scope: input.scope ?? 'project', conversationId: input.conversationId, key: input.key };
    if (input.action === 'get') { return await core.getLocalWorkflowKVEntry({ rootDir, ...entry }) ?? null; }
    if (input.action === 'delete') { return { removed: await core.deleteLocalWorkflowKVEntry({ rootDir, ...entry }) }; }
    if (input.value === undefined) { throw new Error('A JSON value is required.'); }
    await store.withNamespaceLock(entry, async () => {
      if (input.create && await store.getValue(entry) !== undefined) { throw new Error('This key already exists.'); }
      await store.setValue({ ...entry, value: input.value });
    });
    return core.getLocalWorkflowKVEntry({ rootDir, ...entry });
  }
  const context = { persistentValue: core.createWorkflowPersistentValueContext({ store, projectId }) };
  if (input.action === 'list') {
    return input.query?.trim()
      ? core.searchKnowledgeDocuments(context, { query: input.query.trim(), pageSize: PAGE_SIZE, cursor: input.cursor })
      : core.listKnowledgeDocumentPage(context, { pageSize: PAGE_SIZE, cursor: input.cursor });
  }
  if (input.action === 'get') { return await core.getKnowledgeDocument(context, input.documentId) ?? null; }
  if (input.action === 'delete') { return { removed: await core.deleteKnowledgeDocument(context, input.documentId) }; }
  return input.create
    ? core.createKnowledgeDocument(context, { title: input.title, markdown: input.markdown })
    : core.editKnowledgeDocument(context, { id: input.documentId, title: input.title, markdown: input.markdown });
}

async function serverRequest(request, fetcher) {
  const { connection, project, input } = request;
  if (!connection?.accessToken) { throw Object.assign(new Error('Please sign in to Workflow Server.'), { status: 401 }); }
  const prefix = `${connection.serverUrl.replace(/\/+$/, '')}/api/workflows/${encodeURIComponent(project.id)}`;
  const query = new URLSearchParams();
  let suffix, method = 'GET', body;
  if (input.kind === 'kv') {
    if (input.action === 'save') { throw new Error('Server KV values are managed by the project runtime.'); }
    suffix = input.action === 'list' ? '/kv' : '/kv/entry';
    if (input.scope) { query.set('scope', input.scope); }
    else if (input.action !== 'list') { query.set('scope', 'project'); }
    if (input.conversationId) { query.set('conversationId', input.conversationId); }
    if (input.key) { query.set('key', input.key); }
    if (input.query) { query.set('q', input.query); }
    if (input.action === 'delete') { method = 'DELETE'; }
  } else {
    suffix = '/knowledge-documents';
    if (input.action === 'list' && input.query?.trim()) { suffix += '/search'; query.set('q', input.query.trim()); }
    else if (!input.create && input.action !== 'list') {
      if (!input.documentId) { throw new Error('A document ID is required.'); }
      suffix += `/${encodeURIComponent(input.documentId)}`;
    }
    if (input.action === 'delete') { method = 'DELETE'; }
    if (input.action === 'save') { method = input.create ? 'POST' : 'PUT'; body = { title: input.title, markdown: input.markdown }; }
  }
  if (input.action === 'list') { query.set('pageSize', String(PAGE_SIZE)); if (input.cursor) { query.set('cursor', input.cursor); } }
  const response = await fetcher(`${prefix}${suffix}${query.size ? `?${query}` : ''}`, {
    method, redirect: 'error', signal: AbortSignal.timeout(15_000),
    headers: { Authorization: `Bearer ${connection.accessToken}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const payload = await response.json();
  if (!response.ok || payload.errCode !== 0) { throw Object.assign(new Error(payload.errMessage || `Workflow Server request failed (${response.status}).`), { status: response.status }); }
  return payload.data ?? null;
}

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) { chunks.push(chunk); }
  const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const write = process.stdout.write.bind(process.stdout);
  console.log = console.error;
  try {
    const core = request.input.source === 'server' ? undefined : await import(resolve('workflow-code', pathToFileURL(path.join(request.project.folderPath, 'package.json')).href));
    const value = await runResourceRequest(request, core);
    write(`${JSON.stringify({ value })}\n`);
  } catch (error) {
    const message = String(error.message).replaceAll(request.connection?.accessToken || '\0', '[redacted]');
    write(`${JSON.stringify({ error: message, status: error.status, source: error.source, sources: error.sources })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) { await main(); }
