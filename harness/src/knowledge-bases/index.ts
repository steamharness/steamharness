import { createResolvedProjectFile, type CreateFileInput, type FileReference, type ResolvedFile } from '../files/index';
import type { KnowledgeBaseRequirement } from '@steamharness/project-manifest';
import type { KnowledgeDocument, KnowledgeDocumentPageRecord, CreateKnowledgeDocumentInput, EditKnowledgeDocumentInput, ListKnowledgeDocumentsInput, SearchKnowledgeDocumentsInput, KnowledgeSearchResultRecord, ReadKnowledgeDocumentLinesInput, KnowledgeDocumentLinesResult } from '../knowledge/index';

export type { KnowledgeBaseRequirement } from '@steamharness/project-manifest';
export interface KnowledgeBaseResource { id: string; name: string; ownerUserId: string; revision: number; createdAt: string }
export interface KnowledgeBaseBinding { id: string; revision: number; knowledgeBaseId: string; mode: 'read' | 'write'; accessRevision: number }
export interface KnowledgeBaseIdentity { projectId: string; entryId: string; alias: string; knowledgeBaseId: string }
export interface KnowledgeBaseHost {
  resolve(identity: KnowledgeBaseIdentity): Promise<KnowledgeBaseBinding>;
  operation<T>(identity: KnowledgeBaseIdentity, binding: KnowledgeBaseBinding, operation: string, input: unknown): Promise<T>;
}
export class KnowledgeBaseError extends Error {
  constructor(readonly code: 'KNOWLEDGE_UNBOUND' | 'KNOWLEDGE_ACCESS_DENIED' | 'KNOWLEDGE_NOT_FOUND' | 'KNOWLEDGE_CONFLICT' | 'KNOWLEDGE_INVALID_REQUEST' | 'KNOWLEDGE_UNAVAILABLE', message: string) { super(message); this.name = 'KnowledgeBaseError'; }
}
export interface KnowledgeBaseContext {
  listDocuments(input?: ListKnowledgeDocumentsInput): Promise<KnowledgeDocumentPageRecord>;
  getDocument(id: string): Promise<(KnowledgeDocument & { revision: number }) | undefined>;
  createDocument(input: CreateKnowledgeDocumentInput): Promise<KnowledgeDocument & { revision: number }>;
  editDocument(input: EditKnowledgeDocumentInput & { expectedRevision?: number }): Promise<KnowledgeDocument & { revision: number }>;
  deleteDocument(id: string, expectedRevision?: number): Promise<{ id: string; deleted: boolean }>;
  searchDocuments(input: SearchKnowledgeDocumentsInput): Promise<KnowledgeSearchResultRecord>;
  readDocumentLines(input: ReadKnowledgeDocumentLinesInput): Promise<KnowledgeDocumentLinesResult>;
  getRevision(): Promise<string>;
  files: { createFile(input: CreateFileInput): Promise<FileReference>; readFile(id: string): Promise<ResolvedFile>; deleteFile(id: string): Promise<boolean> };
}
export interface KnowledgeBasesContext {
  list(): readonly KnowledgeBaseRequirement[];
  get(alias: string): KnowledgeBaseContext;
}

/** A repository facade, with no KV namespace, local database or fallback backend. */
export function createKnowledgeBaseContext(call: <T>(operation: string, input: unknown) => Promise<T>): KnowledgeBaseContext {
  return {
    listDocuments: (input = {}) => call('knowledge.listDocuments', input),
    getDocument: async id => await call<KnowledgeDocument & { revision: number } | null>('knowledge.getDocument', { documentId: id }) ?? undefined,
    createDocument: input => call('knowledge.createDocument', input),
    editDocument: input => call('knowledge.editDocument', { ...input, documentId: input.id }),
    deleteDocument: (documentId, expectedRevision) => call('knowledge.deleteDocument', { documentId, expectedRevision }),
    searchDocuments: input => call('knowledge.searchDocuments', input),
    readDocumentLines: input => call('knowledge.readDocumentLines', input),
    getRevision: async () => (await call<{ revision: string }>('knowledge.revision', {})).revision,
    files: {
      async createFile(input) {
        const bytes = typeof input.buffer === 'string' ? Buffer.from(input.buffer, 'base64') : Buffer.from(input.buffer instanceof ArrayBuffer ? new Uint8Array(input.buffer) : input.buffer);
        if (bytes.length > 50 * 1024 * 1024) throw new KnowledgeBaseError('KNOWLEDGE_INVALID_REQUEST', 'Knowledge attachments cannot exceed 50 MiB.');
        return call('files.createFile', { name: input.name, mimeType: input.mimeType, kind: input.kind, base64: bytes.toString('base64') });
      },
      async readFile(fileId) {
        const result = await call<{ file: FileReference; base64: string }>('files.readFile', { fileId });
        return createResolvedProjectFile(result.file, async () => {
          await call('files.stat', { fileId });
          return Buffer.from(result.base64, 'base64');
        });
      },
      deleteFile: async fileId => (await call<{ deleted: boolean }>('files.deleteFile', { fileId })).deleted,
    },
  };
}

