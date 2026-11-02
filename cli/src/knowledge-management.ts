import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { bindProjectKnowledgeBase } from 'steamharness';
import { resolveProjectDeclarationEntrySync } from '@steamharness/project-manifest/node';
import { parseDatabaseManagementArgs, databaseManagementRequest, readDatabaseRequestInput, databaseListQuery } from './database-management';

export async function manageKnowledgeBases(argv: string[]): Promise<number> {
  const { positional: [command, ...args], options } = await parseDatabaseManagementArgs(argv.map(arg => arg === '--knowledge-base' ? '--database' : arg));
  const request = (endpoint: string, method = 'GET', body?: unknown) => databaseManagementRequest(options, endpoint, method, body, 'knowledge-bases');
  const output = (value: unknown) => process.stdout.write(JSON.stringify(value ?? null, null, 2) + '\n');
  const uuid = (value?: string) => { if (!value || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)) throw new Error('Specify a knowledge base UUID.'); return value.toLowerCase(); };
  if (command === 'create' && args.length === 1) { output(await request('', 'POST', { name: args[0], requestId: options.requestId ? uuid(options.requestId) : randomUUID() })); return 0; }
  if (command === 'list' && !args.length) { output(await request(databaseListQuery(options))); return 0; }
  if (command === 'grant' && args.length === 1 && options.user && ['read', 'write'].includes(options.mode ?? '')) { output(await request(`/${uuid(args[0])}/grants`, 'POST', { userId: options.user, mode: options.mode })); return 0; }
  if (command === 'grants' && args.length === 1) { output(await request(`/${uuid(args[0])}/grants`)); return 0; }
  if (command === 'revoke' && args.length === 1 && options.user) { output(await request(`/${uuid(args[0])}/grants/${encodeURIComponent(options.user)}`, 'DELETE')); return 0; }
  if (['bind', 'unbind', 'bindings'].includes(command) && args.length <= 1) {
    const root = path.resolve(args[0] ?? '.'), declaration = resolveProjectDeclarationEntrySync(root, options.entry);
    const consumer = { projectId: declaration.manifest.projectId, entryId: declaration.registration.entryId, alias: options.alias };
    if (command === 'bindings') { output(await request(`/bindings?projectId=${consumer.projectId}&entryId=${consumer.entryId}`)); return 0; }
    if (command === 'unbind') { output(await request('/bindings', 'DELETE', consumer)); return 0; }
    if (options.mode !== undefined && !['read', 'write'].includes(options.mode)) throw new Error('Choose --mode read or write.');
    const knowledgeBaseId = uuid(options.database);
    const result = await request('/bindings', 'POST', { ...consumer, knowledgeBaseId, ...(options.mode ? { mode: options.mode } : {}) });
    await bindProjectKnowledgeBase(root, consumer.entryId, consumer.alias, knowledgeBaseId);
    output(result); return 0;
  }
  if (command === 'operation' && args.length === 2) {
    const input = await readDatabaseRequestInput({}, 70 * 1024 * 1024);
    output(await request(`/${uuid(args[0])}/manage`, 'POST', { operation: args[1], input })); return 0;
  }
  throw new Error('Use knowledge create/list/grants/grant/revoke, bind/unbind/bindings [directory] --knowledge-base <id> --alias <alias>, or operation <id> <operation> < input.json.');
}
