import { randomUUID } from "node:crypto";
import { createKnowledgeBaseContext } from "../knowledge-bases/index";
import { createDatabaseConnector } from "../database/runtime";
import { createEntriesContext } from "../entries/index";
import type { KnowledgeDocument } from "../knowledge/index";

export function createTestResources(_unused?: unknown) {
  const projectId = randomUUID(), entryId = 'test', actor = { userId: 'test', isSystemAdmin: true };
  return { projectId, entryId, databases: createDatabaseConnector({ projectId, entryId }), knowledgeBases: createTestKnowledgeBases(projectId, entryId),
    entries: createEntriesContext({ projectId, name: 'test', defaultEntry: entryId, entries: [{ entryId, name: 'test', type: 'workflow', root: '.', entry: 'index.ts', databases: [] }] }, { actor, projectId, sourceEntryId: entryId }, { async list() { return []; }, async run() { throw new Error('No nested test entry.'); } }) };
}

/** Explicit document fixture for capability tests. Real SQL behavior is covered on Server. */
export function createTestKnowledgeBases(projectId: string, _entryId: string, aliases = ['data', 'other']) {
  const repositories = new Map<string, ReturnType<typeof createKnowledgeBaseContext>>();
  return { list: () => aliases.map(alias => ({ alias, knowledgeBaseId: projectId })), get(alias: string) {
    if (!aliases.includes(alias)) throw new Error('Knowledge alias is not declared.');
    if (!repositories.has(alias)) {
      const documents = new Map<string, KnowledgeDocument & { revision: number }>();
      repositories.set(alias, createKnowledgeBaseContext(async (operation, input: any) => {
        const get = () => documents.get(input.documentId);
        switch (operation) {
          case 'knowledge.revision': return String([...documents.values()].reduce((sum, item) => sum + item.revision, 0));
          case 'knowledge.listDocuments': { const items = [...documents.values()].map(({ markdown, ...item }) => ({ ...item, markdownPreview: markdown.slice(0, 160) })); return { items, hasMore: false, total: items.length } as any; }
          case 'knowledge.getDocument': return get() as any;
          case 'knowledge.createDocument': { const id = input.id ?? randomUUID(); if (documents.has(id)) throw new Error('Document already exists.'); const now = new Date().toISOString(), document = { id, title: input.title, markdown: input.markdown, revision: 1, createdAt: now, updatedAt: now }; documents.set(id, document); return document as any; }
          case 'knowledge.editDocument': { const previous = get(); if (!previous) throw new Error('Document does not exist.'); const document = { ...previous, ...(input.title === undefined ? {} : { title: input.title }), ...(input.markdown === undefined ? {} : { markdown: input.markdown }), revision: previous.revision + 1, updatedAt: new Date().toISOString() }; documents.set(previous.id, document); return document as any; }
          case 'knowledge.deleteDocument': return { id: input.documentId, deleted: documents.delete(input.documentId) } as any;
          case 'knowledge.searchDocuments': { const matches = [...documents.values()].filter(item => !input.documentId || item.id === input.documentId).flatMap(item => item.markdown.split('\n').flatMap((line, index, lines) => line.toLowerCase().includes(input.query.toLowerCase()) ? [{ documentId: item.id, title: item.title, lineNumber: index + 1, line, before: lines.slice(Math.max(0, index - (input.beforeLines ?? 2)), index), after: lines.slice(index + 1, index + 1 + (input.afterLines ?? 2)) }] : [])); return { query: input.query, matches, totalMatches: matches.length, hasMore: false } as any; }
          case 'knowledge.readDocumentLines': { const document = get(); if (!document) throw new Error('Document does not exist.'); const lines = document.markdown.split('\n'); return { documentId: document.id, title: document.title, startLine: input.startLine, endLine: Math.min(lines.length, input.endLine), totalLines: lines.length, lines: lines.slice(input.startLine - 1, input.endLine).map((line, index) => ({ lineNumber: input.startLine + index, content: line })) } as any; }
          default: throw new Error('Unsupported fixture operation.');
        }
      }));
    }
    return repositories.get(alias)!;
  } };
}