export function createKnowledgeBasesContext(options: {
  projectId: string; entryId: string; requirements: readonly KnowledgeBaseRequirement[]; host?: KnowledgeBaseHost;
}): KnowledgeBasesContext {
  const requirements = structuredClone(options.requirements), clients = new Map<string, KnowledgeBaseContext>();
  return { list: () => structuredClone(requirements), get(alias) {
    const requirement = requirements.find(item => item.alias === alias);
    if (!requirement) throw new KnowledgeBaseError('KNOWLEDGE_UNBOUND', `Knowledge base alias "${alias}" is not declared for this entry.`);
    if (!clients.has(alias)) {
      let pinned: KnowledgeBaseBinding | undefined;
      const identity = { projectId: options.projectId, entryId: options.entryId, ...requirement };
      clients.set(alias, createKnowledgeBaseContext(async (operation, input) => {
        if (!options.host) throw new KnowledgeBaseError('KNOWLEDGE_UNAVAILABLE', 'Sign in to SteamHarness Server to access knowledge bases.');
        const binding = await options.host.resolve(identity);
        if (binding.knowledgeBaseId !== identity.knowledgeBaseId || pinned && (['id', 'revision', 'knowledgeBaseId', 'mode', 'accessRevision'] as const).some(key => binding[key] !== pinned![key])) throw new KnowledgeBaseError('KNOWLEDGE_ACCESS_DENIED', 'Knowledge base binding or access changed. Reopen this entry.');
        pinned ??= binding;
        return options.host.operation(identity, binding, operation, input);
      }));
    }
    return clients.get(alias)!;
  } };
}

export function createServerKnowledgeBaseHost(connection: { serverUrl: string; token: string | (() => string | Promise<string>); signal?: AbortSignal }): KnowledgeBaseHost {
  const url = new URL(connection.serverUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new KnowledgeBaseError('KNOWLEDGE_INVALID_REQUEST', 'Use a Server HTTP(S) URL.');
  const request = async <T>(endpoint: string, body: unknown): Promise<T> => {
    try {
      const token = typeof connection.token === 'function' ? await connection.token() : connection.token;
      if (!token) throw new KnowledgeBaseError('KNOWLEDGE_ACCESS_DENIED', 'Account login is required for knowledge bases.');
      const response = await fetch(`${connection.serverUrl.replace(/\/+$/, '')}/api/knowledge-bases${endpoint}`, { method: 'POST', redirect: 'error',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        signal: connection.signal ? AbortSignal.any([connection.signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000) });
      const result = await response.json() as { errCode: number; errMessage: string; data: T };
      if (!response.ok || result.errCode !== 0) throw new KnowledgeBaseError(response.status === 401 || response.status === 403 ? 'KNOWLEDGE_ACCESS_DENIED' : response.status === 404 ? 'KNOWLEDGE_NOT_FOUND' : response.status === 409 ? 'KNOWLEDGE_CONFLICT' : response.status === 400 ? 'KNOWLEDGE_INVALID_REQUEST' : 'KNOWLEDGE_UNAVAILABLE', result.errMessage || 'Knowledge operation failed.');
      return result.data;
    } catch (error) { if (error instanceof KnowledgeBaseError) throw error; throw new KnowledgeBaseError('KNOWLEDGE_UNAVAILABLE', 'Knowledge storage is unavailable. Check the Server connection.'); }
  };
  return {
    resolve: identity => request('/bindings/resolve', identity),
    operation: (identity, binding, operation, input) => request(`/${identity.knowledgeBaseId}/operations`, { ...identity, binding, operation, input }),
  };
}

/** The native data bridge uses the same repository facade as workflow code. */
export async function executeKnowledgeBaseOperation(base: KnowledgeBaseContext, operation: string, input: Record<string, any>): Promise<unknown> {
  switch (operation) {
    case 'knowledge.revision': return base.getRevision();
    case 'knowledge.listDocuments': return base.listDocuments(input);
    case 'knowledge.getDocument': return await base.getDocument(String(input.documentId)) ?? null;
    case 'knowledge.createDocument': return base.createDocument(input as any);
    case 'knowledge.editDocument': return base.editDocument({ ...input, id: String(input.documentId) });
    case 'knowledge.deleteDocument': return base.deleteDocument(String(input.documentId), input.expectedRevision);
    case 'knowledge.searchDocuments': return base.searchDocuments(input as any);
    case 'knowledge.readDocumentLines': return base.readDocumentLines(input as any);
    case 'files.createFile': return base.files.createFile({ name: input.name, mimeType: input.mimeType, kind: input.kind, buffer: String(input.base64) });
    case 'files.readFile': { const file = await base.files.readFile(String(input.fileId)); return { file: file.toJSON(), base64: await file.readBase64() }; }
    case 'files.deleteFile': return base.files.deleteFile(String(input.fileId));
    default: throw new KnowledgeBaseError('KNOWLEDGE_INVALID_REQUEST', 'Unsupported knowledge base operation.');
  }
}
