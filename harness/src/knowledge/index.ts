export interface KnowledgeDocument {
  id: string;
  title: string;
  markdown: string;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeDocumentSummaryRecord {
  id: string;
  title: string;
  markdownPreview: string;
  createdAt: string;
  updatedAt: string;
}

export interface ListKnowledgeDocumentsInput {
  pageSize?: number;
  cursor?: string;
}

export interface KnowledgeDocumentPageRecord {
  items: KnowledgeDocumentSummaryRecord[];
  nextCursor?: string;
  hasMore: boolean;
  total: number;
}

export interface CreateKnowledgeDocumentInput {
  id?: string;
  title: string;
  markdown: string;
}

export interface EditKnowledgeDocumentInput {
  id: string;
  title?: string;
  markdown?: string;
}

export interface SearchKnowledgeDocumentsInput {
  query: string;
  documentId?: string;
  beforeLines?: number;
  afterLines?: number;
  maxMatches?: number;
  pageSize?: number;
  cursor?: string;
}

export interface ReadKnowledgeDocumentLinesInput {
  documentId: string;
  startLine: number;
  endLine: number;
}

export interface KnowledgeSearchMatch {
  documentId: string;
  title: string;
  lineNumber: number;
  line: string;
  before: Array<{ lineNumber: number; content: string }>;
  after: Array<{ lineNumber: number; content: string }>;
}

export interface KnowledgeSearchResultRecord {
  query: string;
  documentsSearched: number;
  totalMatches: number;
  matchesTruncated: boolean;
  maxMatches: number;
  pageSize: number;
  cursor?: string;
  nextCursor?: string;
  hasMore: boolean;
  matches: KnowledgeSearchMatch[];
}

export interface KnowledgeDocumentLinesResult {
  documentId: string;
  title: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  lines: Array<{ lineNumber: number; content: string }>;
}
