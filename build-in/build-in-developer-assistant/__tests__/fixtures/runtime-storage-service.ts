import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createMemoryRuntimePersistence, SnapshotMemoryStorage } from 'steamharness/runtime-storage';

/** Explicit HTTP reference service for worker tests; the real repository is covered with Docker. */
export function runtimeStorageService(options: { account?: (authorization: string) => string; leaseDurationMs?: number } = {}) {
  const workspaces = new Map<string, any>(), sessions = new Map<string, any>();
  const usageEntries = new Map<string, any>();
  const durationMs = options.leaseDurationMs ?? 30_000;
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const url = new URL(request.url!, 'http://localhost');
    if (!url.pathname.startsWith('/api/runtime-storage/')) return false;
    const account = options.account?.(request.headers.authorization ?? '') ?? request.headers.authorization ?? '';
    const send = (data: unknown) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ errCode: 0, errMessage: '', data: data ?? null })); };
    const missing = () => { throw Object.assign(new Error('Runtime storage not found'), { code: 'RUNTIME_STORAGE_NOT_FOUND' }); };
    try {
      let body: any = {};
      if (request.method === 'POST') { let raw = ''; for await (const chunk of request) raw += chunk; body = JSON.parse(raw); }
      const parts = url.pathname.slice('/api/runtime-storage/'.length).split('/');
      if (parts[0] === 'workspaces' && (!parts[1] || parts[1] === 'resolve')) {
        const identity = JSON.stringify([account, body]);
        let workspace = [...workspaces.values()].find(value => value.identity === identity);
        if (!workspace) { workspace = { identity, account, view: { id: randomUUID(), ...body }, backend: createMemoryRuntimePersistence() }; workspaces.set(workspace.view.id, workspace); }
        send(workspace.view); return true;
      }
      if (parts[0] === 'workspaces') {
        const workspace = workspaces.get(parts[1]); if (!workspace || workspace.account !== account) missing();
        if (!parts[2]) send(workspace.view);
        else if (parts[2] === 'history') send(await workspace.backend.list(parts[3]));
        else if (parts[2] === 'agent-sessions') send([...sessions.values()].filter(value => !value.deleted && value.workspace === workspace && value.key.startsWith(url.searchParams.get('prefix')!)).map(value => value.key));
        else if (parts[2] === 'snapshot') {
          const session = [...sessions.values()].find(value => !value.deleted && value.workspace === workspace && value.key === url.searchParams.get('sessionKey')); if (!session) missing(); send(session.storage.snapshot());
        } else if (parts[2] === 'sessions' && parts[3] === 'open') {
          let session = [...sessions.values()].find(value => value.workspace === workspace && value.key === body.sessionKey);
          if (!session) { session = { id: randomUUID(), workspace, key: body.sessionKey, fence: 0, storage: new SnapshotMemoryStorage(), receipts: new Map() }; sessions.set(session.id, session); }
          if (session.deleted) missing();
          if (session.owner && session.owner !== body.ownerToken && session.expires > Date.now()) throw Object.assign(new Error('Another execution owner'), { code: 'RUNTIME_STORAGE_OWNER_CONFLICT' });
          if (session.owner !== body.ownerToken || session.expires <= Date.now()) { await session.lease?.close(); session.fence++; if (session.key.startsWith('host:')) session.lease = await workspace.backend.acquire(session.key.slice(5)); }
          session.owner = body.ownerToken; session.expires = Date.now() + durationMs;
          send({ sessionId: session.id, fence: session.fence, durationMs, expiresAt: new Date(session.expires).toISOString() });
        } else missing();
        return true;
      }
      const session = sessions.get(parts[1]); if (!session || session.workspace.account !== account) missing();
      if (session.owner !== body.ownerToken || session.fence !== body.fence || session.expires <= Date.now()) throw Object.assign(new Error('Lease lost'), { code: 'RUNTIME_STORAGE_LEASE_LOST' });
      const op = body.operation, storage = session.storage;
      const mutable = ['commit', 'mintId', 'history.write', 'history.delete', 'usage', 'snapshot.import', 'session.delete'].includes(op.kind);
      if (mutable && session.receipts.has(op.requestId)) { send(session.receipts.get(op.requestId)); return true; }
      let result;
      switch (op.kind) {
        case 'renew': session.expires = Date.now() + durationMs; result = { sessionId: session.id, fence: session.fence, durationMs, expiresAt: new Date(session.expires).toISOString() }; break;
        case 'release': await session.lease?.close(); session.lease = undefined; session.owner = undefined; break;
        case 'history.write': result = await session.lease.write(op.record); break;
        case 'history.delete': await session.lease.delete(op.record); break;
        case 'usage': await session.lease.usage(op.entry); usageEntries.set(op.entry.id, op.entry); break;
        case 'snapshot.import': if (storage.snapshot().commits.length) throw new Error('Destination exists'); session.storage = new SnapshotMemoryStorage(op.snapshot); break;
        case 'session.delete': session.deleted = true; session.storage = new SnapshotMemoryStorage(); break;
        case 'commit': result = await storage.commit(op.writes, {} as never); break;
        case 'mintId': result = await storage.mintId(); break;
        case 'conversation': result = await storage.conversation(op.id, {} as never); break;
        case 'task': result = await storage.task(op.id, {} as never); break;
        case 'submission': result = await storage.submission(op.id, {} as never); break;
        case 'entry': result = await storage.entry(op.id, {} as never); break;
        case 'head': result = await storage.findLatestHeadMarker(op.conversationId, op.atOrBeforeEntryId, {} as never); break;
        case 'conversations': result = await storage.scanConversations(op.query, op.limit, op.cursor, {} as never); break;
        case 'entries': result = await storage.scanEntries(op.query, op.limit, op.cursor, {} as never); break;
        case 'tasks': result = await storage.scanTasks(op.query, op.limit, op.cursor, {} as never); break;
        case 'submissions': result = await storage.scanSubmissions(op.query, op.limit, op.cursor, {} as never); break;
        case 'submissionByRequest': result = await storage.submissionByRequest(op.conversationId, op.requestId, {} as never); break;
        case 'findDocument': result = await storage.findDocument(op.address, op.at, {} as never); break;
        case 'document': result = await storage.document(op.id, op.at, {} as never); break;
        case 'documents': result = await storage.scanDocuments(op.query, op.limit, op.cursor, {} as never); break;
        default: throw new Error(`Unsupported test operation ${op.kind}`);
      }
      if (mutable) session.receipts.set(op.requestId, result);
      send(result);
    } catch (error) {
      const code = (error as any).code ?? 'RUNTIME_STORAGE_INVALID_REQUEST'; response.statusCode = code === 'RUNTIME_STORAGE_NOT_FOUND' ? 404 : code === 'RUNTIME_STORAGE_INVALID_REQUEST' ? 400 : 409;
      response.end(JSON.stringify({ errCode: response.statusCode, errMessage: (error as Error).message, data: { code } }));
    }
    return true;
  };
  return { handle, async start() {
    const server = createServer((request, response) => {
      if (request.url === '/fixture/usage') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify([...usageEntries.values()])); return; }
      void handle(request, response).then(handled => {
      if (!handled) { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ errCode: 0, errMessage: '', data: { profile: { userId: 'runtime-test', email: 'runtime@example.test', displayName: 'Runtime' } } })); }
    }); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return { serverUrl: `http://127.0.0.1:${(server.address() as any).port}`, accessToken: 'runtime-test-token', close: () => new Promise<void>(resolve => server.close(() => resolve())) };
  } };
}
