/** Trusted Studio host operations. This module is never loaded by a project RPC. */
export async function runDatabaseHostRequest(request, core) {
  const input = request.input;
  const registry = new core.LocalDatabaseRegistry();
  const connection = request.connection && { serverUrl: request.connection.serverUrl, token: request.connection.accessToken };
  const remote = (endpoint, body) => {
    if (!connection) throw new Error('Sign in to the selected database host.');
    return core.databaseHostRequest(connection, endpoint, body);
  };
  if (input.action === 'catalog') {
    const result = { local: registry.read() };
    if (connection) {
      try { result.server = await remote(''); }
      catch (error) { result.serverError = error.message; }
    }
    return result;
  }
  if (!['local', 'server'].includes(input.host)) throw new Error('Select a database host.');
  if (input.action === 'resource') {
    const resource = input.input;
    if (!resource || !['kv', 'knowledge'].includes(resource.kind) || !['list', 'get', 'save', 'delete'].includes(resource.action)) throw new Error('Invalid resource operation.');
    const namespace = resource.scope === 'conversation' ? resource.conversationId : undefined;
    const local = input.host === 'local' && core.createLocalDatabaseManagementContext(input.spaceId, { registry, conversationNamespace: namespace });
    const call = (operation, args) => local ? core.executeDatabaseOperation(local, operation, args)
      : remote(`/${encodeURIComponent(input.spaceId)}/manage`, { operation, input: { ...args, ...(namespace ? { namespace: `conversation:${namespace}` } : {}) } });
    if (resource.kind === 'kv') {
      if (resource.action === 'list') {
        const page = await call('kv.listValues', { ...resource, pageSize: 30 });
        return { ...page, source: input.host, sources: [input.host], items: page.items.map(item => ({ ...item, id: JSON.stringify([item.scope, item.conversationId ?? '', item.key]), title: item.key, preview: JSON.stringify(item.value) })) };
      }
      if (typeof resource.key !== 'string' || !resource.key.trim()) throw new Error('A KV key is required.');
      if (resource.action === 'delete') return { removed: await call('kv.deleteValue', resource) };
      if (resource.action === 'save') await call('kv.setValue', resource);
      const entry = await call('kv.getEntry', resource);
      return !entry.exists ? null : { key: resource.key, value: entry.value, scope: resource.scope ?? 'project', conversationId: resource.conversationId };
    }
    if (resource.action === 'list') {
      if (resource.query?.trim()) {
        const page = await call('knowledge.searchDocuments', { query: resource.query, cursor: resource.cursor, pageSize: 30 });
        return { items: page.matches.map(match => ({ ...match, id: `${match.documentId}:${match.lineNumber}`, preview: match.line })), total: page.totalMatches, hasMore: page.hasMore, nextCursor: page.nextCursor, source: input.host, sources: [input.host], search: true };
      }
      const page = await call('knowledge.listDocuments', { cursor: resource.cursor, pageSize: 30 });
      return { ...page, source: input.host, sources: [input.host], items: page.items.map(item => ({ ...item, documentId: item.id, preview: item.markdownPreview })) };
    }
    if (resource.action === 'get') return call('knowledge.getDocument', resource);
    if (resource.action === 'delete') return { removed: await call('knowledge.deleteDocument', resource) };
    return call(resource.create ? 'knowledge.createDocument' : 'knowledge.editDocument', resource);
  }
  if (input.action === 'request') return input.host === 'local' ? registry.request(input.request) : remote('/requests', input.request);
  if (input.action === 'review') {
    if (typeof input.approve !== 'boolean') throw new Error('An explicit approval or rejection is required.');
    const decision = { approve: input.approve, permissions: input.permissions, reason: input.reason };
    return input.host === 'local' ? registry.review(input.requestId, decision) : remote(`/requests/${encodeURIComponent(input.requestId)}/review`, decision);
  }
  if (!['revoke', 'rotate', 'narrow'].includes(input.action)) throw new Error('Unknown database management action.');
  if (input.host === 'server') return remote(`/grants/${encodeURIComponent(input.grantId)}/${input.action}`, { permissions: input.permissions });
  return input.action === 'revoke' ? registry.revoke(input.grantId) : input.action === 'rotate' ? registry.rotate(input.grantId) : registry.narrow(input.grantId, input.permissions);
}
