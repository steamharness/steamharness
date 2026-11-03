import { randomUUID } from 'node:crypto';

/** In-memory HTTP reference host for explicit UI tests, never a production backend. */
export function fixtureDatabaseHost() {
  const resources = new Map(), bindings = new Map(), projects = new Map();
  const identity = ({ projectId, entryId, alias }) => JSON.stringify([projectId, entryId, alias]);
  const fail = (code, status = 403) => { throw Object.assign(new Error(code), { code, status }); };
  const resolve = input => {
    const resource = bindings.get(identity(input));
    if (!resource || resource.revoked) fail('DATABASE_ACCESS_DENIED');
    if (input.schemaHash && resource.schemaHash !== input.schemaHash) fail('DATABASE_SCHEMA_MISMATCH', 409);
    return resource;
  };
  function create(projectId, entryId, alias = 'shared', options = {}) {
    const id = randomUUID(), binding = { id: randomUUID(), revision: 1, databaseId: id, projectId, entryId, alias, mode: 'write', accessRevision: 1 };
    const resource = { id, binding, schemaHash: options.schemaHash, rows: new Map(), documents: new Map(), files: new Map(), revision: 0 };
    const knowledge = {
      async createDocument(input) {
        const document = { ...input, id: input.id ?? randomUUID(), revision: 1, createdAt: Date.now(), updatedAt: Date.now() };
        resource.documents.set(document.id, document); resource.revision++; return document;
      },
      async getDocument(id) { return resource.documents.get(id); },
    };
    const database = { knowledge, rows: resource.rows,
      seed(tasks, configurationId = 'default') { for (const [index, task] of tasks.entries()) resource.rows.set(task.id, { values: { configurationId, createdAt: new Date(index).toISOString(), ...task }, rowVersion: '1' }); },
    };
    resources.set(id, resource); bindings.set(identity(binding), resource);
    return { requirement: { alias, databaseId: id }, binding, database };
  }
  return {
    create,
    registerProject(manifest) { projects.set(manifest.id, manifest); },
    revoke(id) { const resource = [...resources.values()].find(value => value.binding.id === id); if (resource) resource.revoked = true; },
    async handle(request, response) {
      const url = new URL(request.url, 'http://fixture'), parts = url.pathname.split('/').filter(Boolean);
      if (!['databases', 'knowledge-bases', 'projects'].includes(parts[1])) return false;
      const send = data => response.end(JSON.stringify({ errCode: 0, errMessage: '', data }));
      try {
        let call = {};
        if (request.method === 'POST') { const chunks = []; for await (const chunk of request) chunks.push(chunk); call = JSON.parse(Buffer.concat(chunks).toString()); }
        if (parts[1] === 'projects') {
          const project = projects.get(parts[2]); if (!project) fail('PROJECT_NOT_FOUND', 404);
          if (parts.length === 3) { send(project); return true; }
          const resource = resolve({ projectId: project.id, entryId: parts[4], alias: call.knowledgeBase });
          const content = call.documentId ? resource.documents.get(call.documentId) : { items: [...resource.documents.values()], total: resource.documents.size };
          send(content ?? null); return true;
        }
        if (parts[1] === 'databases') {
          if (parts[2] === 'bindings' && parts[3] === 'resolve') { send(resolve(call).binding); return true; }
          const resource = resolve(call.consumer);
          const consumer = call.consumer;
          if (resource.id !== parts[2] || consumer.binding.id !== resource.binding.id || consumer.binding.revision !== resource.binding.revision || consumer.accessRevision !== resource.binding.accessRevision) fail('DATABASE_BINDING_CHANGED', 409);
          const input = call.request;
          if (input.operation === 'rows') {
            const items = [...resource.rows.values()].filter(row => Object.entries(input.where ?? {}).every(([key, value]) => row.values[key] === value));
            const page = input.page ?? 1, pageSize = input.pageSize ?? 100;
            send({ items: items.slice((page - 1) * pageSize, page * pageSize), total: items.length, page, pageSize });
          } else if (input.operation === 'insert') {
            const values = { description: '', priority: 'normal', label: 'development', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...input.data };
            if (resource.rows.has(values.id)) fail('DATABASE_ROW_CONFLICT', 409);
            const row = { values, rowVersion: '1' }; resource.rows.set(values.id, row); send(row);
          } else {
            const previous = resource.rows.get(input.key.id);
            if (!previous || previous.rowVersion !== input.rowVersion) fail('DATABASE_ROW_CONFLICT', 409);
            if (input.operation === 'delete') { resource.rows.delete(input.key.id); send({ deleted: true }); }
            else if (input.operation === 'update') { const row = { values: { ...previous.values, ...input.data }, rowVersion: String(Number(previous.rowVersion) + 1) }; resource.rows.set(input.key.id, row); send(row); }
            else fail('DATABASE_INVALID_REQUEST', 400);
          }
        } else if (parts[2] === 'bindings') {
          const resource = resolve(call);
          send({ id: resource.binding.id, revision: 1, knowledgeBaseId: resource.id, mode: 'write', accessRevision: 1 });
        } else {
          const resource = resolve(call); if (parts[2] !== resource.id || call.binding.id !== resource.binding.id) fail('KNOWLEDGE_ACCESS_DENIED');
          if (call.operation === 'knowledge.getDocument') send(resource.documents.get(call.input.documentId) ?? null);
          else if (call.operation === 'knowledge.listDocuments') send({ items: [...resource.documents.values()], total: resource.documents.size, page: 1, pageSize: 100 });
          else if (call.operation === 'knowledge.revision') send({ revision: String(resource.revision) });
          else fail('KNOWLEDGE_INVALID_REQUEST', 400);
        }
      } catch (error) { response.statusCode = error.status ?? 400; response.end(JSON.stringify({ errCode: response.statusCode, errMessage: error.message, data: { code: error.code } })); }
      return true;
    },
  };
}
