export type ResourceKind = 'kv' | 'knowledge';
export type ResourceSource = 'local' | 'server';
export type ResourceScope = 'project' | 'conversation';

export interface ResourceRequest {
  kind: ResourceKind;
  database?: string;
  /** Data tabs reject alias migrations instead of applying an old draft to a new space. */
  expectedDatabaseId?: string;
  action: 'list' | 'get' | 'save' | 'delete';
  source?: ResourceSource;
  query?: string;
  cursor?: string;
  scope?: ResourceScope;
  conversationId?: string;
  key?: string;
  documentId?: string;
  title?: string;
  markdown?: string;
  value?: unknown;
  create?: boolean;
  projectId?: string;
}

export interface ResourceRow {
  id: string;
  title: string;
  preview: string;
  updatedAt?: string;
  valueType?: string;
  valueSizeBytes?: number;
  scope?: ResourceScope;
  conversationId?: string;
  key?: string;
  documentId?: string;
  lineNumber?: number;
}

export interface ResourcePage {
  items: ResourceRow[];
  total: number;
  hasMore: boolean;
  nextCursor?: string;
  source: ResourceSource;
  sources: ResourceSource[];
  search?: boolean;
}

export interface ResourceDetail {
  key?: string;
  scope?: ResourceScope;
  conversationId?: string;
  value?: unknown;
  id?: string;
  title?: string;
  markdown?: string;
  updatedAt?: string;
}
