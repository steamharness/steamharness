/** Trusted Studio host operations. SQL credentials never enter webviews. */
export async function runDatabaseHostRequest(request) {
  if (!request.connection?.accessToken) throw new Error('Sign in to SteamHarness Server to manage database resources.');
  if (!request.input || typeof request.input !== 'object') throw new Error('Invalid database management request.');
  const url = new URL(request.connection.serverUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid Server address.');
  if (request.input.action === 'bindings') {
    const { projectId, entryId } = request.input;
    if (typeof projectId !== 'string' || !/^[0-9a-f-]{36}$/.test(projectId) || typeof entryId !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(entryId)) throw new Error('Invalid project entry.');
    const response = await fetch(`${request.connection.serverUrl.replace(/\/$/, '')}/api/databases/bindings?projectId=${projectId}&entryId=${entryId}`, { headers: { Authorization: `Bearer ${request.connection.accessToken}` }, redirect: 'error', signal: AbortSignal.timeout(30_000) });
    const result = await response.json(); if (!response.ok || result.errCode !== 0) throw new Error('Database bindings are unavailable.');
    return { bindings: result.data };
  }
  if (request.input.action !== 'catalog') throw new Error('Manage database resources, models, table data and account access in Server Web.');
  const resources = [];
  for (const kind of ['databases', 'knowledge-bases']) {
    let page = 1;
    for (;;) {
      const response = await fetch(`${request.connection.serverUrl.replace(/\/$/, '')}/api/${kind}?page=${page}&pageSize=100`, {
        headers: { Authorization: `Bearer ${request.connection.accessToken}` }, redirect: 'error', signal: AbortSignal.timeout(30_000),
      });
      const result = await response.json();
      if (!response.ok || result.errCode !== 0) throw new Error(result.errMessage || 'Database catalog is unavailable.');
      resources.push(...result.data.items.map(resource => ({ ...resource, kind })));
      if (page * 100 >= result.data.total) break;
      if (++page > 100) throw new Error('Too many resources. Filter them in Server Web.');
    }
  }
  return { resources };
}
