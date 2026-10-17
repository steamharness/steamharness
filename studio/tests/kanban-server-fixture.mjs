import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';

export async function createKanbanTestServer() {
  const files = new Map(), values = new Map(); let authenticatedRequests = 0;
  const profile = { userId: 'kanban-user', email: 'kanban@example.com', displayName: 'Kanban Test' };
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    const success = data => response.end(JSON.stringify({ errCode: 0, data }));
    if (request.url === '/api/auth/login') { request.resume(); success({ authenticated: true, accessToken: 'offline-kanban-identity', apiKey: { id: 'kanban-key' } }); return; }
    if (request.headers.authorization !== 'Bearer offline-kanban-identity') { response.writeHead(401); response.end('{}'); return; }
    authenticatedRequests++;
    if (request.url === '/api/auth/me') { success({ profile, principal: { apiKeyId: 'kanban-key', expiresAt: '2030-01-01T00:00:00Z' } }); return; }
    if (request.url === '/api/ai/usage') { success({ balance: 10, groups: [] }); return; }
    if (request.url === '/api/auth/logout') { request.resume(); success({}); return; }
    if (request.url?.endsWith('/kanban/related-project-revisions')) { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write(`event: snapshot\ndata: ${JSON.stringify({ resolvedTarget: 'project', revisions: [] })}\n\n`); return; }
    if (request.url?.endsWith('/kanban/bridge')) {
      try {
        const chunks = []; for await (const chunk of request) { chunks.push(chunk); } const { call } = JSON.parse(Buffer.concat(chunks).toString());
        if (call.operation === 'kv.getValue') { success(values.get(call.input.key) ?? null); return; }
        if (call.operation === 'kv.setValue') { values.set(call.input.key, call.input.value); success(null); return; }
        if (call.operation === 'files.createFile') {
          const file = { id: `wf_${randomBytes(16).toString('hex')}`, storage: 'server', name: call.input.name, mimeType: call.input.mimeType ?? 'application/octet-stream', size: Buffer.from(call.input.base64, 'base64').length, kind: 'file', createdAt: new Date().toISOString() };
          files.set(file.id, { file, base64: call.input.base64 }); success(file); return;
        }
        if (call.operation === 'files.readFile') { success(files.get(call.input.fileId)); return; }
        if (call.operation === 'files.deleteFile') { success(files.delete(call.input.fileId)); return; }
      } catch (error) { response.writeHead(400); response.end(JSON.stringify({ errCode: 400, errMessage: error.message })); return; }
    }
    response.writeHead(404); response.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { connection: { serverUrl: `http://127.0.0.1:${server.address().port}`, accessToken: 'offline-kanban-identity' }, profile, files, values,
    get authenticatedRequests() { return authenticatedRequests; },
    close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}
