import { createServer } from 'node:http';

export async function createKanbanTestServer() {
  let authenticatedRequests = 0;
  const profile = { userId: 'kanban-user', email: 'kanban@example.com', displayName: 'Kanban Test' };
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    const success = data => response.end(JSON.stringify({ errCode: 0, errMessage: '', data }));
    if (request.url === '/api/auth/login') {
      request.resume();
      success({ authenticated: true, accessToken: 'offline-kanban-identity', apiKey: { id: 'kanban-key' } });
      return;
    }
    if (request.headers.authorization !== 'Bearer offline-kanban-identity') {
      response.writeHead(401);
      response.end('{}');
      return;
    }
    authenticatedRequests++;
    if (request.url === '/api/auth/me') {
      success({ profile, principal: { apiKeyId: 'kanban-key', expiresAt: '2030-01-01T00:00:00Z' } });
      return;
    }
    if (request.url === '/api/ai/usage') { success({ balance: 10, groups: [] }); return; }
    if (request.url === '/api/auth/logout') { request.resume(); success({}); return; }
    response.writeHead(404);
    response.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    connection: { serverUrl: `http://127.0.0.1:${server.address().port}`, accessToken: 'offline-kanban-identity' },
    profile,
    get authenticatedRequests() { return authenticatedRequests; },
    close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}
